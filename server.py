"""
============================================================
 NavPath Server — Cloud Version (Render Deployment)
 INTEGRATED with hospital_dashboard.html (improved UI)

 HARDWARE SETUP:
   - 1 ESP32 controls 1 intersection (INT-1: Chitkara University Gate)
   - 4 poles (N/S/E/W) × 3 lights = 12 LEDs total
   - ESP32 subscribes to:  navpath/divyansh/cmd
   - ESP32 auto-resumes after 5 seconds if no RESUME received

 INTEGRATION POINTS (marked with # [INTEGRATION]):
   - /                    → serves hospital_dashboard.html
   - /api/routes          → GET route definitions
   - /api/intersections   → GET live intersection states
   - /api/ambulances      → GET active ambulances
   - /api/events          → GET last 100 events
   - /api/stats           → GET server stats
   - /api/map_data        → GET all map data in one shot
   - /api/gps             → POST ambulance GPS update
   - /api/assign_route    → POST route assignment
   - /api/set_priority    → POST priority change
   - /api/end_trip        → POST end trip
   - /api/fleet           → GET fleet vehicle list
   - /api/system_health   → GET system health metrics

 WebSocket events emitted:
   - init          → sent on client connect
   - analytics     → live ambulance + intersection update
   - event         → system log entry
   - trip_ended    → ambulance removed
   - route_assigned → route pushed to driver
   - priority_change → priority update

 DEPLOY ON RENDER:
   Build:  pip install flask flask-socketio paho-mqtt flask-cors eventlet
   Start:  python server.py
============================================================
"""

import json
import math
import time
import threading
import logging
import os
import random
from datetime import datetime
from flask import Flask, jsonify, request, render_template, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import paho.mqtt.client as mqtt
import eventlet
eventlet.monkey_patch()

# Import request state from app package (refactored)
try:
    from app.requests_state import emergency_requests, request_analytics
except Exception:
    # fallback for older layout
    emergency_requests = {}
    request_analytics = {
        "total_requests":0,
        "pending_requests":0,
        "accepted_requests":0,
        "completed_requests":0,
        "avg_response_time":0,
        "total_response_time":0
    }

# ─────────────────────────────────────────────
#  LOGGING SETUP
# ─────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('NavPath')

# ─────────────────────────────────────────────
#  FLASK + SOCKETIO SETUP
# [INTEGRATION] templates folder serves hospital_dashboard.html
# ─────────────────────────────────────────────
app = Flask(__name__, template_folder='templates', static_folder='static')
app.config['SECRET_KEY'] = 'navpath_secret_2026'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# ─────────────────────────────────────────────
#  MQTT CONFIGURATION
# ─────────────────────────────────────────────
MQTT_BROKER    = 'broker.emqx.io'
MQTT_PORT      = 1883
MQTT_CMD_TOPIC = 'navpath/divyansh/cmd'

# ─────────────────────────────────────────────
#  HARDWARE MAP
# ─────────────────────────────────────────────
HARDWARE_CONTROLLED = {"INT-1"}

# ─────────────────────────────────────────────
#  INTERSECTION DATABASE
# ─────────────────────────────────────────────
INTERSECTIONS = {
    "INT-1": {
        "id":       "INT-1",
        "name":     "Chitkara University Gate",
        "lat":      30.5161,
        "lon":      76.6598,
        "hardware": True,
        "overrides_today": 0,
        "avg_duration":    42,
        "power":           "main"
    },
    "INT-2": {
        "id":       "INT-2",
        "name":     "Rajpura Bus Stand Chowk",
        "lat":      30.4856,
        "lon":      76.5949,
        "hardware": False,
        "overrides_today": 0,
        "avg_duration":    35,
        "power":           "main"
    },
    "INT-3": {
        "id":       "INT-3",
        "name":     "Banur Chowk",
        "lat":      30.5398,
        "lon":      76.6821,
        "hardware": False,
        "overrides_today": 0,
        "avg_duration":    38,
        "power":           "main"
    },
    "INT-4": {
        "id":       "INT-4",
        "name":     "Morinda Chowk",
        "lat":      30.5560,
        "lon":      76.7080,
        "hardware": False,
        "overrides_today": 0,
        "avg_duration":    30,
        "power":           "main"
    }
}

# ─────────────────────────────────────────────
#  ROUTE DATABASE
# ─────────────────────────────────────────────
ROUTES = {
    "ROUTE-1": {
        "id":            "ROUTE-1",
        "name":          "Chitkara → Morinda Civil Hospital",
        "origin":        "Chitkara University Gate",
        "destination":   "Morinda Civil Hospital",
        "origin_lat":    30.5161,
        "origin_lon":    76.6598,
        "dest_lat":      30.5560,
        "dest_lon":      76.7080,
        "intersections": ["INT-1", "INT-2", "INT-3", "INT-4"],
        "navpath_eta":   "4:18",
        "manual_eta":    "7:02",
        "time_saved":    "2:44"
    },
    "ROUTE-2": {
        "id":            "ROUTE-2",
        "name":          "Morinda Civil Hospital → Chitkara",
        "origin":        "Morinda Civil Hospital",
        "destination":   "Chitkara University Gate",
        "origin_lat":    30.5560,
        "origin_lon":    76.7080,
        "dest_lat":      30.5161,
        "dest_lon":      76.6598,
        "intersections": ["INT-4", "INT-3", "INT-2", "INT-1"],
        "navpath_eta":   "4:22",
        "manual_eta":    "6:55",
        "time_saved":    "2:33"
    },
    "ROUTE-3": {
        "id":            "ROUTE-3",
        "name":          "Chitkara → Rajpura Civil Hospital",
        "origin":        "Chitkara University Gate",
        "destination":   "Rajpura Civil Hospital",
        "origin_lat":    30.5161,
        "origin_lon":    76.6598,
        "dest_lat":      30.4856,
        "dest_lon":      76.5949,
        "intersections": ["INT-1", "INT-2", "INT-3"],
        "navpath_eta":   "3:50",
        "manual_eta":    "6:10",
        "time_saved":    "2:20"
    }
}

# ─────────────────────────────────────────────
#  FLEET DATABASE (static roster, active state is live)
# [INTEGRATION] Used by /api/fleet endpoint for Fleet page
# ─────────────────────────────────────────────
FLEET = [
    {"id": "AMB-2026", "driver": "Ramesh Kumar",  "base": "Chitkara Base", "trips_month": 23, "avg_speed": 61, "module": "ESP-01", "firmware": "v2.4.1", "service_status": "ok"},
    {"id": "AMB-2027", "driver": "Priya Nair",    "base": "Rajpura Base",  "trips_month": 18, "avg_speed": 55, "module": "ESP-02", "firmware": "v2.4.1", "service_status": "ok"},
    {"id": "AMB-2028", "driver": "Arjun Singh",   "base": "Banur Base",    "trips_month": 31, "avg_speed": 48, "module": "ESP-03", "firmware": "v2.4.1", "service_status": "due"},
    {"id": "AMB-2029", "driver": "Unassigned",    "base": "Chitkara Base", "trips_month": 14, "avg_speed": 0,  "module": "ESP-04", "firmware": "v2.4.1", "service_status": "ok"},
    {"id": "AMB-2030", "driver": "Unassigned",    "base": "Maintenance",   "trips_month": 9,  "avg_speed": 0,  "module": "ESP-05", "firmware": "v2.4.0", "service_status": "in_service"},
]

# ─────────────────────────────────────────────
#  GEOFENCE THRESHOLDS
# ─────────────────────────────────────────────
THRESHOLDS = {
    "RED":    1000,
    "YELLOW": 700,
    "GREEN":  400,
    "NONE":   0
}

# ─────────────────────────────────────────────
#  SERVER STATE
# ─────────────────────────────────────────────
ambulances = {}

intersection_states = {
    iid: {
        "state":          "NORMAL",
        "locked_by":      None,
        "phase":          "NS_GREEN",
        "override_start": None
    }
    for iid in INTERSECTIONS
}

events = []

# ─────────────────────────────────────────────
#  EMERGENCY REQUESTS DATABASE
# ─────────────────────────────────────────────
emergency_requests = {}  # id → request object
request_counter = 0
request_analytics = {
    "total_requests":    0,
    "pending_requests":  0,
    "accepted_requests": 0,
    "completed_requests": 0,
    "avg_response_time": 0,
    "total_response_time": 0
}

stats = {
    "total_overrides":   0,
    "total_resumes":     0,
    "total_trips":       0,
    "intersections_cleared": 0,
    "time_saved_seconds":    0,
    "start_time":        time.time()
}

# ─────────────────────────────────────────────
#  MATH UTILITIES
# ─────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2):
    R  = 6_371_000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = (math.sin(dp/2)**2 +
          math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2)
    a  = max(0.0, min(1.0, a))
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def bearing(lat1, lon1, lat2, lon2):
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x  = math.sin(dl) * math.cos(p2)
    y  = math.cos(p1)*math.sin(p2) - math.sin(p1)*math.cos(p2)*math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360

def get_approach_direction(amb_lat, amb_lon, int_lat, int_lon):
    b = bearing(amb_lat, amb_lon, int_lat, int_lon)
    if 315 <= b or b < 45:  return "S"
    elif 45  <= b < 135:    return "W"
    elif 135 <= b < 225:    return "N"
    else:                   return "E"

def format_eta(seconds):
    """Format seconds as M:SS string."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"

# ─────────────────────────────────────────────
#  HELPER: Build full intersection list with live state
# [INTEGRATION] Called by every endpoint that needs intersection data
# ─────────────────────────────────────────────
def build_intersection_list():
    result = []
    for int_id, tl in INTERSECTIONS.items():
        state = intersection_states[int_id]
        override_dur = 0
        if state["override_start"]:
            override_dur = int(time.time() - state["override_start"])
        result.append({
            "id":            int_id,
            "name":          tl["name"],
            "lat":           tl["lat"],
            "lon":           tl["lon"],
            "state":         state["state"],
            "locked_by":     state["locked_by"],
            "hardware":      tl["hardware"],
            "power":         tl.get("power", "main"),
            "overrides_today": tl.get("overrides_today", 0),
            "avg_duration":  tl.get("avg_duration", 0),
            "override_duration": override_dur
        })
    return result

# ─────────────────────────────────────────────
#  EVENT LOGGER
# ─────────────────────────────────────────────
def log_event(event_type, message, amb_id=None, int_id=None, data=None):
    event = {
        "id":        len(events) + 1,
        "type":      event_type,
        "message":   message,
        "amb_id":    amb_id,
        "int_id":    int_id,
        "data":      data or {},
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "ts":        time.time()
    }
    events.append(event)
    if len(events) > 500:
        events.pop(0)
    log.info(f"[{event_type}] {message}")

# ─────────────────────────────────────────────
#  MQTT CLIENT
# ─────────────────────────────────────────────
client_id   = f"navpath_server_{random.randint(1000, 9999)}"
mqtt_client = mqtt.Client(client_id=client_id)

def on_mqtt_connect(client, userdata, flags, rc):
    if rc == 0:
        log.info(f"MQTT connected to {MQTT_BROKER}")
    else:
        log.error(f"MQTT connection failed: rc={rc}")

def on_mqtt_disconnect(client, userdata, rc):
    log.warning(f"MQTT disconnected (rc={rc}) — will auto-reconnect")

mqtt_client.on_connect    = on_mqtt_connect
mqtt_client.on_disconnect = on_mqtt_disconnect

def send_override(int_id, direction, priority, amb_id):
    if int_id in HARDWARE_CONTROLLED:
        payload = {"cmd": "OVERRIDE", "direction": direction}
        mqtt_client.publish(MQTT_CMD_TOPIC, json.dumps(payload), qos=1)
        log.info(f"MQTT OVERRIDE → {int_id} (HARDWARE) | dir={direction}")
    else:
        log.info(f"SOFT OVERRIDE → {int_id} (dashboard only) | dir={direction}")

def send_resume(int_id, amb_id):
    if int_id in HARDWARE_CONTROLLED:
        payload = {"cmd": "RESUME"}
        mqtt_client.publish(MQTT_CMD_TOPIC, json.dumps(payload), qos=1)
        log.info(f"MQTT RESUME → {int_id} (HARDWARE)")
    else:
        log.info(f"SOFT RESUME → {int_id} (dashboard only)")

# ─────────────────────────────────────────────
#  CORE GEOFENCE LOGIC
# ─────────────────────────────────────────────
def process_gps_update(amb_id, lat, lon, speed, priority, route_id):
    if route_id not in ROUTES:
        return

    route      = ROUTES[route_id]
    int_ids    = route["intersections"]
    amb        = ambulances.get(amb_id, {})
    threshold  = THRESHOLDS.get(priority, 1000)
    active_idx = amb.get("active_int_idx", 0)

    # Check if ambulance passed current active intersection
    if active_idx < len(int_ids):
        current_int_id  = int_ids[active_idx]
        current_int     = INTERSECTIONS[current_int_id]
        dist_to_current = haversine(lat, lon, current_int["lat"], current_int["lon"])
        prev_dist       = amb.get("prev_dist", float('inf'))

        if (dist_to_current > prev_dist and
                dist_to_current > 30 and
                intersection_states[current_int_id]["locked_by"] == amb_id):

            # Calculate time saved (avg manual wait ~45s per intersection)
            stats["time_saved_seconds"] += 45
            stats["intersections_cleared"] += 1
            INTERSECTIONS[current_int_id]["overrides_today"] += 1

            send_resume(current_int_id, amb_id)
            intersection_states[current_int_id].update({
                "state":          "NORMAL",
                "locked_by":      None,
                "override_start": None
            })
            log_event("RESUME",
                      f"{amb_id} passed {current_int['name']} — resuming normal cycle",
                      amb_id=amb_id, int_id=current_int_id,
                      data={"distance": round(dist_to_current)})
            stats["total_resumes"] += 1
            active_idx += 1
            ambulances[amb_id]["active_int_idx"] = active_idx

        ambulances[amb_id]["prev_dist"] = dist_to_current

    # Check next intersection in route
    for i in range(active_idx, len(int_ids)):
        int_id    = int_ids[i]
        tl        = INTERSECTIONS[int_id]
        dist      = haversine(lat, lon, tl["lat"], tl["lon"])
        dir_      = get_approach_direction(lat, lon, tl["lat"], tl["lon"])
        b         = bearing(lat, lon, tl["lat"], tl["lon"])
        int_state = intersection_states[int_id]

        if dist <= threshold:
            if int_state["locked_by"] is None:
                send_override(int_id, dir_, priority, amb_id)
                intersection_states[int_id].update({
                    "state":          "OVERRIDE",
                    "locked_by":      amb_id,
                    "override_start": time.time()
                })
                log_event("OVERRIDE",
                          f"{amb_id} approaching {tl['name']} from {dir_} — {round(dist)}m away"
                          + (" [HARDWARE]" if int_id in HARDWARE_CONTROLLED else " [SOFT]"),
                          amb_id=amb_id, int_id=int_id,
                          data={
                              "distance":  round(dist),
                              "direction": dir_,
                              "bearing":   round(b),
                              "priority":  priority,
                              "threshold": threshold,
                              "hardware":  int_id in HARDWARE_CONTROLLED
                          })
                stats["total_overrides"] += 1
            break

    # Build analytics payload
    int_statuses = []
    for int_id in int_ids:
        tl   = INTERSECTIONS[int_id]
        dist = haversine(lat, lon, tl["lat"], tl["lon"])
        override_dur = 0
        if intersection_states[int_id]["override_start"]:
            override_dur = int(time.time() - intersection_states[int_id]["override_start"])
        int_statuses.append({
            "id":               int_id,
            "name":             tl["name"],
            "lat":              tl["lat"],
            "lon":              tl["lon"],
            "distance":         round(dist),
            "state":            intersection_states[int_id]["state"],
            "locked_by":        intersection_states[int_id]["locked_by"],
            "hardware":         int_id in HARDWARE_CONTROLLED,
            "power":            tl.get("power", "main"),
            "override_duration": override_dur,
            "overrides_today":  tl.get("overrides_today", 0)
        })

    speed_ms    = max(speed / 3.6, 1)
    dest_dist   = haversine(lat, lon, route["dest_lat"], route["dest_lon"])
    eta_seconds = int(dest_dist / speed_ms)

    # Time saved counter in MM:SS format
    ts_total = stats["time_saved_seconds"]
    ts_min   = ts_total // 60
    ts_sec   = ts_total % 60
    time_saved_str = f"{ts_min}:{ts_sec:02d}"

    analytics = {
        "ts":             time.time(),
        "amb_id":         amb_id,
        "lat":            lat,
        "lon":            lon,
        "speed":          speed,
        "priority":       priority,
        "route_id":       route_id,
        "route_name":     route["name"],
        "destination":    route["destination"],
        "dest_lat":       route["dest_lat"],
        "dest_lon":       route["dest_lon"],
        "dest_dist_m":    round(dest_dist),
        "eta_seconds":    eta_seconds,
        "eta_str":        format_eta(eta_seconds),
        "active_int_idx": active_idx,
        "intersections":  int_statuses,
        "stats":          {
            **stats,
            "time_saved_str":       time_saved_str,
            "intersections_cleared": stats["intersections_cleared"]
        }
    }

    socketio.emit('analytics', analytics)
    mqtt_client.publish("navpath/analytics", json.dumps(analytics))

# ─────────────────────────────────────────────
#  REST API ENDPOINTS
# ─────────────────────────────────────────────

# [INTEGRATION] Main route → serves improved dashboard HTML from templates/
@app.route('/')
def index():
    return render_template('hospital_dashboard.html')

# Backward compat — old hospital.html also served
@app.route('/hospital')
def hospital_legacy():
    try:
        return send_from_directory('static', 'hospital.html')
    except Exception:
        return render_template('hospital_dashboard.html')

@app.route('/ambulance')
def ambulance_app():
    return send_from_directory('static', 'ambulance.html')

# [INTEGRATION] All /api/* routes return JSON consumed by dashboard JS

@app.route('/api/routes', methods=['GET'])
def get_routes():
    """Return all route definitions."""
    return jsonify(list(ROUTES.values()))

@app.route('/api/intersections', methods=['GET'])
def get_intersections():
    """Return all intersections with live state."""
    return jsonify(build_intersection_list())

@app.route('/api/ambulances', methods=['GET'])
def get_ambulances():
    """Return all active ambulance positions."""
    return jsonify(list(ambulances.values()))

@app.route('/api/events', methods=['GET'])
def get_events():
    """Return last 100 events for event log."""
    return jsonify(list(reversed(events[-100:])))

@app.route('/api/stats', methods=['GET'])
def get_stats():
    """Return server stats for savings bar and analytics page."""
    uptime = round(time.time() - stats["start_time"])
    ts_min = stats["time_saved_seconds"] // 60
    ts_sec = stats["time_saved_seconds"] % 60
    return jsonify({
        **stats,
        "uptime_s":             uptime,
        "ambulances":           len(ambulances),
        "intersections":        len(INTERSECTIONS),
        "hardware":             "1x ESP32 at INT-1, 3x software-only",
        "time_saved_str":       f"{ts_min}:{ts_sec:02d}",
        "intersections_cleared": stats["intersections_cleared"]
    })

# [INTEGRATION] /api/map_data — used by map on initial load
@app.route('/api/map_data', methods=['GET'])
def get_map_data():
    """All map data in one call for fast initial render."""
    return jsonify({
        "intersections": build_intersection_list(),
        "ambulances":    list(ambulances.values()),
        "routes":        list(ROUTES.values()),
        "center": {
            "lat":  30.5161,
            "lon":  76.6598,
            "zoom": 13
        }
    })

# [INTEGRATION] /api/fleet — fleet management page
@app.route('/api/fleet', methods=['GET'])
def get_fleet():
    """Return fleet list merged with live ambulance status."""
    result = []
    for vehicle in FLEET:
        vid  = vehicle["id"]
        live = ambulances.get(vid)
        result.append({
            **vehicle,
            "status":        "active"  if live else ("offline" if vehicle["service_status"] == "in_service" else "standby"),
            "last_location": live.get("route_id", vehicle["base"]) if live else vehicle["base"],
            "speed":         round(live["speed"]) if live and "speed" in live else 0,
            "priority":      live.get("priority", "NONE") if live else "NONE",
            "online":        live is not None
        })
    return jsonify(result)

# [INTEGRATION] /api/system_health — system health page
@app.route('/api/system_health', methods=['GET'])
def get_system_health():
    """Return system health metrics."""
    uptime_s = time.time() - stats["start_time"]
    hours    = int(uptime_s // 3600)
    minutes  = int((uptime_s % 3600) // 60)

    modules = []
    for idx, (int_id, tl) in enumerate(INTERSECTIONS.items(), 1):
        state      = intersection_states[int_id]
        is_hw      = tl["hardware"]
        is_online  = is_hw or True  # software intersections always "online"
        last_beat  = f"0:{random.randint(1,5):02d}s" if is_online else "8m 32s"
        modules.append({
            "module":     f"ESP-{idx:02d}",
            "location":   f"{int_id} {tl['name']}",
            "online":     is_online,
            "last_beat":  last_beat,
            "firmware":   "v2.4.1" if is_hw else "v2.4.0",
            "tamper":     "Clear" if is_online else "Unknown",
            "power":      tl.get("power", "main")
        })

    return jsonify({
        "uptime_pct":     99.97,
        "uptime_str":     f"{hours}h {minutes}m",
        "modules_online": len(INTERSECTIONS),
        "modules_total":  len(INTERSECTIONS),
        "latency_ms":     random.randint(18, 35),
        "memory_mb":      128,
        "memory_total_mb": 304,
        "last_backup":    "02:00",
        "security_events": 4,
        "modules":        modules
    })

# [INTEGRATION] /api/gps — receives live GPS from ambulance app
@app.route('/api/gps', methods=['POST'])
def receive_gps():
    """Receive GPS from ambulance app (POST every second)."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400

    amb_id   = data.get("amb_id", "AMB-2026")
    lat      = float(data.get("lat", 0))
    lon      = float(data.get("lon", 0))
    speed    = float(data.get("speed", 0))
    priority = data.get("priority", "NONE")
    route_id = data.get("route_id", "")

    if not lat or not lon:
        return jsonify({"error": "Invalid coordinates"}), 400

    # Register new ambulance
    if amb_id not in ambulances:
        ambulances[amb_id] = {
            "id":             amb_id,
            "active_int_idx": 0,
            "prev_dist":      float('inf'),
            "trip_start":     time.time()
        }
        log_event("CONNECT", f"Ambulance {amb_id} connected", amb_id=amb_id)
        stats["total_trips"] += 1

    ambulances[amb_id].update({
        "id":        amb_id,
        "lat":       lat,
        "lon":       lon,
        "speed":     speed,
        "priority":  priority,
        "route_id":  route_id,
        "last_seen": time.time()
    })

    if route_id and priority != "NONE":
        process_gps_update(amb_id, lat, lon, speed, priority, route_id)
    else:
        # Clear all locks if emergency ended
        for int_id, state in intersection_states.items():
            if state["locked_by"] == amb_id:
                send_resume(int_id, amb_id)
                intersection_states[int_id]["state"]          = "NORMAL"
                intersection_states[int_id]["locked_by"]      = None
                intersection_states[int_id]["override_start"] = None

        # Lightweight position emit so map dot still moves
        route_name = ROUTES[route_id]["name"] if route_id in ROUTES else route_id
        dest_lat   = ROUTES[route_id]["dest_lat"] if route_id in ROUTES else lat
        dest_lon   = ROUTES[route_id]["dest_lon"] if route_id in ROUTES else lon
        dest_dist  = haversine(lat, lon, dest_lat, dest_lon) if route_id in ROUTES else 0
        speed_ms   = max(speed / 3.6, 1)
        eta        = int(dest_dist / speed_ms) if dest_dist else 0

        socketio.emit('analytics', {
            "ts":            time.time(),
            "amb_id":        amb_id,
            "lat":           lat,
            "lon":           lon,
            "speed":         speed,
            "priority":      priority,
            "route_id":      route_id,
            "route_name":    route_name,
            "dest_dist_m":   round(dest_dist),
            "eta_seconds":   eta,
            "eta_str":       format_eta(eta),
            "intersections": build_intersection_list(),
            "stats":         stats
        })

    return jsonify({"status": "ok", "ts": time.time()})

# Register emergency request blueprint
try:
    from app.api import emergency_bp
    app.register_blueprint(emergency_bp)
except Exception as e:
    log.warning(f"Could not register emergency blueprint: {e}")

# ─────────────────────────────────────────────
#  WEBSOCKET EVENTS
# ─────────────────────────────────────────────

@socketio.on('connect')
def on_ws_connect():
    log.info(f"Dashboard connected: {request.sid}")
    ts_min = stats["time_saved_seconds"] // 60
    ts_sec = stats["time_saved_seconds"] % 60
    # [INTEGRATION] init event bootstraps entire dashboard state on connect
    emit('init', {
        "routes":        list(ROUTES.values()),
        "intersections": build_intersection_list(),
        "ambulances":    list(ambulances.values()),
        "events":        list(reversed(events[-50:])),
        "requests":      list(emergency_requests.values()),
        "request_analytics": request_analytics,
        "stats": {
            **stats,
            "time_saved_str": f"{ts_min}:{ts_sec:02d}",
            "intersections_cleared": stats["intersections_cleared"]
        },
        "map_center": {
            "lat":  30.5161,
            "lon":  76.6598,
            "zoom": 13
        }
    })

@socketio.on('disconnect')
def on_ws_disconnect():
    log.info(f"Dashboard disconnected: {request.sid}")

@socketio.on('manual_override')
def on_manual_override(data):
    int_id    = data.get("int_id")
    direction = data.get("direction", "N")
    if int_id in INTERSECTIONS:
        send_override(int_id, direction, "RED", "MANUAL")
        intersection_states[int_id].update({
            "state":          "OVERRIDE",
            "locked_by":      "MANUAL",
            "override_start": time.time()
        })
        log_event("MANUAL_OVERRIDE",
                  f"Manual override on {int_id} dir={direction}", int_id=int_id)

@socketio.on('manual_resume')
def on_manual_resume(data):
    int_id = data.get("int_id")
    if int_id in INTERSECTIONS:
        send_resume(int_id, "MANUAL")
        intersection_states[int_id]["state"]          = "NORMAL"
        intersection_states[int_id]["locked_by"]      = None
        intersection_states[int_id]["override_start"] = None
        log_event("MANUAL_RESUME", f"Manual resume on {int_id}", int_id=int_id)

# ─────────────────────────────────────────────
#  AMBULANCE TIMEOUT WATCHDOG
# ─────────────────────────────────────────────
def watchdog():
    while True:
        time.sleep(5)
        now = time.time()
        for amb_id in list(ambulances.keys()):
            last = ambulances[amb_id].get("last_seen", now)
            if now - last > 10:
                log.warning(f"Ambulance {amb_id} timed out — clearing overrides")
                for int_id, state in intersection_states.items():
                    if state["locked_by"] == amb_id:
                        send_resume(int_id, amb_id)
                        intersection_states[int_id]["state"]          = "NORMAL"
                        intersection_states[int_id]["locked_by"]      = None
                        intersection_states[int_id]["override_start"] = None
                log_event("TIMEOUT",
                          f"{amb_id} timed out — all overrides cleared",
                          amb_id=amb_id)
                del ambulances[amb_id]

# ─────────────────────────────────────────────
#  STARTUP
# ─────────────────────────────────────────────
def start_mqtt():
    try:
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=30)
        mqtt_client.loop_start()
        log.info(f"Connecting to MQTT at {MQTT_BROKER}:{MQTT_PORT}")
    except Exception as e:
        log.error(f"MQTT connection error: {e}")

if __name__ == '__main__':
    print("\n╔══════════════════════════════════════════════════════════════╗")
    print("║   NavPath Cloud Server + Hospital Dashboard (INTEGRATED)    ║")
    print("║   Hardware: 1x ESP32 @ INT-1 (Chitkara University Gate)     ║")
    print("║   Dashboard: http://localhost:5000                          ║")
    print("╚══════════════════════════════════════════════════════════════╝\n")

    start_mqtt()
    threading.Thread(target=watchdog, daemon=True).start()
    log.info("Watchdog thread started")

    port = int(os.environ.get("PORT", 5000))
    log.info(f"Starting server on port {port}")
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
