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
    let savedZones = []; // 저장된 구역 데이터 배열

    const DRAW_ICON_INACTIVE = './js/03_safe_place_path.png';
    const DRAW_ICON_ACTIVE = './js/03_safe_place_path_toggle.png';

    // --- 3. 함수 정의 ---

    /**
     * [신규] 저장된 구역을 클릭했을 때 호출되는 함수
     * @param {number} zoneId - 불러올 구역의 ID
     */
    function displaySavedZone(zoneId) {
        const zoneToDisplay = savedZones.find(zone => zone.id === zoneId);
        if (!zoneToDisplay) return;

        // 모든 팝업 숨기기 (편집 UI, 목록 등)
        savedZonesPopup.classList.add('hidden');
        drawingToolbar.classList.add('hidden');
        
        // 메인 UI 팝업들 다시 보이기
        popupsToHide.forEach(selector => document.querySelector(selector)?.classList.remove('hidden'));

        // 캔버스 크기 맞추고 저장된 구역 그리기
        canvas.width = mapWrap.offsetWidth;
        canvas.height = mapWrap.offsetHeight;
        drawPolygonAndMarkers(zoneToDisplay.points);
    }

    /**
     * [신규] 저장된 구역 목록을 팝업에 표시하고 클릭 이벤트를 추가하는 함수
     */
    function renderSavedZones() {
        savedZonesList.innerHTML = '';
        if (savedZones.length === 0) {
            savedZonesList.innerHTML = '<li>저장된 구역이 없습니다.</li>';
        } else {
            savedZones.forEach(zone => {
                const li = document.createElement('li');
                li.textContent = zone.name;
                li.dataset.zoneId = zone.id;
                
                // 각 목록 아이템에 클릭 이벤트 추가
                li.addEventListener('click', () => {
                    // String으로 저장된 data attribute를 숫자로 변환
                    const selectedZoneId = parseInt(li.dataset.zoneId, 10);
                    displaySavedZone(selectedZoneId);
                });
                
                savedZonesList.appendChild(li);
            });
        }
    }

    // 편집 모드 시작
    function enterEditMode() {
        savedZonesPopup.classList.add('hidden');
        popupsToHide.forEach(selector => document.querySelector(selector)?.classList.add('hidden'));
        drawingToolbar.classList.remove('hidden');
        canvas.width = mapWrap.offsetWidth;
        canvas.height = mapWrap.offsetHeight;
        // 편집 모드 시작 시 이전 그림 초기화
        resetDrawing();
    }

    // 편집 모드 종료
    function exitEditMode() {
        resetDrawing();
        drawingToolbar.classList.add('hidden');
        popupsToHide.forEach(selector => document.querySelector(selector)?.classList.remove('hidden'));
        renderSavedZones();
        savedZonesPopup.classList.remove('hidden');
    }

    // 지도 위 모든 그림 초기화
    function resetDrawing() {
        isDrawingMode = false;
        currentDrawingPoints = [];
        drawPolygonAndMarkers([]); // 캔버스와 마커 모두 지우기
        drawBtn.classList.remove('active');
        drawBtn.querySelector('img').src = DRAW_ICON_INACTIVE;
        canvas.style.pointerEvents = 'none';
    }

    /**
     * [수정] 폴리곤과 마커를 그리는 역할을 분리한 함수
     * @param {Array} points - 화면에 그릴 좌표 배열
     */
    function drawPolygonAndMarkers(points) {
        // 기존 마커 모두 삭제
        document.querySelectorAll('.zone-marker').forEach(marker => marker.remove());
        // 캔버스 클리어
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!points || points.length === 0) return;

        // 전달받은 좌표 기준으로 새 마커 생성
        points.forEach(point => {
            const markerEl = document.createElement('div');
            markerEl.className = 'zone-marker';
            markerEl.style.left = `${point.x}px`;
            markerEl.style.top = `${point.y}px`;
            mapWrap.appendChild(markerEl);
        });
        
        // 폴리곤 그리기
        ctx.strokeStyle = 'yellow';
        ctx.lineWidth = 3;
        ctx.fillStyle = 'rgba(231, 196, 15, 0.3)';

        if (points.length < 2) return;
        
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x, points[i].y);
        }
        
        if (points.length > 2) {
            ctx.closePath();
        }
        ctx.stroke();

        if (points.length > 2) {
            ctx.fill();
        }
    }

    // --- 4. 이벤트 리스너 ---

    // "안전 구역 설정" 메인 버튼 클릭
    safeZoneSetupBtn.addEventListener('click', () => {
        // 기존에 그려진 폴리곤이 있다면 지우기
        drawPolygonAndMarkers([]);
        renderSavedZones();
        savedZonesPopup.classList.remove('hidden');
    });

    closeZonesListBtn.addEventListener('click', () => {
        savedZonesPopup.classList.add('hidden');
    });

    createNewZoneBtn.addEventListener('click', enterEditMode);
    resetBtn.addEventListener('click', resetDrawing);

    drawBtn.addEventListener('click', () => {
        isDrawingMode = !isDrawingMode;
        drawBtn.classList.toggle('active');
        drawBtn.querySelector('img').src = isDrawingMode ? DRAW_ICON_ACTIVE : DRAW_ICON_INACTIVE;
        canvas.style.pointerEvents = isDrawingMode ? 'auto' : 'none';
    });
    
    confirmBtn.addEventListener('click', () => {
        if (currentDrawingPoints.length < 3) {
            alert('안전 구역을 설정하려면 최소 3개 이상의 지점을 찍어야 합니다.');
            return;
        }
        confirmModal.classList.remove('hidden');
    });

    // 지도에 마커 찍기
    mapWrap.addEventListener('click', (e) => {
        if (!isDrawingMode) return;
        
        const rect = mapWrap.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        currentDrawingPoints.push({ x, y });
        // 현재 그리고 있는 내용을 실시간으로 다시 그림
        drawPolygonAndMarkers(currentDrawingPoints);
    });

    cancelRegBtn.addEventListener('click', () => {
        confirmModal.classList.add('hidden');
    });

    // "안전 경로 등록하기" 버튼 클릭
    processRegBtn.addEventListener('click', () => {
        const zoneName = document.getElementById('zone-name').value;
        if (!zoneName) {
            alert('구역 이름을 입력해주세요.');
            return;
        }
        
        const newZone = {
            id: Date.now(),
            name: zoneName,
            points: currentDrawingPoints // 현재 그린 좌표를 저장
        };
        savedZones.push(newZone);

        console.log(`--- 안전 구역 등록 완료 ---`);
        console.log(newZone);

        confirmModal.classList.add('hidden');
        successAlert.classList.remove('hidden');

        setTimeout(() => {
            successAlert.classList.add('hidden');
            exitEditMode();
        }, 2000);
    });
});