// map_data.js — 이동벡터 기반 방향 + 후진 반전 + 스무딩 + 노이즈 데드밴드
//  * 마커 PNG의 "위쪽"이 머리 (기본각 오프셋 0)
//  * 속도<0 이면 180° 반전
//  * 기본값: ENU→픽셀 Affine(TX,A,B,C,D) 사용 (네가 쓰던 방식 유지)
//  * 옵션: QGIS GeoTIFF GeoTransform 6계수로 바로 쓰기 (USE_GEOTRANSFORM=true)

document.addEventListener('DOMContentLoaded', () => {
  const mapWrap = document.getElementById('map-wrap');
  const marker  = document.getElementById('marker');
  if (!mapWrap || !marker) { console.error('map-wrap/marker 요소 없음'); return; }

  // ───────────── 설정 ─────────────
  // ① 현재 사용 모드 선택
  const USE_GEOTRANSFORM = false; // GeoTIFF 계수로 쓰려면 true 로 변경

  // ② ENU → Pixel Affine (네가 쓰던 값 그대로)
  //    x = TX + A*E + B*N
  //    y = TY + C*E + D*N
  const AFFINE = {
    TX:  932.464070,
    TY:  450.109842,
    A:     9.216207646,
    B:    -0.061612456,
    C:    -0.472955516,
    D:    -9.435695734,
  };

  // ③ (옵션) QGIS GeoTIFF GeoTransform (EPSG:4326, 이번 tif 요약)
  //    ※ 이번 GeoTIFF는 X=위도(lat), Y=경도(lon)로 저장되어 있었음(Data axis 2,1)
  //    X_map(=lat) = GT0 + GT1*x + GT2*y
  //    Y_map(=lon) = GT3 + GT4*x + GT5*y
  const GT = {
    GT0: 37.269425381421421,  // origin X (lat)
    GT1: 0.000001174616595,   // pixel size X
    GT2: 0.0,
    GT3: 126.992728088402302, // origin Y (lon)
    GT4: 0.0,
    GT5: -0.000001174616595   // pixel size Y (north-up → 음수)
  };
  // GeoTIFF의 원본 픽셀 크기 (가로×세로). GeoTIFF 그대로 웹에 띄우면 이 값과 일치해야 함
  const GT_NATIVE = { w: 1149, h: 2682 };

  // ④ 표시/헤딩 파라미터
  const MIN_MOVE_PIX = 0.7;          // 이 픽셀 이하 이동은 노이즈로 취급 (표시 갱신 X)
  const HEADING_SMOOTH_ALPHA = 0.30; // 헤딩 EMA
  const MARKER_BASE_HEADING_DEG = 0; // 마커 PNG 위쪽=0°

  // ⑤ 기타
  const CLAMP_TO_IMAGE = true; // true면 마커를 이미지 경계 밖으로 못 나가게 클램프

  // ───────── 내부 상태 ─────────
  let anchorLL = null;                // {lat0, lon0} (ENU 방식에서만 사용)
  let lastGNSS = null;                // {lat, lon, angle, speedKmh}
  let lastPix  = null;                // 이전 프레임 픽셀 좌표(트랙 계산용)
  let shownPix = null;                // 화면에 실제로 그린 좌표(데드밴드 적용)
  let smoothedHeadingDeg = null;

  // ───────── 도구 함수 ─────────
  const R = 6378137.0;
  const toRad  = (d) => d * Math.PI / 180;
  const toDeg  = (r) => r * 180 / Math.PI;
  const wrap360 = (d) => (d % 360 + 360) % 360;

  function smoothAngle(prev, next, a){
    if(!Number.isFinite(prev)) return next;
    if(!Number.isFinite(next)) return prev;
    const delta = ((next - prev + 540) % 360) - 180; // -180~+180로 최소차
    return wrap360(prev + delta * a);
  }

  // (A) ENU → 픽셀 (기존 방식)
  function llToEN(lat, lon) {
    const lat0 = toRad(anchorLL.lat0);
    const dLat = toRad(lat - anchorLL.lat0);
    const dLon = toRad(lon - anchorLL.lon0);
    const east  = R * Math.cos(lat0) * dLon;
    const north = R * dLat;
    return { east, north };
  }
  function enToPixel(east, north) {
    return {
      x: AFFINE.TX + AFFINE.A*east + AFFINE.B*north,
      y: AFFINE.TY + AFFINE.C*east + AFFINE.D*north
    };
  }

  // (B) GeoTransform 역변환: lon,lat → pixel
  //     이번 GeoTIFF는 lat→X_map, lon→Y_map 구조라 아래처럼 계산
  function lonLatToPixel_GT(lon, lat) {
    const L = lat, G = lon;
    const det = GT.GT1 * GT.GT5 - GT.GT2 * GT.GT4; // 일반적으로 GT2=GT4=0 → det = GT1*GT5
    const x = (  GT.GT5 * (L - GT.GT0) - GT.GT2 * (G - GT.GT3)) / det;
    const y = ( -GT.GT4 * (L - GT.GT0) + GT.GT1 * (G - GT.GT3)) / det;
    return { x, y };
  }

  // (C) 공통: 경위도 → 픽셀
  function lonLatToPixel(lon, lat) {
    if (USE_GEOTRANSFORM) {
      return lonLatToPixel_GT(lon, lat);
    } else {
      if (!anchorLL) return null;
      const { east, north } = llToEN(lat, lon);
      return enToPixel(east, north);
    }
  }

  // (D) GNSS 헤딩(도, 0°=북)을 픽셀 좌표계 각도로 변환 (모드에 상관없이 동작)
  //     이동이 거의 없을 때의 fallback 용도. 1m 전방 점을 만들어 각도 산출.
  function headingToCssDeg(lon, lat, headingDeg) {
    if (!Number.isFinite(headingDeg)) return null;
    const hr = toRad(headingDeg);
    const step = 1.0; // m
    const dN = step * Math.cos(hr);
    const dE = step * Math.sin(hr);
    const dLat = (dN / R) * (180 / Math.PI);
    const dLon = (dE / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);

    const p1 = lonLatToPixel(lon, lat);
    const p2 = lonLatToPixel(lon + dLon, lat + dLat);
    if (!p1 || !p2) return null;

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    if (Math.hypot(dx, dy) < 1e-6) return null;

    // CSS: 0°=위(-y), 시계방향
    return wrap360(Math.atan2(dx, -dy) * 180 / Math.PI);
  }

  // (E) 화면 표시 크기와 원본 픽셀 그리드 스케일 보정
  function applyDisplayScale(px) {
    if (!px) return null;
    // 원본 픽셀 크기
    const nativeW = USE_GEOTRANSFORM ? GT_NATIVE.w : mapWrap.clientWidth; // ENU 모드에선 이미지 자체를 1:1 사용 권장
    const nativeH = USE_GEOTRANSFORM ? GT_NATIVE.h : mapWrap.clientHeight;

    const dispW = mapWrap.clientWidth;
    const dispH = mapWrap.clientHeight;

    const sx = dispW / nativeW;
    const sy = dispH / nativeH;
    return { x: px.x * sx, y: px.y * sy };
  }

  // ───────── 렌더링 ─────────
  function redraw() {
    if (!lastGNSS) return;

    // 1) 현재 좌표 → 픽셀
    const curPx = lonLatToPixel(lastGNSS.lon, lastGNSS.lat);
    if (!curPx) return;

    // 2) 이동벡터(트랙) 각도 (좌표 갱신 전에!)
    let trackDeg = null;
    if (lastPix) {
      const dx = curPx.x - lastPix.x;
      const dy = curPx.y - lastPix.y;
      const moveLen = Math.hypot(dx, dy);
      if (moveLen >= MIN_MOVE_PIX) {
        trackDeg = wrap360(Math.atan2(dx, -dy) * 180 / Math.PI);
      }
    }

    // 3) 표시 좌표(데드밴드)
    if (!shownPix) {
      shownPix = { x: curPx.x, y: curPx.y };
    } else {
      const dpx = curPx.x - shownPix.x;
      const dpy = curPx.y - shownPix.y;
      if (Math.hypot(dpx, dpy) >= MIN_MOVE_PIX) {
        shownPix = { x: curPx.x, y: curPx.y };
      }
    }

    // 4) 헤딩 선택: 트랙 우선, 없으면 GNSS 헤딩 픽셀각
    let deg = trackDeg;
    if (deg === null) deg = headingToCssDeg(lastGNSS.lon, lastGNSS.lat, lastGNSS.angle);
    if (deg === null) deg = smoothedHeadingDeg ?? 0;

    // 5) 후진이면 180° 반전
    const v = Number(lastGNSS.speedKmh ?? lastGNSS.speed ?? NaN);
    if (Number.isFinite(v) && v < 0) deg = wrap360(deg + 180);

    // 6) 마커 기본 오프셋(위쪽=0° → 0)
    deg = wrap360(deg + MARKER_BASE_HEADING_DEG);

    // 7) 스무딩, 스케일 적용, 경계 클램프
    smoothedHeadingDeg = smoothAngle(smoothedHeadingDeg, deg, HEADING_SMOOTH_ALPHA);

    let drawPx = applyDisplayScale(shownPix) || shownPix;

    if (CLAMP_TO_IMAGE) {
      const w = mapWrap.clientWidth, h = mapWrap.clientHeight;
      drawPx.x = Math.max(0, Math.min(w, drawPx.x));
      drawPx.y = Math.max(0, Math.min(h, drawPx.y));
    }

    marker.style.left = `${drawPx.x}px`;
    marker.style.top  = `${drawPx.y}px`;
    marker.style.transform = `translate(-50%, -50%) rotate(${smoothedHeadingDeg}deg)`;

    // 8) 다음 프레임 대비
    lastPix = { x: curPx.x, y: curPx.y };
  }

  // ───────── 메시지 수신 ─────────
  window.addEventListener('message', (event) => {
    let payload = event.data;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { return; } }
    if (!payload || String(payload.action || '').toLowerCase() !== 'gnss') return;

    const lat   = parseFloat(payload.lat);
    const lon   = parseFloat(payload.lon);
    const ang   = (payload.angle !== undefined) ? parseFloat(payload.angle) : NaN;
    const speed = (payload.speed !== undefined) ? parseFloat(payload.speed) : NaN;

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return;

    // ENU 모드면 첫 좌표를 앵커로 고정
    if (!USE_GEOTRANSFORM && !anchorLL) anchorLL = { lat0: lat, lon0: lon };

    lastGNSS = { lat, lon, angle: ang, speedKmh: speed };
    redraw();
  });

  // ───────── 리사이즈 대응 ─────────
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 100);
  });
});
