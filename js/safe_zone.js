// js/safe_zone.js
document.addEventListener('DOMContentLoaded', () => {

  // --- 1. 요소 선택 ---
  const safeZoneSetupBtn = document.getElementById('safe-zone-btn');
  const popupsToHide = ['#left-popup', '#right-popup', '#location-popup', '#bottom-info-popup'];

  const savedZonesPopup = document.getElementById('saved-zones-list-popup');
  const closeZonesListBtn = document.getElementById('close-zones-list-btn');
  const createNewZoneBtn = document.getElementById('create-new-zone-btn');
  const savedZonesList = document.getElementById('saved-zones-list');

  const drawingToolbar = document.getElementById('drawing-toolbar');
  const resetBtn = document.getElementById('reset-zone-btn');
  const drawBtn = document.getElementById('draw-zone-btn');
  const confirmBtn = document.getElementById('confirm-zone-btn');

  const mapWrap = document.getElementById('map-wrap');
  const canvas = document.getElementById('drawing-canvas');
  const ctx = canvas.getContext('2d');

  const confirmModal = document.getElementById('confirm-zone-modal');
  const cancelRegBtn = document.getElementById('cancel-registration-btn');
  const processRegBtn = document.getElementById('process-registration-btn');
  const successAlert = document.getElementById('success-alert');

  // --- 2. 상태 및 데이터 변수 ---
  let isDrawingMode = false;
  let currentDrawingPoints = [];

  // 저장된 구역 목록 및 활성 구역
  let savedZones = [];
  let activeZoneId = null; // 현재 감시 대상

  const DRAW_ICON_INACTIVE = './js/03_safe_place_path.png';
  const DRAW_ICON_ACTIVE = './js/03_safe_place_path_toggle.png';

  // ======================================================================
  // [ADD] 지오펜스 엔진 (SafeZone 전역 API)
  // ======================================================================
  (function initSafeZoneEngine(){
    const SAFE = window.SafeZone || {};

    // 월드→픽셀 변환 함수 (main.js에서 등록)
    let worldToPixel = null;
    SAFE.setWorldToPixel = (fn) => { if (typeof fn === 'function') worldToPixel = fn; };

    // 판정 상태
    let lastInside = null;           // null | true | false
    let lastChangeAt = 0;
    const EXIT_COOLDOWN_MS = 3000;   // 이탈 알림 쿨다운
    const ENTER_DEBOUNCE_MS = 600;   // 복귀 디바운스

    // 폴리곤 안/밖 판정 (레이캐스팅)
    function pointInPolygon(px, py, polyPoints) {
      if (!Array.isArray(polyPoints) || polyPoints.length < 3) return false;
      let inside = false;
      for (let i = 0, j = polyPoints.length - 1; i < polyPoints.length; j = i++) {
        const xi = polyPoints[i].x, yi = polyPoints[i].y;
        const xj = polyPoints[j].x, yj = polyPoints[j].y;
        const intersect = ((yi > py) !== (yj > py)) &&
                          (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function getActivePolygon() {
      if (!activeZoneId) return null;
      const z = savedZones.find(z => z.id === activeZoneId);
      return z?.points || null;
    }

    // 팝업 UI (모달 있으면 사용, 없으면 토스트 fallback)
    function showAlertUI(message) {
      if (typeof window.showGeofenceAlert === 'function') {
        window.showGeofenceAlert(message || '안전구역을 벗어났습니다.');
        return;
      }
      // fallback: 토스트
      let toast = document.getElementById('geofence-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'geofence-toast';
        Object.assign(toast.style, {
          position:'fixed', top:'20px', left:'50%', transform:'translateX(-50%)',
          background:'#e74c3c', color:'#fff', padding:'10px 16px',
          borderRadius:'8px', zIndex: 5000, boxShadow:'0 4px 12px rgba(0,0,0,.25)',
          fontWeight:'700'
        });
        document.body.appendChild(toast);
      }
      toast.textContent = message || '안전구역을 벗어났습니다.';
      toast.style.display = 'block';
      clearTimeout(toast._t); toast._t = setTimeout(()=> toast.style.display='none', 2500);
    }
    function hideAlertUI() {
      if (typeof window.hideGeofenceAlert === 'function') {
        window.hideGeofenceAlert();
        return;
      }
      const toast = document.getElementById('geofence-toast');
      if (toast) toast.style.display = 'none';
    }

    function dispatch(name, detail) {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    }

    // 픽셀 좌표로 판정
    function evaluatePixel(px, py, ts=Date.now()) {
      const poly = getActivePolygon();
      if (!poly) return;

      const inside = pointInPolygon(px, py, poly);
      if (lastInside === null) { // 최초 상태 기록만
        lastInside = inside;
        lastChangeAt = ts;
        return;
      }

      if (inside !== lastInside) {
        const elapsed = ts - lastChangeAt;
        lastChangeAt = ts;

        if (!inside) {
          // -> 밖으로 나감
          if (elapsed >= EXIT_COOLDOWN_MS) {
            lastInside = inside;
            dispatch('geofence:exit', { when: ts, px, py, zoneId: activeZoneId });
            showAlertUI('안전구역을 벗어났습니다.');
          } else {
            lastInside = inside; // 상태만 갱신
          }
        } else {
          // -> 안으로 복귀
          if (elapsed >= ENTER_DEBOUNCE_MS) {
            lastInside = inside;
            dispatch('geofence:enter', { when: ts, px, py, zoneId: activeZoneId });
            hideAlertUI();
          } else {
            lastInside = inside;
          }
        }
      }
    }

    // 외부에서 호출
    SAFE.checkPixel = (x, y, ts) => evaluatePixel(x, y, ts);

    SAFE.checkLatLng = (lat, lon, ts=Date.now()) => {
      if (!worldToPixel || typeof lat !== 'number' || typeof lon !== 'number') return;
      const { x, y } = worldToPixel(lat, lon) || {};
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      evaluatePixel(x, y, ts);
    };

    window.SafeZone = SAFE;
  })();
  // ======================================================================

  // --- 3. 함수 정의 ---

  // 저장된 구역을 클릭하여 화면에 표시 + 활성화
  function displaySavedZone(zoneId) {
    const zoneToDisplay = savedZones.find(zone => zone.id === zoneId);
    if (!zoneToDisplay) return;

    savedZonesPopup.classList.add('hidden');
    drawingToolbar.classList.add('hidden');

    popupsToHide.forEach(selector => document.querySelector(selector)?.classList.remove('hidden'));

    canvas.width = mapWrap.offsetWidth;
    canvas.height = mapWrap.offsetHeight;
    drawPolygonAndMarkers(zoneToDisplay.points);

    // 활성 구역 설정
    activeZoneId = zoneId;
  }

  // 저장된 구역 목록 렌더
  function renderSavedZones() {
    savedZonesList.innerHTML = '';
    if (savedZones.length === 0) {
      savedZonesList.innerHTML = '<li>저장된 구역이 없습니다.</li>';
    } else {
      savedZones.forEach(zone => {
        const li = document.createElement('li');
        li.textContent = zone.name;
        li.dataset.zoneId = zone.id;
        li.addEventListener('click', () => {
          const selectedZoneId = parseInt(li.dataset.zoneId, 10);
          displaySavedZone(selectedZoneId);
        });
        savedZonesList.appendChild(li);
      });
    }
  }

  // 편집 모드
  function enterEditMode() {
    savedZonesPopup.classList.add('hidden');
    popupsToHide.forEach(selector => document.querySelector(selector)?.classList.add('hidden'));
    drawingToolbar.classList.remove('hidden');
    canvas.width = mapWrap.offsetWidth;
    canvas.height = mapWrap.offsetHeight;
    resetDrawing();
  }

  // 편집 종료
  function exitEditMode() {
    resetDrawing();
    drawingToolbar.classList.add('hidden');
    popupsToHide.forEach(selector => document.querySelector(selector)?.classList.remove('hidden'));
    renderSavedZones();
    savedZonesPopup.classList.remove('hidden');
  }

  // 초기화
  function resetDrawing() {
    isDrawingMode = false;
    currentDrawingPoints = [];
    drawPolygonAndMarkers([]);
    drawBtn.classList.remove('active');
    drawBtn.querySelector('img').src = DRAW_ICON_INACTIVE;
    canvas.style.pointerEvents = 'none';
  }

  // 폴리곤+마커 그리기
  function drawPolygonAndMarkers(points) {
    document.querySelectorAll('.zone-marker').forEach(marker => marker.remove());
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!points || points.length === 0) return;

    // 마커
    points.forEach(point => {
      const markerEl = document.createElement('div');
      markerEl.className = 'zone-marker';
      markerEl.style.left = `${point.x}px`;
      markerEl.style.top = `${point.y}px`;
      mapWrap.appendChild(markerEl);
    });

    // 폴리곤
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 3;
    ctx.fillStyle = 'rgba(231, 196, 15, 0.3)';

    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    if (points.length > 2) ctx.closePath();
    ctx.stroke();
    if (points.length > 2) ctx.fill();
  }

  // --- 4. 이벤트 리스너 ---

  // "안전 구역 설정" 버튼
  safeZoneSetupBtn?.addEventListener('click', () => {
    drawPolygonAndMarkers([]);
    renderSavedZones();
    savedZonesPopup.classList.remove('hidden');
  });

  closeZonesListBtn?.addEventListener('click', () => {
    savedZonesPopup.classList.add('hidden');
  });

  createNewZoneBtn?.addEventListener('click', enterEditMode);
  resetBtn?.addEventListener('click', resetDrawing);

  drawBtn?.addEventListener('click', () => {
    isDrawingMode = !isDrawingMode;
    drawBtn.classList.toggle('active');
    drawBtn.querySelector('img').src = isDrawingMode ? DRAW_ICON_ACTIVE : DRAW_ICON_INACTIVE;
    canvas.style.pointerEvents = isDrawingMode ? 'auto' : 'none';
  });

  confirmBtn?.addEventListener('click', () => {
    if (currentDrawingPoints.length < 3) {
      alert('안전 구역을 설정하려면 최소 3개 이상의 지점을 찍어야 합니다.');
      return;
    }
    confirmModal.classList.remove('hidden');
  });

  // 지도 클릭으로 점 추가
  mapWrap?.addEventListener('click', (e) => {
    if (!isDrawingMode) return;
    const rect = mapWrap.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    currentDrawingPoints.push({ x, y });
    drawPolygonAndMarkers(currentDrawingPoints);
  });

  cancelRegBtn?.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
  });

  // "안전 경로 등록하기"
  processRegBtn?.addEventListener('click', () => {
    const zoneName = document.getElementById('zone-name').value;
    if (!zoneName) {
      alert('구역 이름을 입력해주세요.');
      return;
    }
    const newZone = {
      id: Date.now(),
      name: zoneName,
      points: currentDrawingPoints.slice()
    };
    savedZones.push(newZone);
    activeZoneId = newZone.id; // 방금 등록한 구역을 활성화

    console.log('--- 안전 구역 등록 완료 ---', newZone);

    confirmModal.classList.add('hidden');
    successAlert.classList.remove('hidden');
    setTimeout(() => {
      successAlert.classList.add('hidden');
      exitEditMode();
    }, 2000);
  });

});
