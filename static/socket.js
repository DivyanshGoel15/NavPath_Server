/**
 * socket.js — NavPath Ambulance v4
 * Socket.IO connection, all server event listeners,
 * and live banner / intersection updates from analytics.
 * Depends on: app.js, ui.js, nav.js, route.js
 */

/* ─── Connection ─── */
const socket = io(SERVER_URL, {
  transports:        ['websocket', 'polling'],
  reconnectionDelay: 2000,
});

/* ─── Connection pill indicator ─── */
function setConnPill(live) {
  const p = document.getElementById('connPill');
  const l = document.getElementById('connLabel');
  if (!p || !l) return;
  p.className  = live ? 'connPill live' : 'connPill offline';
  l.textContent = live ? 'LIVE' : 'OFFLINE';
}

socket.on('connect', () => {
  setConnPill(true);
  console.log('[NavPath] Socket connected:', socket.id);
});

socket.on('disconnect', () => {
  setConnPill(false);
  toast('🔴 Server disconnected');
});

/* ─── init — bootstraps full state on first connect ─── */
socket.on('init', data => {
  if (data.routes) APP.serverRoutes = data.routes;
  if (data.stats)  { APP.serverStats = data.stats; updateHomeStats(data.stats); }
  console.log('[NavPath] Server init — routes:', data.routes?.length, 'intersections:', data.intersections?.length);
});

/* ─── analytics — live GPS processed by server ─── */
socket.on('analytics', data => {
  if (data.amb_id !== APP.ambId) return;
  if (data.stats)         { APP.serverStats = data.stats; updateHomeStats(data.stats); }
  if (data.intersections) {
    updateBannerFromServer(data.intersections);
    updateRouteIntListFromAnalytics(data.intersections);
  }
});

/* ─── route_assigned — dispatcher pushed a route ─── */
socket.on('route_assigned', data => {
  if (!data.route) return;
  APP.routeId      = data.route.id;
  APP.navDestName  = data.route.destination;
  toast('📡 Dispatch assigned: ' + data.route.name);

  const rFrom   = document.getElementById('rFrom');
  const rTo     = document.getElementById('rTo');
  const navDest = document.getElementById('navDest');
  if (rFrom)   rFrom.textContent   = data.route.origin;
  if (rTo)     rTo.textContent     = data.route.destination;
  if (navDest) navDest.textContent = data.route.destination;

  document.getElementById('navDot')?.classList.add('show');
});

/* ─── trip_ended ─── */
socket.on('trip_ended', data => {
  if (data.amb_id === APP.ambId) {
    toast('✅ Trip ended — server confirmed');
    APP.routeId = '';
  }
});

/* ─── priority_change ─── */
socket.on('priority_change', data => {
  if (data.amb_id === APP.ambId && data.priority) {
    const uiP = PRIO_MAP_REV[data.priority] || 'critical';
    APP.priority = uiP;
    const idMap  = { critical: 'pCrit', urgent: 'pUrg', routine: 'pRout' };
    document.querySelectorAll('.pBtn').forEach(b => b.classList.remove('on'));
    document.getElementById(idMap[uiP])?.classList.add('on');
  }
});

/* ─── Browser online / offline ─── */
window.addEventListener('online',  () => { if (!socket.connected) setConnPill(true); });
window.addEventListener('offline', () => { setConnPill(false); toast('🔴 Network lost — offline mode'); });

/* ════════════════════════════════════════
   HOME STATS  (from server)
════════════════════════════════════════ */
function updateHomeStats(stats) {
  if (!stats) return;
  const sClear = document.getElementById('homeClearedVal');
  if (sClear && (stats.intersections_cleared != null || stats.total_overrides != null))
    sClear.textContent = stats.intersections_cleared ?? stats.total_overrides ?? 0;

  const sSaved = document.getElementById('homeSavedVal');
  if (sSaved && stats.time_saved_str) sSaved.textContent = stats.time_saved_str;

  const sTrips = document.getElementById('homeTripsVal');
  if (sTrips && stats.total_trips != null) sTrips.textContent = stats.total_trips;
}

/* ════════════════════════════════════════
   BANNER UPDATE  (from server analytics)
════════════════════════════════════════ */
function updateBannerFromServer(intersections) {
  if (!intersections?.length) return;

  const over   = intersections.find(i => i.state === 'OVERRIDE');
  const target = over || intersections[0];
  if (!target) return;

  const banner  = document.getElementById('intBanner');
  const bStatus = document.getElementById('bStatus');
  const bName   = document.getElementById('bName');
  const bDist   = document.getElementById('bDist');
  if (!banner || !bStatus || !bName) return;

  const formatDist = val => {
    if (val == null || !bDist) return;
    const unitEl = bDist.nextElementSibling;
    if (val > 999) {
      bDist.textContent = (val / 1000).toFixed(1);
      if (unitEl?.classList.contains('distUnit')) unitEl.textContent = ' km';
    } else {
      bDist.textContent = val;
      if (unitEl?.classList.contains('distUnit')) unitEl.textContent = ' m';
    }
  };

  if (over) {
    banner.dataset.serverControlled = '1';
    banner.className   = 'intBanner clearing';
    bStatus.textContent = '🔴 CLEARING';

    const seqT   = APP._routeIntIds ? (APP._routeIntIds.indexOf(target.id) + 1) : 0;
    const prefix = seqT > 0 ? 'Junction ' + seqT : target.id;
    bName.textContent = prefix + ' · ' + (target.name || 'Junction');
    formatDist(target.distance);

    const bEta = document.getElementById('bEta');
    if (bEta && target.override_duration) bEta.textContent = 'Override: ' + target.override_duration + 's';
  } else {
    banner.dataset.serverControlled = '1';
    const nearest = intersections.reduce((a, b) => ((a.distance || 9999) < (b.distance || 9999) ? a : b));
    banner.className    = 'intBanner approaching';
    bStatus.textContent = '⬤ APPROACHING';

    const seqN   = APP._routeIntIds ? (APP._routeIntIds.indexOf(nearest.id) + 1) : 0;
    const prefix = seqN > 0 ? 'Junction ' + seqN : nearest.id;
    bName.textContent = prefix + ' · ' + (nearest.name || 'Junction');
    formatDist(nearest.distance);
  }
}
