/**
 * app.js — NavPath Ambulance v4
 * Core application state, constants, and local database.
 * All other modules depend on this file — load it first.
 */

/* ─── Server URL ─── */
const SERVER_URL = (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
) ? 'http://localhost:5000' : window.location.origin;

/* ─── Application State ─── */
const APP = {
  // User session
  user:             null,

  // GPS
  gps:              null,       // { lat, lng, accuracy, speed, heading }
  gpsMode:          'none',     // 'real' | 'sim' | 'none'
  watcher:          null,

  // UI
  muted:            false,
  duty:             true,
  shiftStart:       new Date(),
  priority:         'critical',

  // Navigation
  bannerIdx:        0,
  navEtaSec:        574,
  navTimer:         null,
  navProgress:      0,
  navTotalDist:     0,
  navTotalSec:      0,
  _navTimerRunning: false,

  // Maps
  homeMap:          null,
  navMap:           null,
  homeMarker:       null,
  homeAccCircle:    null,
  navMarker:        null,
  navPolyline:      null,
  navRoute:         null,       // array of {lat,lng} from route API
  navDestName:      null,
  navDestCoord:     null,
  dirRenderer:      null,
  _routeMarkers:    [],

  // Route & steps
  _navSteps:        null,
  _stepNames:       null,
  _pendingDirectionsResult: null,
  _srvIntMap:       null,
  _routeIntIds:     null,

  // SOS
  sosTimer:         null,
  sosCount:         3,

  // Geocoding cache
  addressCache:     {},
  lastGeocodeCoord: null,

  // Toast
  toastTimer:       null,

  // Hospital search
  nearbyResults:    [],

  // Server integration
  ambId:            'AMB-2026',
  routeId:          '',
  serverRoutes:     [],
  serverStats:      {},
  gpsInterval:      null,

  // Trip
  tripStart:        null,
};

/* ─── Priority Maps ─── */
const PRIO_MAP     = { critical: 'RED', urgent: 'YELLOW', routine: 'GREEN' };
const PRIO_MAP_REV = { RED: 'critical', YELLOW: 'urgent', GREEN: 'routine', NONE: 'routine' };

/* ─── Banner Cycle Data ─── */
const BANNERS = [
  { cls: 'clearing',   status: '🔴  CLEARING',              name: 'INT-1 · Mathura Road Junction' },
  { cls: 'clear',      status: '🟢  CLEAR — Drive Through',  name: 'INT-1 · Mathura Road Junction' },
  { cls: 'approaching',status: '⬤  APPROACHING',             name: 'INT-2 · Ring Road Crossing'   },
  { cls: 'clearing',   status: '🔴  CLEARING',              name: 'INT-2 · Ring Road Crossing'   },
  { cls: 'clear',      status: '🟢  CLEAR — Drive Through',  name: 'INT-2 · Ring Road Crossing'   },
  { cls: 'approaching',status: '⬤  APPROACHING',             name: 'INT-3 · IIT Flyover Signal'   },
  { cls: 'clearing',   status: '🔴  CLEARING',              name: 'INT-3 · IIT Flyover Signal'   },
  { cls: 'clear',      status: '🟢  CLEAR — Drive Through',  name: 'INT-3 · IIT Flyover Signal'   },
];

/* ─── Google Maps Dark Style ─── */
const MAP_STYLE_DARK = [
  { elementType: 'geometry',                stylers: [{ color: '#0e1318' }] },
  { elementType: 'labels.text.stroke',      stylers: [{ color: '#0e1318' }] },
  { elementType: 'labels.text.fill',        stylers: [{ color: '#8899aa' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill',  stylers: [{ color: '#4dabf7' }] },
  { featureType: 'poi',                     elementType: 'labels.text.fill',  stylers: [{ color: '#445566' }] },
  { featureType: 'poi.park',                elementType: 'geometry',           stylers: [{ color: '#141a22' }] },
  { featureType: 'poi.park',                elementType: 'labels.text.fill',  stylers: [{ color: '#28344a' }] },
  { featureType: 'road',                    elementType: 'geometry',           stylers: [{ color: '#1e2736' }] },
  { featureType: 'road',                    elementType: 'geometry.stroke',    stylers: [{ color: '#28344a' }] },
  { featureType: 'road',                    elementType: 'labels.text.fill',  stylers: [{ color: '#8899aa' }] },
  { featureType: 'road.highway',            elementType: 'geometry',           stylers: [{ color: '#2e3f55' }] },
  { featureType: 'road.highway',            elementType: 'geometry.stroke',    stylers: [{ color: '#1e2736' }] },
  { featureType: 'road.highway',            elementType: 'labels.text.fill',  stylers: [{ color: '#edf2f7' }] },
  { featureType: 'transit',                 elementType: 'geometry',           stylers: [{ color: '#1b2333' }] },
  { featureType: 'transit.station',         elementType: 'labels.text.fill',  stylers: [{ color: '#4dabf7' }] },
  { featureType: 'water',                   elementType: 'geometry',           stylers: [{ color: '#07090d' }] },
  { featureType: 'water',                   elementType: 'labels.text.fill',  stylers: [{ color: '#28344a' }] },
  { featureType: 'water',                   elementType: 'labels.text.stroke', stylers: [{ color: '#07090d' }] },
];

const MAP_STYLE_LIGHT = [];

/* ─── Local Database (localStorage) ─── */
const DB = {
  get()        { try { return JSON.parse(localStorage.getItem('np_v4') || '[]'); } catch { return []; } },
  save(arr)    { localStorage.setItem('np_v4', JSON.stringify(arr)); },
  find(id, pw) { return this.get().find(u => u.id.toUpperCase() === id.toUpperCase() && u.pw === pw); },
  has(id)      { return !!this.get().find(u => u.id.toUpperCase() === id.toUpperCase()); },
  add(u)       { const all = this.get(); all.push(u); this.save(all); },
};

// Seed demo account on first visit
if (!DB.has('DRV-2047')) {
  DB.add({ id: 'DRV-2047', pw: 'demo1234', fn: 'Rajesh', ln: 'Kumar', amb: 'DL-AMB-0047', hosp: 'AIIMS Trauma Centre' });
}

/* ─── Utility Helpers ─── */
function pad(n) { return n < 10 ? '0' + n : n; }
function now12() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

/**
 * Clean ETA formatter — no floating-point artefacts.
 * @param {number} seconds
 * @returns {string} e.g. "4m 07s"
 */
window.fmtEta = function (seconds) {
  if (!seconds || seconds <= 0) return '0m 00s';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + 'm ' + (s < 10 ? '0' : '') + s + 's';
};
