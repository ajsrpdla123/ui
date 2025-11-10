// js/log.js
// 주행주의 시작
document.body.classList.toggle('driving-caution-active', true);

// 주행주의 해제
document.body.classList.toggle('driving-caution-active', false);


// 전역 스코프에 hazardLogger 객체를 만들어 다른 JS 파일에서 접근 가능하게 함
window.hazardLogger = {
    // IMU 데이터를 받아 전복 위험을 체크하는 함수
    checkIMU: function(imuData) {
        // --- 위험 단계별 임계값 설정 ---
        // 주의 (Warning) 단계 기준
        const WARNING_ROLL = 10;
        const WARNING_PITCH = 8;
        // 경고 (Critical) 단계 기준
        const CRITICAL_ROLL = 20;
        const CRITICAL_PITCH = 18;
        // ---------------------------------

        let alertLevel = null;
        let alertMessage = '';

        const roll = Math.abs(imuData.roll);
        const pitch = Math.abs(imuData.pitch);

        // 단계별 위험도 체크 (더 위험한 '경고'부터 체크)
        if (roll >= CRITICAL_ROLL || pitch >= CRITICAL_PITCH) {
            alertLevel = 'critical';
            alertMessage = '차량 전복 경고!';
        } else if (roll >= WARNING_ROLL || pitch >= WARNING_PITCH) {
            alertLevel = 'warning';
            alertMessage = '차량 주행 주의';
        }

        // 위험이 감지되었을 경우
        if (alertLevel) {
            // 1. 실시간 경고 팝업 표시
            this.showAlertPopup(alertMessage, alertLevel);

            // 2. 로그 데이터 자동 저장
            const logEntry = {
                type: alertMessage,
                details: `Roll: ${imuData.roll.toFixed(1)}°, Pitch: ${imuData.pitch.toFixed(1)}°`,
                level: alertLevel,
                timestamp: new Date()
            };
            logManager.addLog(logEntry);
        } else {
            // 안전 상태일 경우, 경고 팝업 숨기기
            this.hideAlertPopup();
        }
    },

    // 실시간 경고 팝업을 표시하는 함수
    showAlertPopup: function(message, level) {
        const rolloverPopup = document.getElementById('rollover-alert-popup');
        const alertTextElement = rolloverPopup.querySelector('.alert-text h3');
        
        // 기존 스타일 클래스(warning-alert, critical-alert)를 모두 제거
        rolloverPopup.classList.remove('warning-alert', 'critical-alert');
        // 현재 위험도에 맞는 클래스 추가
        rolloverPopup.classList.add(`${level}-alert`);
        
        alertTextElement.textContent = message;
        rolloverPopup.classList.remove('hidden');
    },

    // 실시간 경고 팝업을 숨기는 함수
    hideAlertPopup: function() {
        document.getElementById('rollover-alert-popup').classList.add('hidden');
    }
};

// 로그 데이터를 관리하는 객체
const logManager = {
    logs: [],
    addLog: function(logEntry) {
        // 동일한 유형의 로그가 짧은 시간 내에 중복 저장되는 것을 방지 (선택 사항)
        const lastLog = this.logs[0];
        if (lastLog && lastLog.type === logEntry.type && (new Date() - lastLog.timestamp < 5000)) { // 5초 이내 중복 방지
            return;
        }
        this.logs.unshift(logEntry);
    },
    getLogs: function() {
        return this.logs;
    }
};


document.addEventListener('DOMContentLoaded', () => {
    // 필요한 HTML 요소들
    const hazardLogBtn = document.getElementById('hazard-log-btn');
    const modal = document.getElementById('hazard-log-modal');
    const closeModalBtn = document.getElementById('close-hazard-modal-btn');
    const logListContainer = document.getElementById('hazard-log-list');
    const rolloverPopup = document.getElementById('rollover-alert-popup');
    const closeRolloverAlertBtn = document.getElementById('close-rollover-alert-btn');

    if (!hazardLogBtn || !modal || !rolloverPopup) {
        console.error('로그 기능에 필요한 HTML 요소를 찾을 수 없습니다.');
        return;
    }
    
    // 로그 목록을 HTML로 만들어주는 함수
    function renderLogList() {
        const logs = logManager.getLogs();
        logListContainer.innerHTML = '';

        if (logs.length === 0) {
            logListContainer.innerHTML = '<div class="no-logs">기록된 위험이 없습니다.</div>';
            return;
        }

        logs.forEach(log => {
            const item = document.createElement('div');
            item.className = `log-item ${log.level}`;
            const ts = log.timestamp;
            const formattedTimestamp = 
                `${String(ts.getFullYear()).slice(-2)}.${String(ts.getMonth() + 1).padStart(2, '0')}.${String(ts.getDate()).padStart(2, '0')} ` +
                `${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}:${String(ts.getSeconds()).padStart(2, '0')}`;
            item.innerHTML = `<span class="log-timestamp">${formattedTimestamp}</span><span class="log-type">${log.type}</span>`;
            logListContainer.appendChild(item);
        });
    }

    // "주행 위험 기록" 버튼 클릭 이벤트
    hazardLogBtn.addEventListener('click', () => {
        renderLogList();
        modal.classList.remove('hidden');
    });

    // 닫기 버튼 이벤트
    closeModalBtn.addEventListener('click', () => modal.classList.add('hidden'));
    closeRolloverAlertBtn.addEventListener('click', () => window.hazardLogger.hideAlertPopup());

    // 팝업 배경 클릭 시 닫기
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            modal.classList.add('hidden');
        }
    });
});
