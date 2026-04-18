/**
 * auth.js — NavPath Ambulance v4
 * Login, signup, logout, forgot-password, and user profile application.
 * Depends on: app.js, ui.js
 */

/* ─── Tab switcher ─── */
function switchTab(t) {
  document.getElementById('aTabLogin').classList.toggle('on', t === 'login');
  document.getElementById('aTabSignup').classList.toggle('on', t === 'signup');
  document.getElementById('fLogin').classList.toggle('on', t === 'login');
  document.getElementById('fSignup').classList.toggle('on', t === 'signup');
}

/* ─── Password visibility toggle ─── */
function togglePw(id, btn) {
  const f = document.getElementById(id);
  f.type = f.type === 'text' ? 'password' : 'text';
  btn.style.color = f.type === 'text' ? 'var(--cyan)' : 'var(--txt3)';
}

/* ─── Error helpers ─── */
function showErr(el, msg) { el.style.display = 'block'; el.textContent = msg; }
function hideErr(el)      { el.style.display = 'none'; }

/* ─── Login ─── */
function doLogin() {
  const id  = document.getElementById('lId').value.trim();
  const pw  = document.getElementById('lPw').value;
  const err = document.getElementById('lErr');
  hideErr(err);
  if (!id || !pw) { showErr(err, 'Enter Driver ID and password.'); return; }
  const u = DB.find(id, pw);
  if (!u) { showErr(err, 'Invalid Driver ID or password.'); return; }
  APP.user = u;
  applyUser(u);
  goTo('sHome');
  startGPS();
}

/* ─── Signup ─── */
function doSignup() {
  const fn   = document.getElementById('sFn').value.trim();
  const ln   = document.getElementById('sLn').value.trim();
  const id   = document.getElementById('sId').value.trim().toUpperCase();
  const amb  = document.getElementById('sAmb').value.trim().toUpperCase();
  const hosp = document.getElementById('sHosp').value;
  const pw   = document.getElementById('sPw').value;
  const pw2  = document.getElementById('sPw2').value;
  const err  = document.getElementById('sErr');
  hideErr(err);
  if (!fn || !ln || !id || !amb || !hosp || !pw || !pw2) { showErr(err, 'All fields are required.'); return; }
  if (pw.length < 6) { showErr(err, 'Password must be at least 6 characters.'); return; }
  if (pw !== pw2)    { showErr(err, 'Passwords do not match.'); return; }
  if (DB.has(id))    { showErr(err, 'Driver ID already registered.'); return; }
  const u = { id, pw, fn, ln, amb, hosp };
  DB.add(u);
  APP.user = u;
  applyUser(u);
  goTo('sHome');
  startGPS();
  toast('✅ Welcome, ' + fn + '! Account created.');
}

/* ─── Logout ─── */
function doLogout() {
  stopGpsLoop();
  if (APP.watcher != null) { navigator.geolocation.clearWatch(APP.watcher); APP.watcher = null; }
  clearInterval(APP.navTimer);
  if (APP.routeId) {
    fetch(SERVER_URL + '/api/end_trip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ amb_id: APP.ambId }),
    }).catch(() => {});
  }
  APP.user = null; APP.gps = null; APP.homeMap = null; APP.navMap = null;
  APP.navDestName = null; APP.navDestCoord = null; APP.nearbyResults = [];
  APP.routeId = ''; APP.serverRoutes = [];
  placesService = null;
  goTo('sLogin');
  toast('Logged out');
}

/* ─── Apply user profile to all UI elements ─── */
function applyUser(u) {
  const full = u.fn + ' ' + u.ln;
  const init = (u.fn[0] || '') + (u.ln[0] || '');

  document.getElementById('hName').textContent    = full;
  document.getElementById('hAmb').textContent     = u.amb + ' · ' + u.hosp;
  document.getElementById('setName').textContent  = full;
  document.getElementById('setId').textContent    = 'ID: ' + u.id;
  document.getElementById('setHosp').textContent  = u.hosp;
  document.getElementById('setAmb').textContent   = u.amb + ' · NavPath v4.0';
  document.getElementById('setAvatar').textContent = init.toUpperCase();

  APP.shiftStart = new Date();
  APP.ambId      = u.amb || 'AMB-2026';
  u.trips        = u.trips || [];

  // Strip corrupt legacy entries (time saved > ~166 hours without a valid numeric field)
  u.trips = u.trips.filter(t => {
    if (typeof t.timeSavedSec === 'number' && isFinite(t.timeSavedSec)) return true;
    if (!t.timeSavedStr) return true;
    const mM = t.timeSavedStr.match(/(\d+)m/);
    return !(mM && parseInt(mM[1]) > 9999);
  });

  // Back-fill numeric field for legacy trips that only have a string
  u.trips.forEach(t => {
    if (typeof t.timeSavedSec !== 'number' && t.timeSavedStr) {
      const mM = t.timeSavedStr.match(/(\d{1,4})m/);
      const sM = t.timeSavedStr.match(/(\d{1,2})s/);
      t.timeSavedSec = (mM ? parseInt(mM[1]) * 60 : 0) + (sM ? parseInt(sM[1]) : 0);
    }
  });

  const all = DB.get();
  const idx = all.findIndex(x => x.id === u.id);
  if (idx >= 0) { all[idx] = u; DB.save(all); }

  renderTrips(u);
  updateHomeTripStats(u);
}

/* ════════════════════════════════════════
   FORGOT PASSWORD FLOW
════════════════════════════════════════ */
let _fpUser = null;

function openForgot() {
  _fpUser = null;
  ['fpId', 'fpPw1', 'fpPw2'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  ['fpErr1', 'fpErr2'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  fpGoStep(1);
  document.getElementById('fpModal').classList.add('show');
}

function closeForgot() {
  document.getElementById('fpModal').classList.remove('show');
  _fpUser = null;
}

function fpGoStep(n) {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById('fpStep' + i);
    if (el) el.className = 'fpStep' + (i === n ? ' on' : '');
  });
}

function fpFindUser() {
  const id  = document.getElementById('fpId').value.trim().toUpperCase();
  const err = document.getElementById('fpErr1');
  err.style.display = 'none';
  if (!id) { showErr(err, 'Please enter your Driver ID.'); return; }
  const u = DB.get().find(u => u.id.toUpperCase() === id);
  if (!u) { showErr(err, 'No account found with that Driver ID.'); return; }
  _fpUser = u;
  document.getElementById('fpUserName').textContent = u.fn + ' ' + u.ln;
  document.getElementById('fpUserId').textContent   = 'ID: ' + u.id + ' · ' + u.hosp;
  fpGoStep(2);
}

function fpResetPw() {
  const pw1 = document.getElementById('fpPw1').value;
  const pw2 = document.getElementById('fpPw2').value;
  const err = document.getElementById('fpErr2');
  err.style.display = 'none';
  if (!pw1 || !pw2)  { showErr(err, 'Please fill in both password fields.'); return; }
  if (pw1.length < 6){ showErr(err, 'Password must be at least 6 characters.'); return; }
  if (pw1 !== pw2)   { showErr(err, 'Passwords do not match.'); return; }
  if (!_fpUser)      { fpGoStep(1); return; }

  const all = DB.get();
  const idx = all.findIndex(u => u.id.toUpperCase() === _fpUser.id.toUpperCase());
  if (idx >= 0) { all[idx].pw = pw1; DB.save(all); }
  fpGoStep(3);
}
