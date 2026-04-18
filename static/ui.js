/**
 * ui.js — NavPath Ambulance v4
 * Screen routing, toast, duty toggle, clock, trip history,
 * SOS, speed, battery, theme, and settings UI.
 * Depends on: app.js
 */

/* ─── Screen Router ─── */

const SCREEN_TO_NAV = {
  sHome:     'nbH',
  sRoute:    'nbR',
  sNav:      'nbN',
  sComplete: 'nbC',
  sSettings: 'nbS',
};

function goTo(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  document.querySelectorAll('.nb').forEach(b => b.classList.remove('active'));
  if (SCREEN_TO_NAV[id]) document.getElementById(SCREEN_TO_NAV[id]).classList.add('active');

  document.getElementById('navBar').style.display = id === 'sLogin' ? 'none' : 'flex';

  if (id === 'sHome') {
    initHomeMap();
    fetchBattery();
    const fromEl = document.getElementById('rFrom');
    if (fromEl) fromEl.textContent = document.getElementById('addrTxt')?.textContent || 'Current Location';
    stopGpsLoop();
  }

  if (id === 'sNav') {
    APP.tripStart = new Date();
    initNavMap();
    startNavTimer();
    startGpsLoop();
  }

  if (id === 'sRoute') {
    document.getElementById('dispTime').textContent = now12();
    const fromEl = document.getElementById('rFrom');
    if (fromEl && APP.gps) fromEl.textContent = document.getElementById('addrTxt')?.textContent || 'Current Location';
    populateServerRoutes();
    if (APP.gps) fetchNearbyHospitals(APP.gps.lat, APP.gps.lng);
    else if (APP.gpsMode === 'sim') fetchNearbyHospitals(28.5672, 77.2100);
  }

  if (id === 'sComplete') {
    stopGpsLoop();
    const destName = APP.navDestName || 'Hospital';
    document.getElementById('compSub').textContent   = destName.toUpperCase() + ' · ' + now12();
    document.getElementById('compTitle').textContent = '🏥 Arrived at ' + destName;

    // Trip time
    let tripSec = 0;
    if (APP.tripStart) {
      tripSec = Math.round((new Date() - APP.tripStart) / 1000);
      const m = Math.floor(tripSec / 60), s = tripSec % 60;
      const el = document.getElementById('compTripTime');
      if (el) el.textContent = m + 'm ' + (s < 10 ? '0' : '') + s + 's';
    }

    // Intersections cleared
    const clrEl = document.getElementById('compCleared');
    if (clrEl) {
      const srvCleared  = APP.serverStats?.intersections_cleared;
      const stepCleared = APP._navSteps ? Math.max(0, APP._navSteps.length - 2) : 0;
      clrEl.textContent = (typeof srvCleared === 'number' && srvCleared > 0) ? srvCleared : stepCleared;
    }

    // Distance
    const distEl = document.getElementById('compDist');
    if (distEl) {
      if (APP.navTotalDist > 0) {
        distEl.textContent = (APP.navTotalDist / 1000).toFixed(1);
      } else if (APP.navTotalSec > 0) {
        distEl.textContent = ((APP.navTotalSec / 3600) * 40).toFixed(1);
      } else {
        distEl.textContent = '–';
      }
    }

    // Time saved
    const savedEl = document.getElementById('compSaved');
    if (savedEl) {
      const rawSaved = Math.max(0, Math.min((APP.navTotalSec || 0) - tripSec, 7200));
      const sm = Math.floor(rawSaved / 60), ss = rawSaved % 60;
      savedEl.textContent = rawSaved > 0
        ? '+' + sm + 'm ' + (ss < 10 ? '0' : '') + ss + 's'
        : 'Great drive!';
    }

    rateStar(0);
  }
}

/* ─── Emergency start guard ─── */
function startEmergency() {
  if (!APP.duty) {
    toast('🔴 Switch to On Duty before starting a trip!');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    const tog = document.getElementById('dutyTog');
    if (tog) {
      tog.style.boxShadow = '0 0 18px var(--red-glow)';
      setTimeout(() => tog.style.boxShadow = '', 1200);
    }
    return;
  }
  goTo('sRoute');
}

/* ─── Clear navigation state ─── */
function clearNavState() {
  APP.routeId           = '';
  APP.navRoute          = null;
  APP.navDestName       = null;
  APP.navDestCoord      = null;
  APP._pendingDirectionsResult = null;
  APP._navSteps         = null;
  APP.navProgress       = 0;
  APP.navTotalDist      = 0;

  const rpFill   = document.getElementById('rpFill');
  const rpLabel  = document.getElementById('rpLabel');
  const bDist    = document.getElementById('bDist');
  const bEta     = document.getElementById('bEta');
  const bStatus  = document.getElementById('bStatus');
  const bName    = document.getElementById('bName');
  const banner   = document.getElementById('intBanner');
  const navDot   = document.getElementById('navDot');
  const srvSel   = document.getElementById('srvRouteSel');
  const rList    = document.getElementById('routeIntList');

  if (rpFill)  rpFill.style.width    = '0%';
  if (rpLabel) rpLabel.textContent   = '0%';
  if (bDist)   bDist.textContent     = '–';
  if (bEta)    bEta.textContent      = '';
  if (bStatus) bStatus.textContent   = '⬤  APPROACHING';
  if (bName)   bName.textContent     = 'Calculating route…';
  if (banner)  { banner.className    = 'intBanner approaching'; delete banner.dataset.serverControlled; }
  if (navDot)  navDot.classList.remove('show');
  if (srvSel)  srvSel.value          = '';
  if (rList)   rList.innerHTML       = '<div style="padding:12px;font-family:var(--fM);font-size:10px;color:var(--txt3);text-align:center">Select a NavPath Route above to see intersections</div>';

  if (APP.navPolyline) APP.navPolyline.setLatLngs([]);
  if (APP.navMap && APP._routeMarkers) {
    APP._routeMarkers.forEach(m => APP.navMap.removeLayer(m));
  }
  APP._routeMarkers = [];
}

/* ─── Toast ─── */
let _toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ─── Trip persistence ─── */
function saveTripToHistory() {
  if (!APP.user) return;
  APP.user.trips = APP.user.trips || [];

  let tripSec = 0, durStr = '0m';
  if (APP.tripStart) {
    tripSec = Math.round((new Date() - APP.tripStart) / 1000);
    const m = Math.floor(tripSec / 60), s = tripSec % 60;
    durStr = m + 'm ' + s + 's';
  }

  const totalInts    = APP._navSteps ? Math.max(0, APP._navSteps.length - 2) : 0;
  const rawSaved     = (APP.navTotalSec || 0) - tripSec;
  const savedSec     = Math.max(0, Math.min(rawSaved, 7200));
  const savedMin     = Math.floor(savedSec / 60);
  const savedS       = savedSec % 60;
  const timeSavedStr = savedMin > 0 ? ('+' + savedMin + 'm ' + savedS + 's') : (savedSec > 0 ? ('+' + savedS + 's') : '0s');

  const sf = document.getElementById('rFrom');
  const st = document.getElementById('rTo');
  const rtName = (sf?.textContent?.split(',')[0] || 'Unknown') + ' → ' + (st?.textContent || APP.navDestName || 'Destination');

  APP.user.trips.push({
    dateStr:      'Today ' + now12(),
    routeName:    rtName,
    durationStr:  durStr,
    clearCount:   totalInts,
    timeSavedSec: savedSec,
    timeSavedStr: timeSavedStr,
  });

  const all = DB.get();
  const idx = all.findIndex(u => u.id === APP.user.id);
  if (idx >= 0) { all[idx] = APP.user; DB.save(all); }

  renderTrips(APP.user);
  updateHomeTripStats(APP.user);
  APP.tripStart = null;
}

function finishTrip() {
  saveTripToHistory();
  clearNavState();
  goTo('sHome');
  toast('✅ Trip saved to history');
}

function startReturnTrip() {
  saveTripToHistory();
  clearNavState();
  goTo('sRoute');
}

function renderTrips(u) {
  const tb   = document.getElementById('tripBody');
  const chev = document.getElementById('tripChev');
  if (!tb || !chev) return;
  const countLbl = chev.previousElementSibling;

  if (!u.trips || !u.trips.length) {
    tb.innerHTML = '<div style="padding:15px;text-align:center;color:var(--txt3);font-size:12px">No trips yet</div>';
    if (countLbl) countLbl.textContent = '0 trips';
    return;
  }

  const sorted = u.trips.slice().reverse();
  if (countLbl) countLbl.textContent = sorted.length + ' trips';

  tb.innerHTML = sorted.map(t => `
    <div class="tripItem">
      <div class="tripBadge">🚑</div>
      <div class="tripI">
        <div class="tr">${t.routeName}</div>
        <div class="td">${t.dateStr} · ${t.durationStr} · ${t.clearCount} junctions</div>
      </div>
      ${t.timeSavedStr ? `<div class="tripSave">${t.timeSavedStr}</div>` : ''}
    </div>
  `).join('');
}

function updateHomeTripStats(u) {
  if (!u || !u.trips) return;
  const MAX_PER_TRIP = 7200;

  const tripsEl   = document.getElementById('homeTripsVal');
  const clearedEl = document.getElementById('homeClearedVal');
  const savedEl   = document.getElementById('homeSavedVal');

  if (tripsEl) tripsEl.textContent = u.trips.length;

  const cleared = u.trips.reduce((sum, t) => sum + (parseInt(t.clearCount) || 0), 0);
  if (clearedEl) clearedEl.textContent = cleared;

  let totalSavedSec = 0;
  u.trips.forEach(t => {
    if (typeof t.timeSavedSec === 'number' && isFinite(t.timeSavedSec)) {
      totalSavedSec += Math.min(Math.max(0, t.timeSavedSec), MAX_PER_TRIP);
    } else if (t.timeSavedStr) {
      const mM = t.timeSavedStr.match(/(\d{1,4})m/);
      const sM = t.timeSavedStr.match(/(\d{1,2})s/);
      const parsed = (mM ? parseInt(mM[1]) * 60 : 0) + (sM ? parseInt(sM[1]) : 0);
      if (parsed <= MAX_PER_TRIP) totalSavedSec += parsed;
    }
  });

  const totalMin = Math.floor(totalSavedSec / 60);
  if (savedEl) savedEl.textContent = totalMin > 0 ? totalMin + 'm' : totalSavedSec + 's';
}

/* ─── Abort / End Trip ─── */
function abortTrip() {
  if (!confirm('Are you sure you want to end this trip?')) return;
  clearInterval(APP.navTimer);
  APP.navTimer = null;
  APP._navTimerRunning = false;
  stopGpsLoop();

  if (APP.routeId) {
    fetch(SERVER_URL + '/api/end_trip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ amb_id: APP.ambId }),
    }).then(() => { APP.routeId = ''; }).catch(e => console.warn('end_trip failed', e));
  }

  if (APP.tripStart && APP.user) saveTripToHistory();
  else APP.tripStart = null;

  clearNavState();
  goTo('sHome');
  toast('Trip ended');
}

/* ─── Duty Toggle ─── */
function toggleDuty() {
  APP.duty = !APP.duty;
  document.getElementById('dutyTog').classList.toggle('on', APP.duty);
  document.getElementById('dutyLbl').textContent = APP.duty ? 'On Duty' : 'Off Duty';
  if (APP.duty) APP.shiftStart = new Date();
  toast(APP.duty ? '🟢 On Duty' : '🔴 Off Duty');
}

/* ─── Clock & Shift Timer ─── */
function tickClock() {
  const now = new Date();
  document.getElementById('liveClock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  document.getElementById('liveDate').textContent  = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();

  if (APP.shiftStart && APP.duty) {
    const diff = Math.floor((now - APP.shiftStart) / 1000);
    const h = Math.floor(diff / 3600), m = Math.floor((diff % 3600) / 60), s = diff % 60;
    document.getElementById('shiftElapsed').textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    document.getElementById('dutyTime').textContent = 'Shift started ' + APP.shiftStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
setInterval(tickClock, 1000);
tickClock();

/* ─── Trip History Accordion ─── */
function toggleTrips() {
  const b = document.getElementById('tripBody');
  const c = document.getElementById('tripChev');
  b.classList.toggle('open');
  c.style.transform = b.classList.contains('open') ? 'rotate(180deg)' : 'none';
}

/* ─── SOS ─── */
function doSOS() {
  document.getElementById('sosModal').classList.add('show');
  APP.sosCount = 3;
  document.getElementById('sosCnt').textContent = 3;
  APP.sosTimer = setInterval(() => {
    APP.sosCount--;
    document.getElementById('sosCnt').textContent = APP.sosCount;
    if (APP.sosCount <= 0) { clearInterval(APP.sosTimer); confirmSOS(); }
  }, 1000);
}
function cancelSOS() {
  clearInterval(APP.sosTimer);
  document.getElementById('sosModal').classList.remove('show');
}
function confirmSOS() {
  clearInterval(APP.sosTimer);
  document.getElementById('sosModal').classList.remove('show');
  toast('🚨 SOS SENT — All units notified');
  if (!APP.muted) speak('S.O.S. activated. Connecting to dispatch now.');
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);

  fetch(SERVER_URL + '/api/sos', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ amb_id: APP.ambId, lat: APP.gps?.lat, lon: APP.gps?.lng }),
  }).catch(e => console.warn('SOS delivery failed', e));
}

/* ─── Mute ─── */
function toggleMute() {
  APP.muted = !APP.muted;
  document.getElementById('muteBtn').classList.toggle('muted', APP.muted);
  toast(APP.muted ? '🔇 Audio muted' : '🔊 Audio on');
}

/* ─── Speed display ─── */
function updateSpeed(kmh) {
  document.getElementById('statSpd').textContent = kmh;
  document.getElementById('navSpd').textContent  = kmh;
  const pct    = Math.min(kmh / 120, 1);
  const offset = 163 - (pct * 163);
  const fill   = document.getElementById('spFill');
  fill.style.strokeDashoffset = offset;
  fill.style.stroke = kmh > 80 ? 'var(--red)' : kmh > 50 ? 'var(--yellow)' : 'var(--cyan)';
}

/* ─── Battery ─── */
function fetchBattery() {
  const valEl  = document.getElementById('batVal');
  const fillEl = document.getElementById('batFill');
  if (!valEl || !fillEl) return;
  if (!navigator.getBattery) { valEl.textContent = 'N/A'; return; }
  navigator.getBattery().then(b => {
    const update = () => {
      const pct = Math.round(b.level * 100);
      const col = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--yellow)' : 'var(--red)';
      valEl.textContent       = pct + '%';
      valEl.style.color       = col;
      fillEl.style.width      = pct + '%';
      fillEl.style.background = col;
      if (pct < 20) toast('🔋 Low battery: ' + pct + '%');
    };
    update();
    b.addEventListener('levelchange',    update);
    b.addEventListener('chargingchange', update);
  });
}

/* ─── Priority buttons ─── */
function setPrio(p) {
  APP.priority = p;
  ['pCrit', 'pUrg', 'pRout'].forEach(id => document.getElementById(id).classList.remove('on'));
  const idMap = { critical: 'pCrit', urgent: 'pUrg', routine: 'pRout' };
  document.getElementById(idMap[p]).classList.add('on');
  const msgs = { critical: '🔴 CRITICAL priority active', urgent: '🟡 URGENT priority active', routine: '🟢 ROUTINE priority active' };
  toast(msgs[p]);
  if (!APP.muted) speak(p + ' priority set.');

  fetch(SERVER_URL + '/api/set_priority', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ amb_id: APP.ambId, priority: PRIO_MAP[p] || 'RED' }),
  }).catch(e => console.warn('set_priority failed', e));
}

/* ─── Theme toggle ─── */
function toggleTheme(el) {
  if (el) { const tog = el.querySelector('.tog'); if (tog) tog.classList.toggle('on'); }
  const isLight = document.documentElement.classList.toggle('light-mode');
  const lbl = document.getElementById('themeLbl');
  if (lbl) lbl.textContent = isLight ? 'LIGHT' : 'DARK';
  if (APP.homeMap) APP.homeMap.setOptions({ styles: isLight ? MAP_STYLE_LIGHT : MAP_STYLE_DARK });
  toast(isLight ? '🔆 Light mode activated' : '🌙 Night mode activated');
}

/* ─── Trip rating ─── */
function rateStar(n) {
  const labels = ['', 'Poor', 'Average', 'Good', 'Great', 'Excellent!'];
  document.querySelectorAll('.star').forEach(s => {
    const v = parseInt(s.dataset.v);
    s.style.filter    = v <= n ? 'none' : 'grayscale(1)';
    s.style.color     = v <= n ? '#ffd43b' : 'var(--txt3)';
    s.style.transform = v <= n ? 'scale(1.15)' : 'scale(1)';
  });
  const txt = document.getElementById('ratingTxt');
  if (txt) txt.textContent = n ? labels[n] + ' — Thank you!' : '';
  if (n) toast('⭐ ' + labels[n] + ' trip rating submitted!');
}

/* ─── Wake lock (keep screen on during navigation) ─── */
async function keepOn() {
  if ('wakeLock' in navigator) {
    try { await navigator.wakeLock.request('screen'); } catch (e) {}
  }
}
