#!/usr/bin/env python3
# ws_imu.py - robust WS server with IMU fallback (mock) and heartbeat
import asyncio, json, time, argparse, os, signal, math
from contextlib import suppress

try:
    from smbus2 import SMBus
except Exception:
    SMBus = None

import websockets
from websockets.server import serve

CLIENTS = set()

# ---------------- IMU backend (MPU-60x0 @ 0x68) ----------------
class IMUBackend:
    # MPU6050 register map (subset)
    REG_PWR_MGMT_1   = 0x6B
    REG_SMPLRT_DIV   = 0x19
    REG_CONFIG       = 0x1A
    REG_GYRO_CONFIG  = 0x1B
    REG_ACCEL_CONFIG = 0x1C
    REG_ACCEL_XOUT_H = 0x3B
    REG_GYRO_XOUT_H  = 0x43
    REG_WHO_AM_I     = 0x75

    def __init__(self, bus=1, addr=0x68, enable=True):
        self.enable = enable and (SMBus is not None)
        self.busno  = bus
        self.addr   = addr
        self.bus    = None
        self.ok     = False

        # 간단 LPF/보정 상태
        self.lpf_alpha = 0.70     # 0.0(새값) ~ 1.0(이전값)  → 0.70이면 꽤 부드럽게
        self.roll_deg  = 0.0
        self.pitch_deg = 0.0

    def _read_word(self, reg_h):
        hi = self.bus.read_byte_data(self.addr, reg_h)
        lo = self.bus.read_byte_data(self.addr, reg_h + 1)
        val = (hi << 8) | lo
        if val & 0x8000:  # two's complement
            val -= 0x10000
        return val

    def init(self):
        if not self.enable:
            raise OSError(5, "I2C disabled or smbus2 not installed")

        self.bus = SMBus(self.busno)

        # 센서 깨우기 및 기본 설정 (실패해도 계속 시도)
        with suppress(Exception):
            who = self.bus.read_byte_data(self.addr, self.REG_WHO_AM_I)
            # print(f"[IMU] WHO_AM_I=0x{who:02X}")  # 필요하면 주석 해제

        # 클록: 내부, 슬립 해제
        with suppress(Exception):
            self.bus.write_byte_data(self.addr, self.REG_PWR_MGMT_1, 0x00)

        # DLPF 44Hz (CONFIG=3), 샘플레이트 50 Hz (SMPLRT_DIV=19 => 1kHz/(19+1)=50Hz)
        with suppress(Exception):
            self.bus.write_byte_data(self.addr, self.REG_CONFIG, 0x03)
            self.bus.write_byte_data(self.addr, self.REG_SMPLRT_DIV, 19)

        # 자이로 ±250 dps, 가속도 ±2g
        with suppress(Exception):
            self.bus.write_byte_data(self.addr, self.REG_GYRO_CONFIG, 0x00)
            self.bus.write_byte_data(self.addr, self.REG_ACCEL_CONFIG, 0x00)

        # 첫 샘플로 LPF 초기화
        ax, ay, az = self._read_accel_g()
        acc_roll, acc_pitch = self._acc_to_rp_deg(ax, ay, az)
        self.roll_deg  = acc_roll
        self.pitch_deg = acc_pitch

        self.ok = True

    def _read_accel_g(self):
        # ACCEL_* raw → g (±2g -> 16384 LSB/g)
        ax = self._read_word(self.REG_ACCEL_XOUT_H)
        ay = self._read_word(self.REG_ACCEL_XOUT_H + 2)
        az = self._read_word(self.REG_ACCEL_XOUT_H + 4)
        return ax / 16384.0, ay / 16384.0, az / 16384.0

    @staticmethod
    def _acc_to_rp_deg(ax, ay, az):
        # 일반적인 정의: roll = atan2(ay, az), pitch = atan2(-ax, sqrt(ay^2+az^2))
        roll  = math.degrees(math.atan2(ay, az))
        pitch = math.degrees(math.atan2(-ax, math.sqrt(ay*ay + az*az)))
        return roll, pitch

    def read_roll_pitch(self):
        """
        roll/pitch (도) 리턴. 가속도만 이용한 간단한 LPF (자이로 융합 없이도 UI 구동 충분).
        필요하면 자이로 융합을 추가해도 됨.
        """
        if not self.ok:
            raise OSError(5, "I2C not initialized")

        ax, ay, az = self._read_accel_g()
        acc_roll, acc_pitch = self._acc_to_rp_deg(ax, ay, az)

        # LPF 적용 (부드럽게)
        a = self.lpf_alpha
        self.roll_deg  = a * self.roll_deg  + (1 - a) * acc_roll
        self.pitch_deg = a * self.pitch_deg + (1 - a) * acc_pitch

        return self.roll_deg, self.pitch_deg

    def close(self):
        with suppress(Exception):
            if self.bus:
                self.bus.close()

# ---------------- Server ----------------
async def safe_send(ws, obj):
    try:
        await ws.send(json.dumps(obj))
    except Exception:
        with suppress(Exception):
            await ws.close()

async def handler(websocket):
    CLIENTS.add(websocket)
    print("[WS] client connected")
    try:
        async for raw in websocket:
            data = None
            if isinstance(raw, (bytes, bytearray)):
                with suppress(Exception):
                    raw = raw.decode("utf-8", "ignore")
            with suppress(Exception):
                data = json.loads(raw)

            if isinstance(data, dict):
                act = data.get("action")
                if act == "ping":
                    await safe_send(websocket, {"action":"pong","t":data.get("t", time.time())})
                elif act == "hello":
                    await safe_send(websocket, {"action":"hello_ack","server":"ws_imu.py"})
            # 그 외는 무시
    except websockets.ConnectionClosed as e:
        print(f"[WS] client disconnected: received {e.code} ({e.reason}); then sent {e.code} ({e.reason})")
    finally:
        CLIENTS.discard(websocket)

async def producer(loop_state):
    """
    주기적으로 IMU 데이터를 생성해 브로드캐스트.
    - IMU 실패 시 MOCK으로 전환해 연결 유지
    """
    hz = loop_state["hz"]
    dt = 1.0 / hz
    phase = 0.0

    while True:
        await asyncio.sleep(dt)

        # 기본값
        roll_deg, pitch_deg = 0.0, 0.0
        using_mock = False

        if loop_state["imu"] is not None:
            try:
                r, p = loop_state["imu"].read_roll_pitch()
                roll_deg, pitch_deg = float(r), float(p)
            except OSError as e:
                print(f"[WS] IMU read failed: {e} → switching to MOCK")
                loop_state["imu_ok"] = False
                using_mock = True
            except Exception as e:
                print(f"[WS] IMU unexpected error: {e} → switching to MOCK")
                loop_state["imu_ok"] = False
                using_mock = True
        else:
            using_mock = True

        if using_mock:
            phase += dt
            roll_deg  =  8.0 * math.sin(phase * 0.7)
            pitch_deg = -5.0 * math.cos(phase * 1.1)

        msg = {
            "action": "imu",
            "roll": round(roll_deg, 3),     # ★ 도(deg)로 보냄 (main.js가 deg→rad 변환)
            "pitch": round(pitch_deg, 3),
            "mock": using_mock,
            "ts": int(time.time() * 1000),
        }

        if CLIENTS:
            await asyncio.gather(*[safe_send(ws, msg) for ws in list(CLIENTS)], return_exceptions=True)

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--hz", type=int, default=20, help="send rate")
    ap.add_argument("--mock", action="store_true", help="force mock IMU")
    ap.add_argument("--i2c", type=int, default=1, help="I2C bus number")
    ap.add_argument("--addr", type=lambda x:int(x,0), default=0x68, help="I2C address (e.g., 0x68)")
    args = ap.parse_args()

    loop_state = {"hz": args.hz, "imu": None, "imu_ok": False}

    # IMU 초기화 (실패해도 서버는 뜸)
    if not args.mock:
        try:
            imu = IMUBackend(bus=args.i2c, addr=args.addr, enable=True)
            imu.init()
            loop_state["imu"] = imu
            loop_state["imu_ok"] = True
            print("[WS] IMU initialized (I2C bus=%d addr=0x%02X)" % (args.i2c, args.addr))
        except OSError as e:
            print(f"[WS] IMU init failed: {e}  → using MOCK")
        except Exception as e:
            print(f"[WS] IMU init unexpected error: {e}  → using MOCK")

    async with serve(handler, args.host, args.port, ping_interval=30, ping_timeout=30):
        print(f"[WS] server started on ws://{args.host}:{args.port}")
        try:
            await producer(loop_state)
        finally:
            if loop_state["imu"]:
                loop_state["imu"].close()

if __name__ == "__main__":
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda s,f: os._exit(0))
    asyncio.run(main())
