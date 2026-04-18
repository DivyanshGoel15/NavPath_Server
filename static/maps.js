/**
 * maps.js — NavPath Ambulance v4
 * Home map (Google Maps AdvancedMarkerElement) and
 * navigation map (Leaflet + OSRM route rendering).
 * Depends on: app.js, ui.js, gps.js
 */

/* ════════════════════════════════════════
   HOME MAP  (Google Maps)
════════════════════════════════════════ */

function initHomeMap() {
  if (APP.homeMap) return;
  const lat = APP.gps?.lat ?? 28.5672;
  const lng = APP.gps?.lng ?? 77.2100;

  const map = new google.maps.Map(document.getElementById('homeLeaflet'), {
    center:          { lat, lng },
    zoom:            16,
    styles:          MAP_STYLE_DARK,
    disableDefaultUI: true,
    zoomControl:     true,
    mapId:           'HOME_MAP_ID',
    gestureHandling: 'greedy',
  });

  APP.homeAccCircle = new google.maps.Circle({
    map,
    center:        { lat, lng },
    radius:        APP.gps?.accuracy ?? 20,
    fillColor:     '#4dabf7',
    fillOpacity:   0.08,
    strokeColor:   '#4dabf7',
    strokeOpacity: 0.22,
    strokeWeight:  1.5,
  });

  const ambDiv = document.createElement('div');
  ambDiv.className = 'ambMarker';
  APP.homeMarker = new google.maps.marker.AdvancedMarkerElement({
    map,
    position: { lat, lng },
    content:  ambDiv,
  });

  APP.homeMap = map;
  document.getElementById('mapLoading').style.display = 'none';
  google.maps.event.trigger(map, 'resize');
}

function updateMapMarkers(lat, lng, accuracy) {
  if (APP.homeMap) {
    const pos = { lat, lng };
    if (APP.homeMarker) APP.homeMarker.position = pos;
    if (APP.homeAccCircle) {
      APP.homeAccCircle.setCenter(pos);
      if (accuracy) APP.homeAccCircle.setRadius(accuracy);
    }
  } else {
    initHomeMap();
  }

  if (APP.navMarker && APP.navMap) {
    if (APP.gpsMode === 'real' || !APP.navTimer) {
      APP.navMarker.setLatLng([lat, lng]);
      if (APP.navTimer && APP.gpsMode === 'real') APP.navMap.panTo([lat, lng]);
    }
  }
}

function recenterHome() {
  if (APP.homeMap && APP.gps) {
    APP.homeMap.panTo({ lat: APP.gps.lat, lng: APP.gps.lng });
    APP.homeMap.setZoom(17);
  }
}

/* ════════════════════════════════════════
   NAV MAP  (Leaflet + OSRM)
════════════════════════════════════════ */

function initNavMap() {
  if (APP.navMap) {
    if (APP._pendingDirectionsResult) {
      drawDirectionsOnNavMap(APP._pendingDirectionsResult);
      APP._pendingDirectionsResult = null;
    }
    setTimeout(() => APP.navMap.invalidateSize(), 150);
    return;
  }

  const lat = APP.gps?.lat ?? 28.5672;
  const lng = APP.gps?.lng ?? 77.2100;

  const map = L.map('navLeaflet', { zoomControl: false, attributionControl: false }).setView([lat, lng], 15);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(map);

  const ambIcon = L.divIcon({
    className: '',
    html:      '<div class="ambMarker"></div>',
    iconSize:  [22, 22],
    iconAnchor:[11, 11],
  });
  APP.navMarker   = L.marker([lat, lng], { icon: ambIcon }).addTo(map);
  APP.navPolyline = L.polyline([], { color: '#f03e3e', weight: 6, opacity: 0.9 }).addTo(map);
  APP.navMap      = map;

  setTimeout(() => APP.navMap.invalidateSize(), 150);

  if (APP._pendingDirectionsResult) {
    drawDirectionsOnNavMap(APP._pendingDirectionsResult);
    APP._pendingDirectionsResult = null;
  } else if (APP.navDestCoord) {
    requestAndDrawRoute();
  } else {
    toast('⚠ Select a hospital on the Route screen first');
  }
}

function requestAndDrawRoute() {
  if (!APP.gps || !APP.navDestCoord) return;
  const url = `https://router.project-osrm.org/route/v1/driving/${APP.gps.lng},${APP.gps.lat};${APP.navDestCoord.lng},${APP.navDestCoord.lat}?overview=full&geometries=geojson&steps=true`;
  fetch(url)
    .then(r => r.json())
    .then(res => {
      if (res.code === 'Ok') drawDirectionsOnNavMap(res);
      else toast('⚠ Could not calculate route: ' + res.message);
    })
    .catch(() => toast('⚠ Route error'));
}

function drawDirectionsOnNavMap(result) {
  if (!APP.navMap) return;

  // Remove previous route markers
  if (APP._routeMarkers) APP._routeMarkers.forEach(m => APP.navMap.removeLayer(m));
  APP._routeMarkers = [];

  const route  = result.routes[0];
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);

  if (APP.navPolyline) APP.navPolyline.setLatLngs(coords);

  const leg        = route.legs[0];
  const steps      = leg.steps;
  APP._navSteps    = steps;
  APP.navRoute     = coords.map(c => ({ lat: c[0], lng: c[1] }));
  APP.navEtaSec    = Math.round(route.duration);
  APP.navTotalSec  = Math.round(route.duration);
  APP.navTotalDist = Math.round(route.distance);

  // ETA display
  const etaStr = window.fmtEta(APP.navEtaSec);
  const elEta  = document.getElementById('navEta');
  const elMin  = document.getElementById('etaMin');
  const bEta   = document.getElementById('bEta');
  if (elEta) elEta.textContent = etaStr;
  if (elMin) elMin.textContent = etaStr;
  if (bEta)  bEta.textContent  = 'ETA ~' + Math.floor(APP.navEtaSec / 60) + ' min';

  // Distance display in banner
  const bDistEl = document.getElementById('bDist');
  if (bDistEl) bDistEl.textContent = route.distance > 1000 ? (route.distance / 1000).toFixed(1) : Math.round(route.distance);

  const distStr = route.distance > 1000 ? (route.distance / 1000).toFixed(1) + ' km' : Math.round(route.distance) + ' m';
  const etaDistEl = document.getElementById('etaDist');
  if (etaDistEl) etaDistEl.textContent = distStr;

  // Destination label marker
  const endLoc  = coords[coords.length - 1];
  const destIcon = L.divIcon({
    className: 'custom-div-icon',
    html: `<div style="background:#f03e3e;color:white;font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:900;padding:4px 10px;border-radius:4px;letter-spacing:1.5px;box-shadow:0 2px 14px rgba(240,62,62,.5);white-space:nowrap">${APP.navDestName || 'DEST'}</div>`,
    iconSize:   [80, 20],
    iconAnchor: [40, 10],
  });
  APP._routeMarkers.push(L.marker(endLoc, { icon: destIcon }).addTo(APP.navMap));

  APP._stepNames = steps.map((s, i) => s.name || ('Step ' + i));

  // Add server intersection labels if a server route is active
  if (APP.routeId && APP.serverRoutes) {
    const activeRoute = APP.serverRoutes.find(r => r.id === APP.routeId);
    if (activeRoute?.intersections) {
      fetch(SERVER_URL + '/api/intersections')
        .then(r => r.json())
        .then(data => {
          const srvInts = {};
          (Array.isArray(data) ? data : (data.intersections || [])).forEach(p => { srvInts[p.id] = p; });
          APP._srvIntMap = srvInts;
          activeRoute.intersections.forEach((intId, idx) => {
            const intData = srvInts[intId];
            if (!intData) return;
            const jIcon = L.divIcon({
              className: 'custom-div-icon',
              html: `<div style="background:rgba(7,9,13,.88);border:1px solid #28344a;color:#8899aa;font-size:9px;font-family:'JetBrains Mono',monospace;padding:2px 6px;border-radius:3px;letter-spacing:.5px;white-space:nowrap">Junction ${idx + 1} · ${intData.name || intId}</div>`,
              iconSize:  [80, 16],
              iconAnchor:[40, 8],
            });
            APP._routeMarkers.push(L.marker([intData.lat, intData.lon], { icon: jIcon }).addTo(APP.navMap));
          });
        })
        .catch(e => console.warn('Failed to fetch intersections for map labels', e));
    }
  }

  if (steps[0]) announceStep(steps[0]);
  APP.navMap.fitBounds(coords);

  // Start timer only after route is drawn (guard prevents double-start)
  if (!APP._navTimerRunning) startNavTimer();
}

function recenterNav() {
  if (APP.navMap && APP.gps) {
    APP.navMap.panTo([APP.gps.lat, APP.gps.lng]);
    APP.navMap.setZoom(16);
  }
}
