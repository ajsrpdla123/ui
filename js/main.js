// js/main.js
document.addEventListener('DOMContentLoaded', () => {
 // --- Part 0: 데이터 소스 스위치 -----------------------------------------
const USE_WS_IMU   = true;
const USE_CSV      = true;

// 현재 접속 중인 호스트 자동 감지 (다른 와이파이에서도 자동 적용)
const WS_HOST = location.hostname || 'localhost';
const WS_PORT = 8765;
const WS_URL  = `ws://${WS_HOST}:${WS_PORT}`;   // 자동 구성

const SIM_DT_MS = 200; // 시뮬레이션 주기(ms)

  // -----------------------------------------------------------------------

  // --- 공용 유틸 ----------------------------------------------------------
  const hasJQ = !!window.jQuery;
  const $jq   = hasJQ ? window.jQuery : null;
  const getEl = (sel) => {
    if (hasJQ) return $jq(sel);
    const el = document.querySelector(sel);
    return el ? { length: 1, _el: el, text: (t)=>{ el.textContent = t; } } : null;
  };
  const setTextSafe = (sel, txt) => {
    const el = getEl(sel);
    if (el && el.length) el.text(String(txt));
  };
  const callIf = (cond, fn) => { try { if (cond) fn(); } catch (e) {} };
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const toRad = (d) => d * (Math.PI / 180);

  // --- Part 1: 전역 상태 --------------------------------------------------
  let tractorPivot = null;                 // 회전을 적용할 피벗 노드
  let isBabylonInitialized = false;
  let simulationInterval = null;

  const stateCache = { gnss: null, vehicle: null, imu: null };
  const tractorData = { roll: 0, pitch: 0, deviation: 0, speed: 0 };

  // === 위치보정 선형계수 (map_data.js와 동일) ===
  const AFFINE = {
    TX:  932.464070,
    TY:  450.109842,
    A:     9.216207646,
    B:    -0.061612456,
    C:    -0.472955516,
    D:    -9.435695734,
  };

  // === [ADD] AFFINE 기반 월드(위경도)→픽셀 변환 등록 ======================
  let __REF = { lat: null, lon: null }; // 첫 GNSS를 기준 원점으로 사용

  function metersFromRef(lat, lon) {
    if (__REF.lat == null || __REF.lon == null) return { dE: 0, dN: 0 };
    const p = Math.PI / 180;
    const lat0r = __REF.lat * p;
    const dLat = (lat - __REF.lat) * p;
    const dLon = (lon - __REF.lon) * p;
    const dE = 6378137.0 * Math.cos(lat0r) * dLon; // 동쪽
    const dN = 6378137.0 * dLat;                   // 북쪽
    return { dE, dN };
  }

  function registerWorldToPixel() {
    if (!window.SafeZone) return;
    window.SafeZone.setWorldToPixel((lat, lon) => {
      const { dE, dN } = metersFromRef(lat, lon);
      const x = AFFINE.A * dE + AFFINE.B * dN + AFFINE.TX;
      const y = AFFINE.C * dE + AFFINE.D * dN + AFFINE.TY;
      return { x, y };
    });
  }
  // 초기 1회 (참조점 잡히기 전이라도 호출 안전)
  registerWorldToPixel();
  // =======================================================================

  // --- Part 1b: UI 업데이트 -----------------------------------------------
  function updateData() {
    // GNSS → 속도/주행모드
    if (stateCache.gnss) {
      const spd = Number(stateCache.gnss.speed) || 0;
      setTextSafe('#speed-value', spd.toFixed(1));
      tractorData.speed = spd;

      const modeEl = getEl('#drive-mode-badge');
      if (modeEl && modeEl.length) modeEl.text(Math.abs(spd) > 0.2 ? '주행' : '정지');
    }

    // VEHICLE → 경로 오차/RPM/연료
    if (stateCache.vehicle) {
      const dev = Number(stateCache.vehicle.deviation) || 0;
      setTextSafe('#deviation-value', dev.toFixed(1));
      setTextSafe('#rpm-value', stateCache.vehicle.engineSpeed ?? 0);
      setTextSafe('#fuel-gauge-value', stateCache.vehicle.fuelGauge ?? 0);
      tractorData.deviation = dev;
    }

    // IMU → 차량 오차, 롤/피치
    if (stateCache.imu) {
      const rollDeg  = Number(stateCache.imu.roll)  || 0;
      const pitchDeg = Number(stateCache.imu.pitch) || 0;

      tractorData.roll  = toRad(clampNum(rollDeg,  -90,  90));
      tractorData.pitch = toRad(clampNum(pitchDeg, -90,  90));

      const VEH_ERR_CM_PER_DEG = 2.0;
      const vehicleErrCm = Math.abs(rollDeg) * VEH_ERR_CM_PER_DEG;
      setTextSafe('#vehicle-error-big', vehicleErrCm.toFixed(1));
    }
  }
  window.updateData = updateData;
  const safeUpdate = () => { try { updateData(); } catch (e) { console.warn('[UI] updateData skipped:', e); } };

// --- Part 1c: RPM 기반 속도 추정기 (반응성↑ + 부호 자동보정) ---------------
const rpmSpeedEstimator = (() => {
  const DT = SIM_DT_MS / 1000;

  // ▶ 반응성 강화
  const A_MAX = 3.5;        // 가속도 캡 ↑
  const ALPHA = 0.45;       // EMA 완화 ↑

  // ▶ GNSS 거리 필터
  const JUMP_MAX_M = 12.0;
  const STATIONARY_DIST_M = 0.03; // 3 cm
  const SPEED_NOISE_KMH = 0.15;

  // ▶ RPM→속도 변환 파라미터
  const SPEED_SCALE = 1.08;
  const SPEED_BIAS_KMH = 0.20;

  // ▶ 온라인 K 보정
  const TRACK_MIN_FOR_CAL = 0.8;
  const RPM_MIN_FOR_CAL   = 800;
  const K_ALPHA           = 0.02;
  const K_INIT            = 0.0030;
  const K_MIN             = 0.0008;
  const K_MAX             = 0.02;
  const K_UPWARD_BIAS     = 1.00;

  // ▶ GNSS/RPM 블렌딩
  const GNSS_FALLBACK_W_NO_RPM = 1.00;
  const GNSS_BLEND_W_WITH_RPM  = 0.35;

  // ▶ 헤딩 보정/호환 설정 + 자동보정 상태
  const HEAD_CFG = {
    ZERO: 'N',          // 'N' = 0°가 북쪽, 'E' = 0°가 동쪽
    CLOCKWISE: true,    // true: 시계방향 증가, false: 반시계 증가
    OFFSET_DEG: 0,      // 추가 오프셋(자동보정으로 채움)
    AUTO: true
  };
  const CAL = {
    done: false,
    count: 0,
    sumSin: 0,
    sumCos: 0,
    minSamples: 10,     // 보정 최소 샘플 수
    maxSamples: 80,     // 보정 최대 샘플 수(초기 수렴)
  };

  const st = {
    vEma: 0,
    hasInit: false,
    prevLat: null,
    prevLon: null,
    lastSign: 1,
    K: K_INIT,
    moveStreak: 0,
    stillStreak: 0,
  };

  function haversine(lat1, lon1, lat2, lon2) {
    const p = Math.PI/180;
    const dphi = (lat2-lat1)*p, dl = (lon2-lon1)*p;
    const a = Math.sin(dphi/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dl/2)**2;
    return 2 * 6371000.0 * Math.asin(Math.sqrt(a));
  }
  function wrapDeg180(a) {
    let x = ((a + 180) % 360 + 360) % 360;
    return x - 180;
  }
  function headingUnit(headingDeg) {
    // 센서 헤딩에 오프셋/방향/제로축 적용
    let a = (headingDeg + HEAD_CFG.OFFSET_DEG) * Math.PI/180;
    if (!HEAD_CFG.CLOCKWISE) a = -a; // 반시계 증가면 부호 반전
    let e, n;
    if (HEAD_CFG.ZERO === 'N') {
      // 0°=North, CW 증가 → (e=sin, n=cos)
      e = Math.sin(a); n = Math.cos(a);
    } else {
      // 0°=East, CW 증가 → (e=cos, n=sin)
      e = Math.cos(a); n = Math.sin(a);
    }
    return { e, n };
  }

  function fuse(lat, lon, engineRpm, headingDeg) {
    let stepDist = null, trackKmh = null, dE = 0, dN = 0;

    // 1) GNSS 거리/벡터
    if (st.prevLat != null) {
      stepDist = haversine(st.prevLat, st.prevLon, lat, lon);
      if (stepDist <= JUMP_MAX_M) {
        trackKmh = (stepDist / DT) * 3.6;
        // EN 벡터(동/북) 계산
        const p = Math.PI/180;
        const lat0r = st.prevLat * p;
        const dLat  = (lat - st.prevLat) * p;
        const dLon  = (lon - st.prevLon) * p;
        dE = 6378137.0 * Math.cos(lat0r) * dLon;
        dN = 6378137.0 * dLat;
      }
    }

    // 2) 헤딩 자동보정(초기 구간만)
    if (HEAD_CFG.AUTO && !CAL.done && Number.isFinite(headingDeg) && trackKmh !== null && trackKmh >= 0.1) {
      // 이동 벡터의 방위각(0°=북, CW)
      const stepBearingDeg = (Math.atan2(dE, dN) * 180/Math.PI + 360) % 360;
      const diff = wrapDeg180(stepBearingDeg - headingDeg); // 센서→트랙의 차이

      // 원형 평균 누적
      const rad = diff * Math.PI/180;
      CAL.sumSin += Math.sin(rad);
      CAL.sumCos += Math.cos(rad);
      CAL.count++;

      if (CAL.count >= CAL.minSamples) {
        // 임시 오프셋 추정
        const off = Math.atan2(CAL.sumSin, CAL.sumCos) * 180/Math.PI; // [-180,180]
        HEAD_CFG.OFFSET_DEG = off;

        // 제로축 테스트: N/E 중 dot가 더 큰 쪽 선택
        // (한 프레임 비교로도 충분히 수렴)
        const tryZero = (zero) => {
          const bak = HEAD_CFG.ZERO; HEAD_CFG.ZERO = zero;
          const { e:hx, n:hy } = headingUnit(headingDeg);
          const dot = dE*hx + dN*hy;
          HEAD_CFG.ZERO = bak;
          return dot;
        };
        HEAD_CFG.ZERO = (tryZero('N') >= tryZero('E')) ? 'N' : 'E';

        // 방향(시계/반시계) 테스트
        const bakCW = HEAD_CFG.CLOCKWISE;
        HEAD_CFG.CLOCKWISE = true;
        let dotCW = 0; { const u = headingUnit(headingDeg); dotCW = dE*u.e + dN*u.n; }
        HEAD_CFG.CLOCKWISE = false;
        let dotCCW = 0; { const u = headingUnit(headingDeg); dotCCW = dE*u.e + dN*u.n; }
        HEAD_CFG.CLOCKWISE = (dotCW >= dotCCW);

        // 수렴 판정(최대 샘플 또는 충분 수렴)
        if (CAL.count >= CAL.maxSamples) CAL.done = true;
        // dot가 계속 크게 양수로 나오기 시작하면 그 시점 이후 자동 종료해도 됨
        if (Math.abs(dE)+Math.abs(dN) > 0.2) {
          const u = headingUnit(headingDeg);
          const dotNow = dE*u.e + dN*u.n;
          if (dotNow > 0.5) CAL.done = true;
        }
      }
    }

    // 3) 진행방향 부호(후진/전진) 추정: 보정된 헤딩 유닛벡터와 내적
    let sign = st.lastSign;
    if (st.prevLat != null && Number.isFinite(headingDeg) && stepDist !== null) {
      const { e: hx, n: hy } = headingUnit(headingDeg);
      const dot = dE*hx + dN*hy;
      if (Math.hypot(dE, dN) > 1e-3) sign = (dot >= 0) ? 1 : -1;
    }
    st.lastSign = sign;

    // 4) 온라인 K 보정
    if (Number.isFinite(engineRpm) && engineRpm >= RPM_MIN_FOR_CAL &&
        trackKmh !== null && trackKmh >= TRACK_MIN_FOR_CAL) {
      let K_est = trackKmh / engineRpm;
      if (Number.isFinite(K_est)) {
        K_est *= K_UPWARD_BIAS;
        st.K = Math.min(K_MAX, Math.max(K_MIN, (1 - K_ALPHA) * st.K + K_ALPHA * K_est));
      }
    }

    // 5) RPM 기반 속도
    const rpm = Math.max(0, Number(engineRpm) || 0);
    let vRpm = rpm * st.K;
    vRpm = vRpm * SPEED_SCALE + SPEED_BIAS_KMH;

    // 6) 정지 판정 개선
    let isStationary = false;
    if (trackKmh !== null) {
      isStationary = trackKmh < SPEED_NOISE_KMH && (stepDist !== null ? stepDist < STATIONARY_DIST_M : true);
    } else {
      isStationary = vRpm < SPEED_NOISE_KMH;
    }
    if (!isStationary) { st.moveStreak++; st.stillStreak = 0; }
    else               { st.stillStreak++; st.moveStreak = 0; }

    // 7) 하이브리드 합성
    let vAbs;
    if (!engineRpm || engineRpm <= 0) {
      vAbs = (trackKmh !== null) ? trackKmh : 0; // RPM 없으면 GNSS 100%
    } else if (trackKmh !== null) {
      vAbs = (1 - GNSS_BLEND_W_WITH_RPM) * vRpm + GNSS_BLEND_W_WITH_RPM * trackKmh;
    } else {
      vAbs = vRpm;
    }

    // 8) 연속 정지 시에만 0 클램프
    if (isStationary && st.stillStreak >= 2) vAbs = 0;

    // 9) 가속도 캡 & EMA
    let vRaw = sign * vAbs;
    if (st.hasInit) {
      const dvMax = A_MAX * 3.6 * DT;
      const dv = vRaw - st.vEma;
      if (dv >  dvMax) vRaw = st.vEma + dvMax;
      if (dv < -dvMax) vRaw = st.vEma - dvMax;
    }
    const vEma = st.hasInit ? (ALPHA * vRaw + (1 - ALPHA) * st.vEma) : vRaw;

    // 상태 갱신
    st.vEma = vEma;
    st.prevLat = lat; st.prevLon = lon; st.hasInit = true;

    return vEma;
  }

  return { fuse };
})();



  // --- Part 1d: 작업면적 누적기 -------------------------------------------
  const workArea = (() => {
    const st = {
      lastLat: null, lastLon: null,
      m2: 0, width_m: null, lastUpdateTs: 0,
    };

    function haversine(lat1, lon1, lat2, lon2) {
      const p = Math.PI / 180;
      const dphi = (lat2 - lat1) * p;
      const dl   = (lon2 - lon1) * p;
      const a = Math.sin(dphi/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dl/2)**2;
      return 2 * 6371000.0 * Math.asin(Math.sqrt(a));
    }

    function readWidthFromUI() {
      if (st.width_m && st.width_m > 0) return st.width_m;
      const el = document.querySelector('#left-popup .popup-section:nth-child(4) .info-bar:nth-child(3) span:last-child');
      const txt = el ? (el.textContent || '') : '';
      const m = txt.match(/([\d.]+)\s*m/i);
      st.width_m = m ? parseFloat(m[1]) : 2.4; // 기본 2.4m
      if (!Number.isFinite(st.width_m) || st.width_m <= 0) st.width_m = 2.4;
      return st.width_m;
    }

    function render() {
      const box = document.querySelector('#bottom-info-popup .info-box:nth-child(1) .value');
      if (!box) return;
      const ha = st.m2 / 10000; // 1ha = 10,000m²
      box.innerHTML = `${ha.toFixed(3)} <span>ha</span>`;
    }

    function onGnss(lat, lon, speedKmh) {
      const ts = Date.now();
      if (ts - st.lastUpdateTs < 80) return; // 80ms 디바운스
      st.lastUpdateTs = ts;

      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const width = readWidthFromUI();

      if (st.lastLat != null) {
        const d = haversine(st.lastLat, st.lastLon, lat, lon); // m
        if (d > 0.05 && d < 30) {
          const v = Number(speedKmh) || 0;
          if (Math.abs(v) >= 0.2) {
            st.m2 += d * width;
            render();
          }
        }
      }
      st.lastLat = lat; st.lastLon = lon;
    }

    function reset() { st.lastLat = st.lastLon = null; st.m2 = 0; render(); }
    function setWidth(m) { const v = Number(m); if (Number.isFinite(v) && v > 0) { st.width_m = v; render(); } }

    return { onGnss, reset, setWidth, _state: st };
  })();

  // --- Part 2: CSV 자동 로더 ---------------------------------------------
  if (USE_CSV) {
    if (!window.Papa || !window.Papa.parse) {
      console.warn('[CSV] Papa.parse가 없습니다. CSV 재생을 건너뜁니다.');
    } else {
      const csvFilePath = 'MockDataSample.csv';
      console.log(`'${csvFilePath}' 파일 로드를 시작합니다...`);
      window.Papa.parse(csvFilePath, {
        download: true,
        header: true,
        dynamicTyping: true,
        complete: (results) => {
          const csvData = (results?.data || []).filter(row => {
            if (!row) return false;
            const hasNmea = !!row['NMEA-0183'];
            const hasRpm  = row['EngineSpeed(rpm)'] != null || row['Engine_RPM'] != null || row['RPM'] != null || row['engine_rpm'] != null;
            const hasVeh  = row['Deviation(cm)'] != null || row['FuelGauge(%)'] != null;
            return hasNmea || hasRpm || hasVeh;
          });
          console.log('✅ CSV 파일 자동 로딩 및 파싱 완료. 총', csvData.length, '개 행');
          startSimulation(csvData);
        },
        error: (error) => {
          console.error(`CSV 파일(${csvFilePath}) 로드 오류:`, error);
          alert(`'${csvFilePath}' 파일을 불러올 수 없습니다. 파일 위치/이름을 확인하세요.`);
        }
      });
    }
  }

  function startSimulation(data) {
    if (!Array.isArray(data) || data.length === 0) {
      console.warn('[CSV] 데이터가 비었습니다.');
      return;
    }
    if (simulationInterval) clearInterval(simulationInterval);

    let currentIndex = 0;
    console.log('🚀 시뮬레이션을 시작합니다. (반복 재생)');

    simulationInterval = setInterval(() => {
      const row = data[currentIndex];
      try { processDataRow(row); }
      catch (e) { console.error('[CSV] processDataRow error:', e); }
      currentIndex = (currentIndex + 1) % data.length;
    }, SIM_DT_MS);
  }

  function nmeaToDecimal(nmeaCoord) {
    const val = Number(nmeaCoord);
    if (!Number.isFinite(val)) return NaN;
    const degrees = Math.floor(val / 100);
    const minutes = val - degrees * 100;
    return degrees + minutes / 60;
  }

  // --- 핵심: NMEA 파싱 + 엔진RPM 기반 속도 적용 ---------------------------
  function processDataRow(row = {}) {
    const nmeaString = row['NMEA-0183'] || '';
    let lat = 0, lon = 0, headingDeg = NaN;

    if (stateCache.gnss) {
      lat = stateCache.gnss.lat;
      lon = stateCache.gnss.lon;
      headingDeg = stateCache.gnss.angle;
    }

    const gga = nmeaString.match(/\$..GGA,[^,]*,([\d.]+),([NS]),([\d.]+),([EW])/);
    const rmc = nmeaString.match(/\$..RMC,[^,]*,[AV],([\d.]+),([NS]),([\d.]+),([EW])/);
    if (gga) {
      let _lat = nmeaToDecimal(parseFloat(gga[1]));
      let _lon = nmeaToDecimal(parseFloat(gga[3]));
      if (gga[2] === 'S') _lat = -_lat;
      if (gga[4] === 'W') _lon = -_lon;
      if (Number.isFinite(_lat) && Number.isFinite(_lon)) { lat = _lat; lon = _lon; }
    } else if (rmc) {
      let _lat = nmeaToDecimal(parseFloat(rmc[1]));
      let _lon = nmeaToDecimal(parseFloat(rmc[3]));
      if (rmc[2] === 'S') _lat = -_lat;
      if (rmc[4] === 'W') _lon = -_lon;
      if (Number.isFinite(_lat) && Number.isFinite(_lon)) { lat = _lat; lon = _lon; }
    }

    const gnssMatch = nmeaString.match(/;GNSS,(.+?)\*/);
    if (gnssMatch && gnssMatch[1]) {
      const gnssParts = gnssMatch[1].split(',');
      const heading = parseFloat(gnssParts[18] || 'NaN');
      if (Number.isFinite(heading)) headingDeg = heading;
    }

    const engineRpm = parseFloat(
      row['EngineSpeed(rpm)'] ?? row['Engine_RPM'] ?? row['RPM'] ?? row['engine_rpm'] ?? NaN
    );

    const fusedSpeedKmh = rpmSpeedEstimator.fuse(lat, lon, engineRpm, headingDeg);

    const gnssData    = { action: 'gnss', speed: fusedSpeedKmh, vehicleError: 0, lat, lon, angle: headingDeg };
    // 면적 누적
    workArea.onGnss(lat, lon, fusedSpeedKmh);

    const vehicleData = {
      action: 'vehicle',
      deviation: row['Deviation(cm)'],
      engineSpeed: row['EngineSpeed(rpm)'] ?? row['Engine_RPM'] ?? row['RPM'] ?? row['engine_rpm'],
      fuelGauge: row['FuelGauge(%)']
    };

    stateCache.gnss    = gnssData;
    stateCache.vehicle = vehicleData;

    // 첫 GNSS 기준점 세팅 + 변환 재등록
    if (__REF.lat == null && Number.isFinite(gnssData.lat) && Number.isFinite(gnssData.lon)) {
      __REF.lat = gnssData.lat; __REF.lon = gnssData.lon;
      registerWorldToPixel();
    }

    safeUpdate();

    // 지오펜스 체크 (CSV 경로)
    try { window.SafeZone?.checkLatLng(gnssData.lat, gnssData.lon, Date.now()); } catch {}

    if (window.hazardLogger && stateCache.imu) {
      callIf(true, () => window.hazardLogger.checkIMU(stateCache.imu));
    }

    try { window.postMessage(JSON.stringify(gnssData), '*'); } catch {}
  }

  // --- Part 2b: 실시간 IMU/WebSocket 수신 --------------------------------
  if (USE_WS_IMU && 'WebSocket' in window) {
    let ws = null;
    let wsRetry = 0;
    let wsTimer = null;

    const connectWS = () => {
      try {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => { console.log('[IMU] WebSocket connected:', WS_URL); wsRetry = 0; };
        ws.onclose = () => {
          console.warn('[IMU] WebSocket closed');
          const delay = Math.min(10000, 500 * Math.pow(2, wsRetry++));
          clearTimeout(wsTimer);
          wsTimer = setTimeout(connectWS, delay);
        };
        ws.onerror = (e) => console.error('[IMU] WebSocket error:', e);
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); }
          catch (err) { console.error('[IMU] JSON parse error:', err); return; }

          try {
            if (msg.action === 'imu') {
              stateCache.imu = { roll: Number(msg.roll) || 0, pitch: Number(msg.pitch) || 0 };
              safeUpdate();
              callIf(!!window.hazardLogger, () => window.hazardLogger.checkIMU(stateCache.imu));

            } else if (msg.action === 'gnss') {
              // GNSS 수신
              stateCache.gnss = { ...msg };
              // 작업면적 누적
              if (Number.isFinite(stateCache.gnss?.lat) && Number.isFinite(stateCache.gnss?.lon)) {
                workArea.onGnss(stateCache.gnss.lat, stateCache.gnss.lon, stateCache.gnss.speed);
              }
              // 첫 기준점 등록
              if (__REF.lat == null && Number.isFinite(stateCache.gnss.lat) && Number.isFinite(stateCache.gnss.lon)) {
                __REF.lat = stateCache.gnss.lat; __REF.lon = stateCache.gnss.lon;
                registerWorldToPixel();
              }
              safeUpdate();
              // 지오펜스 체크
              try { window.SafeZone?.checkLatLng(stateCache.gnss.lat, stateCache.gnss.lon, Date.now()); } catch {}

            } else if (msg.action === 'vehicle') {
              stateCache.vehicle = { ...msg };
              safeUpdate();
            }
          } catch (err) {
            console.error('[IMU] handler error:', err);
          }
        };
      } catch (e) {
        console.error('[IMU] WebSocket init failed:', e);
      }
    };
    connectWS();
  }

  // --- Part 3: Babylon.js 3D 씬 ------------------------------------------
  const renderCanvas = document.getElementById('renderCanvas');
  let engine;
  if (renderCanvas && window.BABYLON) {
    engine = new BABYLON.Engine(renderCanvas, true);
  } else if (!window.BABYLON) {
    console.warn('[3D] BABYLON이 없습니다. 3D 렌더를 건너뜁니다.');
  }

  const createScene = () => {
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0);

    const camera = new BABYLON.ArcRotateCamera("camera", -Math.PI * 2, Math.PI / 2.5, 6, new BABYLON.Vector3(0, 0, 0), scene);
    camera.setPosition(new BABYLON.Vector3(-17, 17, 0));
    camera.target = new BABYLON.Vector3(0, 0, 0);

    const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.9;

    BABYLON.SceneLoader.ImportMeshAsync("", "./assets/", "tractor.glb", scene)
      .then((result) => {
        result.meshes.forEach(m => { if (m.rotationQuaternion) m.rotationQuaternion = null; });

        const root = result.meshes[0]; // __root__
        tractorPivot = new BABYLON.TransformNode("tractorPivot", scene);
        tractorPivot.rotationQuaternion = null; // Euler
        root.parent = tractorPivot;

        root.scaling = new BABYLON.Vector3(2.5, 2.5, 2.5);
        root.position.y = -1;

        const ground = BABYLON.MeshBuilder.CreatePlane("ground", { width: 3, height: 160 }, scene);
        ground.rotation.x = Math.PI / 2;
        ground.rotation.y = Math.PI / 2;
        ground.position.y = -1.01;
        const groundMat = new BABYLON.StandardMaterial("groundMat", scene);
        groundMat.diffuseColor  = new BABYLON.Color3(0.3, 0.1, 0.003);
        groundMat.emissiveColor = new BABYLON.Color3(0.25, 0.9, 0.35);
        groundMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        groundMat.roughness     = 0.5;
        ground.material = groundMat;

        const arrows = [];
        const arrowCount = 12;
        const arrowSpacing = 10;

        for (let i = -4; i < arrowCount - 4; i++) {
          const arrow = BABYLON.MeshBuilder.CreateDisc(`arrow${i}`, {
            radius: 1.2,
            tessellation: 3,
            sideOrientation: BABYLON.Mesh.DOUBLESIDE
          }, scene);
          const arrowMat = new BABYLON.StandardMaterial(`arrowMat${i}`, scene);
          arrowMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
          arrow.material = arrowMat;

          arrow.rotation.x = Math.PI / 2;
          arrow.rotation.y = 0;
          arrow.position.y = -0.9;
          arrow.position.x = i * arrowSpacing;
          arrow.scaling.y = 1.5;
          arrows.push(arrow);
        }

        if (!isBabylonInitialized) {
          isBabylonInitialized = true;
          engine.runRenderLoop(() => {
            if (tractorPivot) {
              tractorPivot.rotation.x = tractorData.roll;
              tractorPivot.rotation.y = Math.PI;
              tractorPivot.rotation.z = -tractorData.pitch;
              tractorPivot.position.z = tractorData.deviation / -10;
            }

            const dynamicSpeed = stateCache?.gnss?.speed ? (stateCache.gnss.speed / 50) : 0;
            arrows.forEach(arrow => {
              arrow.position.x -= dynamicSpeed;
              if (arrow.position.x < -arrowCount * arrowSpacing / 2) {
                arrow.position.x += arrowCount * arrowSpacing;
              }
            });
            scene.render();
          });
        }
      })
      .catch((error) => console.error("3D 모델 로딩 실패:", error));
  };

  if (engine) {
    createScene();
    window.addEventListener("resize", () => engine.resize());
  }

  // --- Part 4: UI 상호작용 ------------------------------------------------
  const monitorButton = document.querySelector('.monitor-btn');
  if (monitorButton) {
    monitorButton.addEventListener('click', () => {
      callIf(hasJQ, () => {
        $jq('#left-popup, #right-popup, #location-popup, #bottom-info-popup, #map-modal').toggleClass('visible');
      });
    });
  }

  // === Camera modal ===
  (function bindCameraHandlers(){
    const modal   = document.getElementById('videoModal');
    const titleEl = document.getElementById('videoTitle');
    const player  = document.getElementById('videoPlayer');
    const closeBtn= document.getElementById('closeVideoBtn');
    if (!modal || !titleEl || !player) {
      console.warn('[VIDEO] modal elements not found');
      return;
    }

    modal.style.zIndex = '5000';

    const openModal = () => {
      modal.classList.add('visible');
      modal.style.display = 'flex';
    };
    const closeModal = () => {
      modal.classList.remove('visible');
      modal.style.display = 'none';
      try { player.pause(); } catch {}
      player.removeAttribute('src');
      player.load();
    };
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    try { if (window.jQuery) window.jQuery('.camera-btn').off('click'); } catch {}

    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.camera-btn');
      if (!btn) return;

      const videoSrc   = btn.getAttribute('data-video-src');
      const videoLabel = (btn.querySelector('span')?.textContent || '').trim();
      if (!videoSrc) return;

      try {
        player.src = videoSrc;
        player.muted = true;
        player.autoplay = true;

        openModal();
        player.load();
        const p = player.play();
        if (p && typeof p.catch === 'function') {
          p.catch(async () => { try { await player.play(); } catch(_) {} });
        }
        titleEl.textContent = videoLabel || 'Live';
      } catch (err) {
        console.error('[VIDEO] failed to start:', err);
      }
    });

    document.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape') closeModal(); });

    window.__videoModalOpen = openModal;
    window.__videoModalClose = closeModal;
  })();
// === User Profile Modal ===
(function userProfileModal(){
  const btn    = document.querySelector('.user-detail-btn'); // 좌측 '사용자 정보' 버튼
  const modal  = document.getElementById('user-modal');
  const close  = document.getElementById('close-user-modal');

  // 표시 타겟
  const $ = (id)=> document.getElementById(id);
  const el = {
    avatar:  $('up-avatar'),
    id:      $('up-id'),
    name:    $('up-name'),
    age:     $('up-age'),
    gender:  $('up-gender'),
    email:   $('up-email'),
    phone:   $('up-phone'),
    role:    $('up-role'),
    location:$('up-location'),
    last:    $('up-last'),
    notes:   $('up-notes'),
  };

  // 기본 프로필(좌측 패널에 있는 값으로 초기화)
  const domName = document.querySelector('#left-popup .user-text .user-name')?.textContent?.trim() || '사용자';
  const domId   = document.querySelector('#left-popup .user-text .user-id')?.textContent?.trim() || 'unknown';
  const domAvatar = document.querySelector('#left-popup .profile-pic')?.getAttribute('src') || './assets/user.png';

  let profile = {
    id: domId,
    name: domName,
    age: null,
    gender: null,
    email: null,
    phone: null,
    role: null,
    location: null,
    last: null,
    notes: null,
    avatar: domAvatar,
  };

  function render(){
    if (el.avatar && profile.avatar) el.avatar.src = profile.avatar;
    el.id.textContent      = profile.id ?? '-';
    el.name.textContent    = profile.name ?? '-';
    el.age.textContent     = (profile.age ?? '-') + (profile.age ? ' 세' : '');
    el.gender.textContent  = profile.gender ?? '-';
    el.email.textContent   = profile.email ?? '-';
    el.phone.textContent   = profile.phone ?? '-';
    el.role.textContent    = profile.role ?? '-';
    el.location.textContent= profile.location ?? '-';
    el.last.textContent    = profile.last ?? '-';
    el.notes.textContent   = profile.notes ?? '-';
  }
  render();

  function open(){ if (!modal) return; modal.classList.remove('hidden'); modal.style.display='flex'; }
  function closeModal(){ if (!modal) return; modal.classList.add('hidden'); modal.style.display='none'; }

  btn?.addEventListener('click', open);
  close?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (e)=>{ if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeModal(); });

  // 외부에서 값 주입할 수 있는 API (백엔드/WS에서 갱신 가능)
  window.setUserProfile = function(next){
    if (!next || typeof next !== 'object') return;
    profile = { ...profile, ...next };
    render();
  };
    // === 편집 폼 ===
  const editToggleBtn = document.getElementById('user-edit-toggle');
  const editForm      = document.getElementById('user-edit-form');
  const cancelBtn     = document.getElementById('user-edit-cancel');
  const saveBtn       = document.getElementById('user-edit-save');

  const f = {
    name:     document.getElementById('ue-name'),
    id:       document.getElementById('ue-id'),
    age:      document.getElementById('ue-age'),
    gender:   document.getElementById('ue-gender'),
    email:    document.getElementById('ue-email'),
    phone:    document.getElementById('ue-phone'),
    role:     document.getElementById('ue-role'),
    location: document.getElementById('ue-location'),
    last:     document.getElementById('ue-last'),
    notes:    document.getElementById('ue-notes'),
    avatar:   document.getElementById('ue-avatar'),
  };

  function fillFormFromProfile() {
    f.name.value     = profile.name || '';
    f.id.value       = profile.id || '';
    f.age.value      = (profile.age ?? '');
    f.gender.value   = profile.gender || '';
    f.email.value    = profile.email || '';
    f.phone.value    = profile.phone || '';
    f.role.value     = profile.role || '';
    f.location.value = profile.location || '';
    f.last.value     = profile.last || '';
    f.notes.value    = profile.notes || '';
    f.avatar.value   = profile.avatar || '';
  }

  function closeEdit() {
    editForm.style.display = 'none';
    editToggleBtn.textContent = '편집';
  }
  function openEdit() {
    fillFormFromProfile();
    editForm.style.display = 'block';
    editToggleBtn.textContent = '닫기';
  }

  editToggleBtn?.addEventListener('click', () => {
    if (!editForm) return;
    const opened = editForm.style.display !== 'none';
    if (opened) closeEdit(); else openEdit();
  });

  cancelBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    closeEdit();
  });

  editForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    // 폼 → profile
    const next = {
      name:     f.name.value.trim() || null,
      id:       f.id.value.trim()   || null,
      age:      f.age.value ? Number(f.age.value) : null,
      gender:   f.gender.value.trim()   || null,
      email:    f.email.value.trim()    || null,
      phone:    f.phone.value.trim()    || null,
      role:     f.role.value.trim()     || null,
      location: f.location.value.trim() || null,
      last:     f.last.value.trim()     || null,
      notes:    f.notes.value.trim()    || null,
      avatar:   f.avatar.value.trim()   || null,
    };
    window.setUserProfile(next);           // 렌더 + 상태 병합
    try { localStorage.setItem('user.profile', JSON.stringify(next)); } catch {}
    // 좌측 패널 텍스트도 갱신(보이는 곳)
    const leftName = document.querySelector('#left-popup .user-text .user-name');
    const leftId   = document.querySelector('#left-popup .user-text .user-id');
    if (leftName && next.name) leftName.textContent = next.name;
    if (leftId && next.id)     leftId.textContent   = next.id;

    closeEdit();
  });

  // 시작 시 localStorage에 저장된 사용자 정보 적용
  try {
    const saved = localStorage.getItem('user.profile');
    if (saved) {
      const parsed = JSON.parse(saved);
      window.setUserProfile(parsed);
    }
  } catch {}

})();

  // --- 개발용: 지오펜스 출입 로그 + 실제 팝업 호출 ------------------------
  window.addEventListener('geofence:exit',  e => {
    console.log('%c[GEOFENCE] EXIT',  'color:#e74c3c', e.detail);
    if (window.showGeofenceAlert) window.showGeofenceAlert('안전구역을 벗어났습니다.', 'exit');
  });
  window.addEventListener('geofence:enter', e => {
    console.log('%c[GEOFENCE] ENTER', 'color:#2ecc71', e.detail);
    if (window.showGeofenceAlert) window.showGeofenceAlert('안전구역에 진입했습니다.', 'enter');
  });
  // -----------------------------------------------------------------------

  // (선택) 외부 제어용 API
  window.setImplementWidth = (m) => workArea.setWidth(m);
  window.resetWorkArea     = () => workArea.reset();

  // === [핵심 복구] 좌측 섹션 접기/펼치기 ==================================
  // === [복구/업그레이드] 좌측 섹션 접기/펼치기 (부드러운 슬라이드 + 아이콘 회전) ===
(function setupLeftCollapsibles() {
  const left = document.getElementById('left-popup');
  if (!left || left.dataset.collapsibleInit === '1') return; // 중복 초기화 방지
  left.dataset.collapsibleInit = '1';

  // 🔧 초기 접힘 섹션 (요청: 실시간 영상만 닫고, 트랙터/작업기는 보이게)
  const defaultCollapsed = new Set(['실시간 영상']); 
  // 필요시: defaultCollapsed.add('트랙터 정보'); 등으로 조절

  // max-height 슬라이드 함수
  const setExpanded = (section, expanded) => {
    const content = section.querySelector('.section-content');
    if (!content) return;

    // 초기에 정확한 높이 계산을 위해 한 번 auto로 펼쳐서 scrollHeight 취득
    const targetHeight = content.scrollHeight;

    if (expanded) {
      section.classList.remove('collapsed');
      // 현재 높이를 0으로 설정 후 다음 프레임에 targetHeight로 애니메이션
      content.style.maxHeight = content.style.maxHeight || '0px';
      requestAnimationFrame(() => {
        content.style.maxHeight = targetHeight + 'px';
      });
    } else {
      section.classList.add('collapsed');
      // 현재 높이를 계산해서 0으로 애니메이션
      content.style.maxHeight = targetHeight + 'px';
      requestAnimationFrame(() => {
        content.style.maxHeight = '0px';
      });
    }
  };

  // 토글 함수
  const toggleSection = (section) => {
    const content = section.querySelector('.section-content');
    if (!content) return;
    const isCollapsed = section.classList.contains('collapsed');
    setExpanded(section, isCollapsed);
  };

  // 초기 상태 설정 + 이벤트 바인딩
  left.querySelectorAll('.popup-section').forEach((section) => {
    const header  = section.querySelector('.section-header');
    const content = section.querySelector('.section-content');
    if (!header || !content) return;

    const title = (section.querySelector('.section-title')?.textContent || '').trim();

    // 초기 상태: 실시간 영상만 닫음, 트랙터 정보/작업기 정보는 펼침
    if (defaultCollapsed.has(title)) {
      section.classList.add('collapsed');
      content.style.maxHeight = '0px';
    } else {
      section.classList.remove('collapsed');
      content.style.maxHeight = content.scrollHeight + 'px'; // 펼친 상태 고정
    }

    // 헤더 전체 클릭으로 토글
    header.addEventListener('click', (e) => {
      e.preventDefault();
      toggleSection(section);
    });

    // 토글 버튼 클릭으로도 토글 (버블 방지)
    const btn = section.querySelector('.toggle-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSection(section);
      }, { passive: true });
    }
  });

  // 리사이즈 시 scrollHeight 갱신 (펼친 섹션만)
  const recalcHeights = () => {
    left.querySelectorAll('.popup-section').forEach((section) => {
      const content = section.querySelector('.section-content');
      if (!content) return;
      if (!section.classList.contains('collapsed')) {
        content.style.maxHeight = content.scrollHeight + 'px';
      }
    });
  };
  window.addEventListener('resize', recalcHeights);
  // 혹시 폰트/이미지 로드 후 높이 변동 보정
  setTimeout(recalcHeights, 300);
})();

  // ======================================================================
});
