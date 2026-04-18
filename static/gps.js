/**
 * gps.js — NavPath Ambulance v4
 * Device GPS acquisition, simulation mode, reverse geocoding
 * (Google Geocoder + Nominatim fallback), and GPS POST loop.
 * Depends on: app.js, ui.js
 */

/* ─── Start real GPS watch ─── */
function startGPS() {
  if (!navigator.geolocation) {
    toast('GPS not supported on this device');
    useSim();
    return;
  }
  document.getElementById('mapLoading').style.display = 'flex';
  document.getElementById('mapLoadTxt').textContent   = 'ACQUIRING GPS SIGNAL...';
  setGPSDot('searching');

  APP.watcher = navigator.geolocation.watchPosition(
    onGPSSuccess,
    onGPSError,
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
}

function onGPSSuccess(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
  APP.gps     = { lat, lng, accuracy: Math.round(accuracy), speed, heading };
  APP.gpsMode = 'real';

  document.getElementById('mapLoading').style.display = 'none';
  document.getElementById('gpsDenied').style.display  = 'none';
  setGPSDot('real');

  document.getElementById('gpsAcc').textContent    = '±' + Math.round(accuracy) + 'm';
  document.getElementById('gpsSetSub').textContent  = lat.toFixed(5) + ', ' + lng.toFixed(5);

  const kmh = speed != null ? Math.round(speed * 3.6) : 0;
  updateSpeed(kmh);

  reverseGeocode(lat, lng);
  fetchNearbyHospitals(lat, lng);
  updateMapMarkers(lat, lng, accuracy);
}

function onGPSError(err) {
  document.getElementById('mapLoading').style.display = 'none';
  setGPSDot('sim');
  if (err.code === err.PERMISSION_DENIED) {
    document.getElementById('gpsDenied').style.display = 'flex';
    document.getElementById('addrTxt').textContent     = 'Location denied';
    toast('📍 Location permission denied');
  } else if (err.code === err.TIMEOUT) {
    toast('📍 GPS timeout — retrying…');
    setTimeout(retryGPS, 2000);
  } else {
    useSim();
    toast('📍 GPS unavailable — simulation mode');
  }
}

function retryGPS() {
  document.getElementById('gpsDenied').style.display  = 'none';
  document.getElementById('mapLoading').style.display = 'flex';
  document.getElementById('mapLoadTxt').textContent   = 'RETRYING GPS...';
  setGPSDot('searching');
  if (APP.watcher != null) { navigator.geolocation.clearWatch(APP.watcher); APP.watcher = null; }
  setTimeout(startGPS, 300);
}

/* ─── Simulation fallback (AIIMS New Delhi) ─── */
function useSim() {
  document.getElementById('mapLoading').style.display = 'none';
  document.getElementById('gpsDenied').style.display  = 'none';
  APP.gps     = { lat: 28.5672, lng: 77.2100, accuracy: 15 };
  APP.gpsMode = 'sim';
  setGPSDot('sim');
  document.getElementById('gpsAcc').textContent  = 'SIM';
  document.getElementById('addrTxt').textContent = 'AIIMS, New Delhi (Simulation)';
  updateMapMarkers(28.5672, 77.2100, 15);
  toast('📍 Simulation mode — using AIIMS, Delhi');
}

function setGPSDot(mode) {
  const d = document.getElementById('gpsDot');
  d.className = 'gpsDot ' + mode;
}

/* ─── GPS POST loop (sends live position to server every second) ─── */
function startGpsLoop() {
  stopGpsLoop();
  APP.gpsInterval = setInterval(sendGpsUpdate, 1000);
  console.log('[NavPath] GPS POST loop started');
}

function stopGpsLoop() {
  if (APP.gpsInterval) { clearInterval(APP.gpsInterval); APP.gpsInterval = null; }
}

function sendGpsUpdate() {
  if (!APP.gps) return;
  const speed = APP.gps.speed != null
    ? APP.gps.speed * 3.6
    : (APP.gpsMode === 'sim' ? 45 + Math.floor(Math.random() * 20) : 0);

  fetch(SERVER_URL + '/api/gps', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      amb_id:   APP.ambId,
      lat:      APP.gps.lat,
      lon:      APP.gps.lng,
      speed:    Math.round(speed),
      priority: PRIO_MAP[APP.priority] || 'RED',
      route_id: APP.routeId || '',
    }),
  }).catch(e => console.warn('[NavPath] GPS POST failed', e));
}

/* ════════════════════════════════════════
   REVERSE GEOCODING
════════════════════════════════════════ */
let geocoder       = null;
let geocodeTimer   = null;

function reverseGeocode(lat, lng) {
  if (!geocoder && window.google) geocoder = new google.maps.Geocoder();

  // Skip if moved less than 30 m since last successful geocode
  if (APP.lastGeocodeCoord && window.google) {
    const p1 = new google.maps.LatLng(lat, lng);
    const p2 = new google.maps.LatLng(APP.lastGeocodeCoord.lat, APP.lastGeocodeCoord.lng);
    if (google.maps.geometry.spherical.computeDistanceBetween(p1, p2) < 30) return;
  }
  APP.lastGeocodeCoord = { lat, lng };

  const key = lat.toFixed(3) + ',' + lng.toFixed(3);
  if (APP.addressCache[key]) { setAddress(APP.addressCache[key]); return; }

  setAddress('Fetching address…');
  clearTimeout(geocodeTimer);
  geocodeTimer = setTimeout(() => {
    if (geocoder) {
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status === 'OK' && results[0]) {
          let parts = results[0].formatted_address.split(',');
          let addr  = parts.slice(0, 3).join(',').replace(/\d{6}/g, '').trim();
          if (addr.endsWith(',')) addr = addr.slice(0, -1);
          APP.addressCache[key] = addr;
          setAddress(addr);
        } else {
          nominatimGeocode(lat, lng, key);
        }
      });
    } else {
      nominatimGeocode(lat, lng, key);
    }
  }, 600);
}

function nominatimGeocode(lat, lng, key) {
  fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'NavPath/4.0' },
  })
    .then(r => r.json())
    .then(data => {
      const a    = data.address || {};
      const parts = [
        a.amenity || a.university || a.road || a.neighbourhood || a.suburb,
        a.city || a.town || a.village || a.county,
        a.state,
      ].filter(Boolean);
      const addr = parts.slice(0, 3).join(', ') || (lat.toFixed(4) + ', ' + lng.toFixed(4));
      APP.addressCache[key] = addr;
      setAddress(addr);
    })
    .catch(() => setAddress(lat.toFixed(4) + ', ' + lng.toFixed(4)));
}

function setAddress(addr) {
  document.getElementById('addrTxt').textContent = addr;
  const fromEl = document.getElementById('rFrom');
  if (fromEl && document.getElementById('sRoute')?.classList.contains('active')) {
    fromEl.textContent = addr;
  }
}
