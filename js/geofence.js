// js/geofence.js
// 안전구역(폴리곤) 이탈/복귀 감지 핵심 (픽셀좌표 기준)
// - point-in-polygon (ray casting)
// - 경계 히스테리시스, 연속판정, 쿨다운
const Geofence = (() => {
  function pointInPolygonPx(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) &&
                        (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function approxDistanceToPolygonPx(x, y, poly) {
    let min = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const d = (p) => Math.hypot(x - p.x, y - p.y);
      min = Math.min(min, d(a), d(b), d(mid));
    }
    return min;
  }

  const cfg = {
    requireOutsideCount: 3,
    requireInsideCount: 2,
    cooldownMs: 5000,
    edgeBufferPx: 4
  };

  let lastState = 'unknown';
  let lastChangeAt = 0;
  let outsideRun = 0;
  let insideRun = 0;

  function resetRuns() { outsideRun = 0; insideRun = 0; }

  function checkPixelPosition(x, y, polygon, t = Date.now()) {
    if (!polygon || polygon.length < 3) return { changed: false, state: lastState, distancePx: NaN };

    const insideRaw = pointInPolygonPx(x, y, polygon);
    const distPx = approxDistanceToPolygonPx(x, y, polygon);

    let inside = insideRaw;
    if (distPx < cfg.edgeBufferPx) {
      inside = (lastState === 'outside') ? false : true;
    }

    if (inside) {
      insideRun++; outsideRun = 0;
      if (lastState !== 'inside' && insideRun >= cfg.requireInsideCount) {
        const canChange = (t - lastChangeAt) > cfg.cooldownMs;
        if (canChange) {
          lastState = 'inside'; lastChangeAt = t;
          window.dispatchEvent(new CustomEvent('geofence:enter', { detail: { x, y, distPx } }));
          return { changed: true, state: lastState, distancePx: distPx };
        }
      }
    } else {
      outsideRun++; insideRun = 0;
      if (lastState !== 'outside' && outsideRun >= cfg.requireOutsideCount) {
        const canChange = (t - lastChangeAt) > cfg.cooldownMs;
        if (canChange) {
          lastState = 'outside'; lastChangeAt = t;
          window.dispatchEvent(new CustomEvent('geofence:exit', { detail: { x, y, distPx } }));
          return { changed: true, state: lastState, distancePx: distPx };
        }
      }
    }
    return { changed: false, state: lastState, distancePx: distPx };
  }

  return {
    cfg,
    resetRuns,
    checkPixelPosition,
    _internals: { pointInPolygonPx, approxDistanceToPolygonPx }
  };
})();

export default Geofence;
