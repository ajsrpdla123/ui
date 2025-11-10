// js/main.js
document.addEventListener('DOMContentLoaded', () => {
  // --- Part 0: 데이터 소스 스위치 -----------------------------------------
  const USE_WS_IMU   = true;                      // IMU를 WebSocket으로 받기
  const USE_CSV      = true;                      // CSV 재생도 유지
  const WS_URL       = 'ws://192.168.0.22:8765';  // 파이 IP로 교체
  const USE_LIVE_IMU = USE_WS_IMU;                // 과거 이름 호환
  const SIM_DT_MS    = 200;                       // 시뮬레이션 주기(ms)
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
    const toRad = (d) => d * (Math.PI / 180);
    const lat0r = toRad(__REF.lat);
    const dLat = toRad(lat - __REF.lat);
    const dLon = toRad(lon - __REF.lon);
    const dE = 6378137.0 * Math.cos(lat0r) * dLon; // 동쪽으로의 미터
    const dN = 6378137.0 * dLat;                   // 북쪽으로의 미터
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
    // GNSS → 속도
    if (stateCache.gnss) {
      const spd = Number(stateCache.gnss.speed) || 0;
      setTextSafe('#speed-value', spd.toFixed(1));
      tractorData.speed = spd;

      // 주행모드 표시(간단 규칙)
      const modeEl = getEl('#drive-mode-badge');
      if (modeEl && modeEl.length) {
        modeEl.text(Math.abs(spd) > 0.2 ? '주행' : '정지');
      }
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

  // --- Part 1c: RPM 기반 속도 추정기 -------------------------------------
  const rpmSpeedEstimator = (() => {
    const DT = SIM_DT_MS / 1000;
    const A_MAX = 1.5;
    const ALPHA = 0.25;
    const JUMP_MAX_M = 8.0;
    const STATIONARY_DIST_M = 0.40;

    const SPEED_SCALE = 1.08;
    const SPEED_BIAS_KMH = 0.20;

    const TRACK_MIN_FOR_CAL = 0.8;
    const RPM_MIN_FOR_CAL   = 800;
    const K_ALPHA           = 0.02;
    const K_INIT            = 0.0030;
    const K_MIN             = 0.0008;
    const K_MAX             = 0.02;
    const K_UPWARD_BIAS     = 1.00;

    const st = { vEma: 0, hasInit: false, prevLat: null, prevLon: null, lastSign: 1, K: K_INIT };

    function haversine(lat1, lon1, lat2, lon2) {
      const p = Math.PI/180;
      const dphi = (lat2-lat1)*p, dl = (lon2-lon1)*p;
      const a = Math.sin(dphi/2)**2 + Math.cos(lat1*p)*Math.cos(lat2*p)*Math.sin(dl/2)**2;
      return 2 * 6371000.0 * Math.asin(Math.sqrt(a));
    }

    function fuse(lat, lon, engineRpm, headingDeg) {
      let stepDist = null, trackKmh = null;
      if (st.prevLat != null) {
        stepDist = haversine(st.prevLat, st.prevLon, lat, lon);
        if (stepDist <= JUMP_MAX_M) trackKmh = (stepDist / DT) * 3.6;
      }

      let sign = st.lastSign;
      if (st.prevLat != null && Number.isFinite(headingDeg) && stepDist !== null) {
        const toRad = (d)=>d*(Math.PI/180);
        const lat0r = toRad(st.prevLat);
        const dLat = toRad(lat - st.prevLat);
        const dLon = toRad(lon - st.prevLon);
        const dE = 6378137.0 * Math.cos(lat0r) * dLon;
        const dN = 6378137.0 * dLat;

        const vtx = AFFINE.A * dE + AFFINE.B * dN;
        const vty = AFFINE.C * dE + AFFINE.D * dN;

        const hr = toRad(headingDeg);
        const e = Math.sin(hr), n = Math.cos(hr);
        const hx = AFFINE.A * e + AFFINE.B * n;
        const hy = AFFINE.C * e + AFFINE.D * n;

        const dot = vtx * hx + vty * hy;
        if (Math.hypot(vtx, vty) > 1e-3) sign = (dot >= 0) ? 1 : -1;
      }
      st.lastSign = sign;

      if (Number.isFinite(engineRpm) && engineRpm >= RPM_MIN_FOR_CAL &&
          trackKmh !== null && trackKmh >= TRACK_MIN_FOR_CAL) {
        let K_est = trackKmh / engineRpm;
        if (Number.isFinite(K_est)) {
          K_est *= K_UPWARD_BIAS;
          st.K = Math.min(K_MAX, Math.max(K_MIN, (1 - K_ALPHA) * st.K + K_ALPHA * K_est));
        }
      }

      const rpm = Math.max(0, Number(engineRpm) || 0);
      let vAbs = rpm * st.K;
      vAbs = vAbs * SPEED_SCALE + SPEED_BIAS_KMH;

      const stationary = (stepDist !== null && stepDist < STATIONARY_DIST_M);
      if (stationary) vAbs = 0;

      let vRaw = sign * vAbs;
      if (st.hasInit) {
        const dvMax = A_MAX * 3.6 * DT;
        const dv = vRaw - st.vEma;
        if (dv >  dvMax) vRaw = st.vEma + dvMax;
        if (dv < -dvMax) vRaw = st.vEma - dvMax;
      }
      const vEma = st.hasInit ? (ALPHA * vRaw + (1 - ALPHA) * st.vEma) : vRaw;

      st.vEma = vEma; st.prevLat = lat; st.prevLon = lon; st.hasInit = true;
      return vEma;
    }
    return { fuse };
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
    const vehicleData = {
      action: 'vehicle',
      deviation: row['Deviation(cm)'],
      engineSpeed: row['EngineSpeed(rpm)'] ?? row['Engine_RPM'] ?? row['RPM'] ?? row['engine_rpm'],
      fuelGauge: row['FuelGauge(%)']
    };

    stateCache.gnss    = gnssData;
    stateCache.vehicle = vehicleData;

    // [ADD] 첫 GNSS 기준점 세팅 + 변환 등록
    if (__REF.lat == null && Number.isFinite(gnssData.lat) && Number.isFinite(gnssData.lon)) {
      __REF.lat = gnssData.lat; __REF.lon = gnssData.lon;
      registerWorldToPixel();
    }

    safeUpdate();

    // [ADD] 지오펜스 체크 (CSV 경로)
    try { window.SafeZone?.checkLatLng(gnssData.lat, gnssData.lon, Date.now()); } catch {}

    if (window.hazardLogger && stateCache.imu) {
      callIf(true, () => window.hazardLogger.checkIMU(stateCache.imu));
    }

    try { window.postMessage(JSON.stringify(gnssData), '*'); } catch {}
  }

  // --- Part 2b: 실시간 IMU(WebSocket) 수신 -------------------------------
  if (USE_LIVE_IMU && 'WebSocket' in window) {
    let ws = null;
    let wsRetry = 0;
    let wsTimer = null;

    const connectWS = () => {
      try {
        ws = new WebSocket(WS_URL);
        ws.onopen = () => {
          console.log('[IMU] WebSocket connected:', WS_URL);
          wsRetry = 0;
        };
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
              stateCache.gnss = { ...msg };

              // [ADD] 첫 GNSS 기준점 세팅 + 변환 등록
              if (__REF.lat == null && Number.isFinite(stateCache.gnss.lat) && Number.isFinite(stateCache.gnss.lon)) {
                __REF.lat = stateCache.gnss.lat; __REF.lon = stateCache.gnss.lon;
                registerWorldToPixel();
              }

              safeUpdate();

              // [ADD] 지오펜스 체크 (WS 경로)
              try { window.SafeZone?.checkLatLng(stateCache.gnss.lat, stateCache.gnss.lon, Date.now()); } catch {}
            } else if (msg.action === 'vehicle') {
              stateCache.vehicle = { ...msg }; safeUpdate();
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

  // ▼▼▼ 왼쪽 섹션: 헤더 클릭으로 열기/닫기 ▼▼▼
  (function setupLeftCollapsibles(){
    const left = document.getElementById('left-popup');
    if (!left) return;

    try { if (hasJQ) $jq('.toggle-btn').off('click'); } catch(_) {}

    const defaultCollapsed = new Set(['실시간 영상', '트랙터 정보', '작업기 정보']);

    const setExpanded = (section, expanded) => {
      const content = section.querySelector('.section-content');
      if (!content) return;

      if (expanded) {
        section.classList.remove('collapsed');
        content.style.maxHeight = content.scrollHeight + 'px';
      } else {
        content.style.maxHeight = content.scrollHeight + 'px';
        requestAnimationFrame(() => { content.style.maxHeight = '0px'; });
        section.classList.add('collapsed');
      }
    };

    const toggleSection = (section) => {
      const isCollapsed = section.classList.contains('collapsed');
      setExpanded(section, isCollapsed);
    };

    left.querySelectorAll('.popup-section').forEach(section => {
      const header  = section.querySelector('.section-header');
      const content = section.querySelector('.section-content');
      if (!header || !content) return;

      const title = (section.querySelector('.section-title')?.textContent || '').trim();

      if (defaultCollapsed.has(title)) {
        content.style.maxHeight = '0px';
        section.classList.add('collapsed');
      } else {
        section.classList.remove('collapsed');
        content.style.maxHeight = content.scrollHeight + 'px';
      }

      header.addEventListener('click', (e) => { e.preventDefault(); toggleSection(section); });

      const btn = section.querySelector('.toggle-btn');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleSection(section);
        });
      }

      window.addEventListener('resize', () => {
        if (!section.classList.contains('collapsed')) {
          content.style.maxHeight = content.scrollHeight + 'px';
        }
      });
    });
  })();

  // --- 개발용: 지오펜스 출입 로그 ---
  window.addEventListener('geofence:exit',  e => console.log('%c[GEOFENCE] EXIT',  'color:#e74c3c', e.detail));
  window.addEventListener('geofence:enter', e => console.log('%c[GEOFENCE] ENTER', 'color:#2ecc71', e.detail));
  // -----------------------------------------------------------------------
});
