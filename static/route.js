/**
 * route.js — NavPath Ambulance v4
 * Route selection, server route assignment, hospital search,
 * intersection list, and trip accept / arrive / abort.
 * Depends on: app.js, ui.js, gps.js, maps.js, nav.js
 */

/* ─── Accept route from Route screen ─── */
function acceptRoute() {
  if (!APP.duty) {
    toast('🔴 Switch to On Duty before starting a trip!');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    return;
  }
  document.getElementById('navDot').classList.remove('show');
  const srvSel       = document.getElementById('srvRouteSel');
  const routeToAssign = APP.routeId || (srvSel?.value);
  if (routeToAssign) {
    assignRouteToServer(routeToAssign);
  } else if (!APP.navDestName && APP.nearbyResults.length) {
    const h = APP.nearbyResults[0];
    APP.navDestName  = h.name;
    APP.navDestCoord = { lat: h.geometry.location.lat(), lng: h.geometry.location.lng() };
    document.getElementById('navDest').textContent = h.name;
    document.getElementById('rTo').textContent     = h.name;
    previewRoute(APP.navDestCoord);
  }
  setTimeout(() => goTo('sNav'), 150);
}

/* ─── Confirm manual hospital selection ─── */
function manualRoute() {
  if (!APP.duty) {
    toast('🔴 Switch to On Duty before starting a trip!');
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    return;
  }
  const sel = document.getElementById('destSel');
  const idx = parseInt(sel.value);
  if (isNaN(idx)) { toast('Select a destination first'); return; }
  onDestSelChange();
  document.getElementById('navDot').classList.remove('show');
  const srvSel = document.getElementById('srvRouteSel');
  if (srvSel?.value) assignRouteToServer(srvSel.value);
  setTimeout(() => goTo('sNav'), 200);
}

/* ─── Arrive / complete trip ─── */
function arrive() {
  clearInterval(APP.navTimer);
  APP._navTimerRunning = false;
  stopGpsLoop();

  fetch(SERVER_URL + '/api/end_trip', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ amb_id: APP.ambId }),
  }).then(() => { APP.routeId = ''; }).catch(e => console.warn('end_trip failed', e));

  goTo('sComplete');
}

/* ─── Assign route on server ─── */
function assignRouteToServer(routeId) {
  if (!routeId) return;
  APP.routeId = routeId;
  fetch(SERVER_URL + '/api/assign_route', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ amb_id: APP.ambId, route_id: routeId }),
  })
    .then(r => r.json())
    .then(data => { if (data.route) toast('🗺 Route assigned: ' + data.route.name); })
    .catch(e => console.warn('assign_route failed', e));
}

/* ════════════════════════════════════════
   SERVER ROUTE DROPDOWN
════════════════════════════════════════ */
function populateServerRoutes() {
  fetch(SERVER_URL + '/api/routes')
    .then(r => r.json())
    .then(routes => { APP.serverRoutes = routes; buildServerRouteDropdown(); })
    .catch(() => buildServerRouteDropdown());
}

function buildServerRouteDropdown() {
  let srvSel = document.getElementById('srvRouteSel');
  if (!srvSel) {
    srvSel = document.createElement('select');
    srvSel.id        = 'srvRouteSel';
    srvSel.className = 'destSel';
    srvSel.style.marginBottom = '0';
    const btnGo = document.querySelector('#sRoute .btnGo');
    if (btnGo) btnGo.parentNode.insertBefore(srvSel, btnGo);
  }

  if (!APP.serverRoutes.length) {
    srvSel.innerHTML = '<option value="">No server routes available — is server running?</option>';
    document.getElementById('routeIntList').innerHTML =
      '<div style="padding:12px;font-family:var(--fM);font-size:10px;color:var(--txt3);text-align:center">Start the server and refresh the Route screen</div>';
    return;
  }

  const preselect = APP.routeId || APP.serverRoutes[0].id;
  srvSel.innerHTML = APP.serverRoutes.map(r =>
    `<option value="${r.id}"${r.id === preselect ? ' selected' : ''}>${r.name} · ETA ${r.navpath_eta}</option>`
  ).join('');

  function applyRoute(r) {
    if (!r) return;
    APP.routeId      = r.id;
    APP.navDestName  = r.destination;
    APP.navDestCoord = { lat: r.dest_lat, lng: r.dest_lon };
    document.getElementById('rFrom').textContent   = r.origin;
    document.getElementById('rTo').textContent     = r.destination;
    document.getElementById('navDest').textContent = r.destination;
    const etaMin   = document.getElementById('etaMin');
    const etaVs    = document.getElementById('etaVs');
    const etaSaved = document.getElementById('etaSaved');
    if (etaMin)   etaMin.textContent   = r.navpath_eta;
    if (etaVs)    etaVs.textContent    = 'vs ' + r.manual_eta + ' without NavPath';
    if (etaSaved) etaSaved.textContent = '⚡ ~' + r.time_saved;
    updateIntersectionList(r);
    previewRoute(APP.navDestCoord);
  }

  srvSel.onchange = () => applyRoute(APP.serverRoutes.find(x => x.id === srvSel.value));
  applyRoute(APP.serverRoutes.find(x => x.id === preselect));
}

/* ════════════════════════════════════════
   INTERSECTION LIST
════════════════════════════════════════ */
function updateIntersectionList(route) {
  const container = document.getElementById('routeIntList');
  const lblEl     = document.getElementById('intListLbl');
  if (!container || !route) return;

  container.innerHTML = '<div style="padding:12px;font-family:var(--fM);font-size:10px;color:var(--txt3);text-align:center">Loading intersections…</div>';

  fetch(SERVER_URL + '/api/intersections')
    .then(r => r.json())
    .then(allInts => {
      const routeIntIds = route.intersections || [];
      const filtered    = routeIntIds.map(id => allInts.find(i => i.id === id)).filter(Boolean);

      if (lblEl) lblEl.textContent = filtered.length + ' Intersection' + (filtered.length !== 1 ? 's' : '') + ' to Clear';

      if (!filtered.length) {
        container.innerHTML = '<div style="padding:12px;font-family:var(--fM);font-size:10px;color:var(--txt3);text-align:center">No intersections on this route</div>';
        return;
      }

      container.innerHTML = filtered.map((int, idx) => {
        const state   = int.state === 'OVERRIDE' ? 'c' : 'p';
        const stLabel = int.state === 'OVERRIDE' ? 'ACTIVE' : (int.state === 'NORMAL' && int.locked_by ? 'LOCKED' : 'PENDING');
        const hwBadge = int.hardware ? ' 📡' : '';
        return `
          <div class="intItem ${int.state === 'NORMAL' && int.locked_by ? 'cleared' : ''}" id="srvInt_${int.id}">
            <div class="intN">${idx + 1}</div>
            <div class="intDot ${state}"></div>
            <div class="intNm">${int.name}${hwBadge}</div>
            <div class="intD">${int.overrides_today} overrides today</div>
            <div class="intSt ${state}">${stLabel}</div>
          </div>`;
      }).join('');

      APP._routeIntIds = routeIntIds;
    })
    .catch(() => {
      container.innerHTML = '<div style="padding:12px;font-family:var(--fM);font-size:10px;color:var(--txt3);text-align:center">Could not load intersections — server offline?</div>';
    });
}

/* Live update intersection items from analytics socket event */
function updateRouteIntListFromAnalytics(intersections) {
  if (!intersections || !APP._routeIntIds) return;
  APP._routeIntIds.forEach(id => {
    const el  = document.getElementById('srvInt_' + id);
    const int = intersections.find(i => i.id === id);
    if (!el || !int) return;
    const isOverride = int.state === 'OVERRIDE';
    const isCleared  = int.state === 'NORMAL' && !int.locked_by && (int.overrides_today > 0);
    el.className = 'intItem' + (isCleared ? ' cleared' : '');
    const dot  = el.querySelector('.intDot');
    const st   = el.querySelector('.intSt');
    const dist = el.querySelector('.intD');
    if (dot) dot.className = 'intDot ' + (isOverride ? 'c' : 'p');
    if (st) {
      st.className   = 'intSt ' + (isOverride ? 'c' : 'p');
      st.textContent = isOverride ? '🔴 CLEARING' : (isCleared ? '✅ CLEARED' : 'PENDING');
    }
    if (dist && int.distance != null) {
      dist.textContent = int.distance > 999 ? (int.distance / 1000).toFixed(1) + ' km' : int.distance + ' m';
    }
  });
}

/* ════════════════════════════════════════
   NEARBY HOSPITAL SEARCH (Places API + fallback)
════════════════════════════════════════ */
let placesService  = null;
let _hospitalsTimer = null;

function fetchNearbyHospitals(lat, lng) {
  if (!window.google?.maps?.places) { useFallbackHospitals(lat, lng); return; }

  if (!placesService) {
    const container = APP.homeMap ? APP.homeMap.getDiv() : (() => {
      let d = document.getElementById('_placesDiv');
      if (!d) {
        d = document.createElement('div');
        d.id = '_placesDiv';
        d.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.appendChild(d);
      }
      return d;
    })();
    placesService = new google.maps.places.PlacesService(container);
  }

  const destSel = document.getElementById('destSel');
  if (destSel) destSel.innerHTML = '<option value="" disabled selected>Searching nearby hospitals…</option>';

  clearTimeout(_hospitalsTimer);
  _hospitalsTimer = setTimeout(() => {
    const sel = document.getElementById('destSel');
    if (sel?.options.length <= 1 && sel.options[0]?.text.includes('Searching')) useFallbackHospitals(lat, lng);
  }, 4000);

  placesService.nearbySearch(
    { location: new google.maps.LatLng(lat, lng), radius: 10000, type: ['hospital'] },
    (results, status) => {
      clearTimeout(_hospitalsTimer);
      if (status === google.maps.places.PlacesServiceStatus.OK && results?.length) {
        populateHospitals(results);
      } else {
        console.warn('Places API status:', status);
        useFallbackHospitals(lat, lng);
      }
    },
  );
}

function useFallbackHospitals(lat, lng) {
  const ALL = [
    // Punjab / Chandigarh
    { name: 'PGIMER Chandigarh',                    vicinity: 'Sector 12, Chandigarh',    lat: 30.7650, lng: 76.7849 },
    { name: 'Government Medical College & Hospital', vicinity: 'Sector 32, Chandigarh',   lat: 30.7270, lng: 76.7769 },
    { name: 'Fortis Hospital Mohali',                vicinity: 'Phase 8, Mohali',          lat: 30.7096, lng: 76.6910 },
    { name: 'Max Super Speciality Hospital',         vicinity: 'Phase 6, Mohali',          lat: 30.7076, lng: 76.7169 },
    { name: 'Civil Hospital Rajpura',                vicinity: 'Rajpura, Patiala',         lat: 30.4846, lng: 76.5936 },
    { name: 'Patiala Civil Surgeon Hospital',        vicinity: 'Leishman Road, Patiala',   lat: 30.3398, lng: 76.3869 },
    { name: 'Ivy Hospital',                          vicinity: 'Sector 71, Mohali',        lat: 30.6742, lng: 76.7182 },
    { name: 'Fortis Hospital Ludhiana',              vicinity: 'Chandigarh Road, Ludhiana',lat: 30.9010, lng: 75.8573 },
    { name: 'DMC & Hospital Ludhiana',               vicinity: 'Tagore Nagar, Ludhiana',   lat: 30.9098, lng: 75.8477 },
    // Delhi NCR
    { name: 'AIIMS New Delhi',                       vicinity: 'Ansari Nagar, New Delhi',  lat: 28.5672, lng: 77.2100 },
    { name: 'Safdarjung Hospital',                   vicinity: 'Sri Aurobindo Marg, Delhi',lat: 28.5678, lng: 77.2030 },
    { name: 'RML Hospital',                          vicinity: 'Baba Kharak Singh Marg',   lat: 28.6321, lng: 77.2100 },
    { name: 'GTB Hospital',                          vicinity: 'Dilshad Garden, Delhi',    lat: 28.6783, lng: 77.3106 },
    { name: 'Lok Nayak Hospital',                    vicinity: 'JLN Marg, New Delhi',      lat: 28.6418, lng: 77.2395 },
    { name: 'Max Smart Hospital Saket',              vicinity: 'Saket, New Delhi',         lat: 28.5284, lng: 77.2127 },
    // Mumbai
    { name: 'KEM Hospital',                          vicinity: 'Parel, Mumbai',            lat: 18.9984, lng: 72.8416 },
    { name: 'Lilavati Hospital',                     vicinity: 'Bandra West, Mumbai',      lat: 19.0523, lng: 72.8274 },
    { name: 'Breach Candy Hospital',                 vicinity: 'Breach Candy, Mumbai',     lat: 18.9713, lng: 72.8060 },
    // Bengaluru
    { name: 'Manipal Hospital',                      vicinity: 'Old Airport Road, Bengaluru',lat:12.9651, lng:77.6480 },
    { name: 'Victoria Hospital',                     vicinity: 'Majestic, Bengaluru',      lat: 12.9774, lng: 77.5760 },
  ];

  const dist = h => { const dl = h.lat - lat, dg = h.lng - lng; return dl * dl + dg * dg; };
  const sorted = ALL.slice().sort((a, b) => dist(a) - dist(b)).slice(0, 10);
  populateHospitals(sorted.map(h => ({
    name: h.name, vicinity: h.vicinity,
    geometry: { location: { lat: () => h.lat, lng: () => h.lng } },
  })));
}

function populateHospitals(list) {
  APP.nearbyResults = list.slice(0, 15);
  const sHosp   = document.getElementById('sHosp');
  const destSel = document.getElementById('destSel');

  let htmlHosp = '<option value="" disabled selected>Select your fleet</option>';
  let htmlDest = '<option value="" disabled selected>Choose destination…</option>';

  APP.nearbyResults.forEach((h, i) => {
    const vicinity = h.vicinity ? ` — ${h.vicinity.split(',').slice(0, 2).join(',')}` : '';
    htmlHosp += `<option value="${i}">${h.name}${vicinity}</option>`;
    htmlDest  += `<option value="${i}">${h.name}${vicinity}</option>`;
  });

  if (sHosp)   sHosp.innerHTML   = htmlHosp;
  if (destSel) { destSel.innerHTML = htmlDest; destSel.onchange = onDestSelChange; }
}

function onDestSelChange() {
  const sel  = document.getElementById('destSel');
  const idx  = parseInt(sel.value);
  if (isNaN(idx)) return;
  const place = APP.nearbyResults[idx];
  if (!place) return;
  APP.navDestName  = place.name;
  APP.navDestCoord = { lat: place.geometry.location.lat(), lng: place.geometry.location.lng() };
  document.getElementById('rTo').textContent    = place.name;
  document.getElementById('navDest').textContent = place.name;
  previewRoute(APP.navDestCoord);
}

/* ─── Route ETA preview on Route screen ─── */
window.previewRoute = function (destCoord) {
  if (!APP.gps || !destCoord) return;
  const url = `https://router.project-osrm.org/route/v1/driving/${APP.gps.lng},${APP.gps.lat};${destCoord.lng},${destCoord.lat}?overview=full&geometries=geojson&steps=true`;
  fetch(url)
    .then(r => r.json())
    .then(res => {
      if (res.code !== 'Ok') return;
      const route      = res.routes[0];
      const roundedDur = Math.round(route.duration);
      const manualDur  = Math.round(roundedDur * 1.35);
      const savedDur   = manualDur - roundedDur;

      const etaMinEl   = document.getElementById('etaMin');
      const etaVsEl    = document.getElementById('etaVs');
      const etaSavedEl = document.getElementById('etaSaved');
      const etaDistEl  = document.getElementById('etaDist');

      if (etaMinEl)   etaMinEl.textContent   = window.fmtEta(roundedDur);
      if (etaVsEl)    etaVsEl.textContent    = 'vs ' + window.fmtEta(manualDur) + ' without NavPath';
      if (etaSavedEl) etaSavedEl.textContent = '⚡ ~' + window.fmtEta(savedDur);
      if (etaDistEl)  etaDistEl.textContent  = route.distance > 1000
        ? (route.distance / 1000).toFixed(1) + ' km'
        : Math.round(route.distance) + ' m';

      APP._pendingDirectionsResult = res;
    })
    .catch(e => console.warn('[NavPath] previewRoute error', e));
};
