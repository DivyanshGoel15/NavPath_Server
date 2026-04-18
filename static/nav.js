/**
 * nav.js — NavPath Ambulance v4
 * Navigation countdown timer, intersection banner,
 * turn-by-turn voice guidance, and speed-aware ETA.
 * Depends on: app.js, ui.js, maps.js
 */

/* ════════════════════════════════════════
   NAV TIMER
════════════════════════════════════════ */
window.startNavTimer = function () {
  if (APP.navTimer) clearInterval(APP.navTimer);
  APP._navTimerRunning = true;

  APP.navProgress = 0;
  APP.navTotalSec = Math.round(APP.navEtaSec || 574);
  const totalSec  = APP.navTotalSec;
  const totalDist = Math.round(APP.navTotalDist || (totalSec * 14));
  let lastStepIdx = -1;

  APP.navTimer = setInterval(() => {

    /* ── Speed ── */
    const spd = APP.gps?.speed != null
      ? Math.round(APP.gps.speed * 3.6)
      : (APP.gpsMode === 'sim' ? 45 + Math.floor(Math.random() * 30) : 0);
    const elSpd = document.getElementById('navSpd');
    if (elSpd) { elSpd.textContent = spd; elSpd.classList.toggle('hot', spd > 80); }

    /* ── ETA countdown (only ticks when moving) ── */
    if (spd > 0) APP.navEtaSec = Math.max(0, APP.navEtaSec - 1);
    APP.navProgress = Math.min(((totalSec - APP.navEtaSec) / totalSec) * 100, 100);

    const uiEta = document.getElementById('navEta');
    if (uiEta) uiEta.textContent = window.fmtEta(APP.navEtaSec);

    /* ── Progress bar ── */
    const rpFill  = document.getElementById('rpFill');
    const rpLabel = document.getElementById('rpLabel');
    if (rpFill)  rpFill.style.width     = APP.navProgress.toFixed(1) + '%';
    if (rpLabel) rpLabel.textContent    = Math.round(APP.navProgress) + '%';

    /* ── Distance / ETA in banner (skip when server has control) ── */
    const banner = document.getElementById('intBanner');
    if (!banner?.dataset.serverControlled) {
      const distRem = Math.max(0, Math.round(totalDist * (1 - APP.navProgress / 100)));
      const bDistEl = document.getElementById('bDist');
      if (bDistEl) {
        const unitEl = bDistEl.nextElementSibling;
        if (distRem > 999) {
          bDistEl.textContent = (distRem / 1000).toFixed(1);
          if (unitEl?.classList.contains('distUnit')) unitEl.textContent = ' km';
        } else {
          bDistEl.textContent = distRem;
          if (unitEl?.classList.contains('distUnit')) unitEl.textContent = ' m';
        }
      }
      const bEtaEl = document.getElementById('bEta');
      if (bEtaEl) bEtaEl.textContent = distRem > 0 ? 'ETA ~' + Math.ceil(APP.navEtaSec / 60) + ' min' : 'Arriving...';
    }

    /* ── Banner name (server route intersections priority over OSRM steps) ── */
    if (!banner?.dataset.serverControlled) {
      let bannerText = null;

      if (APP.routeId && APP.serverRoutes && APP._srvIntMap) {
        const activeRoute = APP.serverRoutes.find(r => r.id === APP.routeId);
        if (activeRoute?.intersections?.length) {
          const t     = APP.navProgress / 100;
          const ints  = activeRoute.intersections;
          const nextI = Math.min(Math.floor(t * ints.length) + 1, ints.length - 1);
          const iName = APP._srvIntMap[ints[nextI]]?.name || 'Junction';
          bannerText  = ints[nextI] + ' · ' + iName;
        }
      }

      if (!bannerText && APP._navSteps?.length > 1) {
        const t      = APP.navProgress / 100;
        const stepI  = Math.min(Math.floor(t * APP._navSteps.length), APP._navSteps.length - 1);
        const nextI  = Math.min(stepI + 1, APP._navSteps.length - 1);
        const nxStep = APP._navSteps[nextI];
        bannerText   = 'Step ' + nextI + ' · ' + (nxStep.name?.split(',')[0] || 'Junction');
      }

      if (bannerText && banner) {
        const bNameEl   = document.getElementById('bName');
        const bStatusEl = document.getElementById('bStatus');
        if (bNameEl   && bNameEl.textContent !== bannerText)    bNameEl.textContent   = bannerText;
        if (banner.className !== 'intBanner approaching')        banner.className      = 'intBanner approaching';
        if (bStatusEl && bStatusEl.textContent !== '⬤  APPROACHING') bStatusEl.textContent = '⬤  APPROACHING';
      }
    }

    /* ── Move ambulance marker along route path (sim mode only) ── */
    if (APP.navRoute?.length > 1 && APP.navMarker) {
      const t    = APP.navProgress / 100;
      const segs = APP.navRoute.length - 1;
      const si   = Math.max(0, Math.min(Math.floor(t * segs), segs - 1));
      const lt   = t * segs - si;
      const a    = APP.navRoute[si], b = APP.navRoute[si + 1];
      const pos  = [a.lat + (b.lat - a.lat) * lt, a.lng + (b.lng - a.lng) * lt];

      if (APP.gpsMode !== 'real') {
        APP.navMarker.setLatLng(pos);
        if (APP.navMap) APP.navMap.panTo(pos);
      }

      /* ── Voice turn-by-turn ── */
      if (APP._navSteps?.length) {
        const stepIdx = Math.min(Math.floor(t * APP._navSteps.length), APP._navSteps.length - 1);
        if (stepIdx !== lastStepIdx) {
          lastStepIdx = stepIdx;
          announceStep(APP._navSteps[stepIdx]);
        }
      }
    }

    /* ── Arrived? ── */
    if (APP.navEtaSec <= 0) {
      clearInterval(APP.navTimer);
      APP.navTimer         = null;
      APP._navTimerRunning = false;
      arrive();
    }

  }, 1000);
};

/* ════════════════════════════════════════
   VOICE GUIDANCE
════════════════════════════════════════ */
function speak(txt) {
  if (!window.speechSynthesis || APP.muted) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  u.rate = 0.93; u.pitch = 1.05;
  window.speechSynthesis.speak(u);
}

function announceStep(step) {
  if (!step || APP.muted) return;
  const dist   = step.distance > 1000 ? (step.distance / 1000).toFixed(1) + ' km' : Math.round(step.distance) + ' m';
  const type   = step.maneuver.type;
  const mod    = step.maneuver.modifier;
  const name   = step.name ? ' onto ' + step.name : '';
  let text     = `${type} ${mod || ''}${name}`.trim();
  if (type === 'turn')      text = `Turn ${mod}${name}`;
  else if (type === 'new name') text = `Continue${name}`;
  else if (type === 'depart')   text = `Head ${mod || ''}${name}`;
  else if (type === 'arrive')   text = 'Arrive at destination';

  speak('In ' + dist + ', ' + text);

  const turnTxt  = document.getElementById('turnTxt');
  const turnDist = document.getElementById('turnDist');
  const turnArr  = document.getElementById('turnArr');
  if (turnTxt)  turnTxt.textContent  = text;
  if (turnDist) turnDist.textContent = 'in ' + dist;
  if (turnArr) {
    const m = mod || '';
    turnArr.textContent = m.includes('left')  ? '↰'
                        : m.includes('right') ? '↱'
                        : m.includes('uturn') ? '↺' : '⬆';
  }
}

/* ════════════════════════════════════════
   BANNER CYCLE (demo / offline mode)
════════════════════════════════════════ */
function cycleBanner() {
  APP.bannerIdx = (APP.bannerIdx + 1) % BANNERS.length;
  const b  = BANNERS[APP.bannerIdx];
  const el = document.getElementById('intBanner');
  el.className = 'intBanner ' + b.cls;
  document.getElementById('bStatus').textContent = b.status;
  document.getElementById('bName').textContent   = b.name;
  if (!APP.muted) {
    if (b.cls === 'clear')       speak('Intersection is now clear. Drive through.');
    if (b.cls === 'clearing')    speak('Clearing intersection ahead. Slow down.');
    if (b.cls === 'approaching') speak('Approaching next intersection.');
  }
  if (navigator.vibrate) {
    if (b.cls === 'clear')    navigator.vibrate([80, 40, 80]);
    else if (b.cls === 'clearing') navigator.vibrate([200]);
  }
}
