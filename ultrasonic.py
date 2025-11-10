from gpiozero import DistanceSensor
from time import sleep

# 초음파 센서 핀 설정 (Echo, Trigger)
sensor = DistanceSensor(echo=24, trigger=23)

print("초음파 거리 센서 테스트 시작... (Ctrl+C로 종료)")

try:
    while True:
        distance_cm = sensor.distance * 100  # m → cm 변환
        print(f"거리: {distance_cm:.1f} cm")

        if distance_cm < 10:
            print("⚠️ WARNING: Object too close!\n")
        sleep(1)

except KeyboardInterrupt:
    print("\n테스트 종료")