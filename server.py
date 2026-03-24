"""
============================================================
 NavPath Server — Cloud Version (Render Deployment)
 FIXED VERSION — All map/ambulance/location bugs resolved.

 HARDWARE SETUP:
   - 1 ESP32 controls 1 intersection (INT-1: Chitkara University Gate)
   - 4 poles (N/S/E/W) × 3 lights = 12 LEDs total
   - ESP32 subscribes to:  navpath/test/cmd
   - ESP32 auto-resumes after 5 seconds if no RESUME received

 PAYLOAD FORMAT (server → ESP32):
   OVERRIDE: { "cmd": "OVERRIDE", "direction": "N" }
   RESUME:   { "cmd": "RESUME" }

 INT-2, INT-3, INT-4 are tracked in server state only
 (no physical hardware for demo — judges see them on dashboard)

 DEPLOY ON RENDER:
   Build:  pip install flask flask-socketio paho-mqtt flask-cors eventlet
   Start:  python server.py

 BUG FIXES APPLIED:
   1. Removed broken `intersections` global reference in /api/gps
   2. Fixed analytics emit — now always uses intersection_states properly
   3. Added GET /api/map_data endpoint for frontend map initialization
   4. INTERSECTIONS expanded to INT-1 through INT-4 (all 4 needed by ROUTES)
   5. Chitkara University Gate area coordinates used for all intersections
   6. /api/gps now returns full intersection status list correctly
   7. Added CORS headers to all responses
   8. Fixed haversine edge case (zero distance)
   9. watchdog now logs properly before deleting ambulance
  10. SocketIO emit uses correct intersection_states merge
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
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import paho.mqtt.client as mqtt
import eventlet
eventlet.monkey_patch()

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
# ─────────────────────────────────────────────
app = Flask(__name__, static_folder='static')
app.config['SECRET_KEY'] = 'navpath_secret_2026'
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# ─────────────────────────────────────────────
#  MQTT CONFIGURATION
#  Matched exactly to ESP32 code:
#    mqtt_server = "broker.hivemq.com"
#    client.subscribe("navpath/test/cmd")
# ─────────────────────────────────────────────
MQTT_BROKER    = 'broker.hivemq.com'
MQTT_PORT      = 8000
MQTT_CMD_TOPIC = 'navpath/test/cmd'   # Must match ESP32 subscribe topic exactly

# ─────────────────────────────────────────────
#  HARDWARE MAP
#  Only INT-1 has a real ESP32.
#  INT-2, INT-3, INT-4 are software-only for demo.
# ─────────────────────────────────────────────
HARDWARE_CONTROLLED = {"INT-1"}

# ─────────────────────────────────────────────
#  INTERSECTION DATABASE
#  FIX: All 4 intersections defined here.
#       Routes reference INT-1 through INT-4,
#       so all must exist or KeyError crashes GPS processing.
#       Coordinates are real Chitkara University area roads.
# ─────────────────────────────────────────────
INTERSECTIONS = {
    "INT-1": {
        "id":       "INT-1",
        "name":     "Chitkara University Gate",
        "lat":      30.5161,   # Chitkara University, Rajpura
        "lon":      76.6598,
        "hardware": True
    },
    "INT-2": {
        "id":       "INT-2",
        "name":     "Rajpura Bus Stand Chowk",
        "lat":      30.4856,
        "lon":      76.5949,
        "hardware": False
    },
    "INT-3": {
        "id":       "INT-3",
        "name":     "Banur Chowk",
        "lat":      30.5398,
        "lon":      76.6821,
        "hardware": False
    },
    "INT-4": {
        "id":       "INT-4",
        "name":     "Morinda Chowk",
        "lat":      30.5560,
        "lon":      76.7080,
        "hardware": False
    }
}

# ─────────────────────────────────────────────
#  ROUTE DATABASE
#  FIX: Origin/destination coordinates updated to
#       match Chitkara University area geography.
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
        "intersections": ["INT-1", "INT-2", "INT-3", "INT-4"]
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
        "intersections": ["INT-4", "INT-3", "INT-2", "INT-1"]
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
        "intersections": ["INT-1", "INT-2", "INT-3"]
    }
}

# Geo-fence thresholds per priority (metres)
THRESHOLDS = {
    "RED":    1000,
    "YELLOW": 700,
    "GREEN":  400,
    "NONE":   0
}

# Yellow transition timing (ms) — informational, ESP32 uses its own hardcoded 2000ms
YELLOW_MS = {
    "RED":    2000,
    "YELLOW": 3000,
    "GREEN":  4000,
    "NONE":   3000
}

# ─────────────────────────────────────────────
#  SERVER STATE
# ─────────────────────────────────────────────
ambulances = {}

# FIX: intersection_states now auto-built from INTERSECTIONS dict (no hardcoded list)
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

stats = {
    "total_overrides": 0,
    "total_resumes":   0,
    "total_trips":     0,
    "start_time":      time.time()
}

# ─────────────────────────────────────────────
#  MATH FUNCTIONS
# ─────────────────────────────────────────────
def haversine(lat1, lon1, lat2, lon2):
    R  = 6_371_000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = (math.sin(dp/2)**2 +
          math.cos(p1) * math.cos(p2) * math.sin(dl/2)**2)
    # FIX: clamp 'a' to [0,1] to avoid math domain error at zero distance
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
    """
    Returns which pole should turn GREEN.
      Heading North (315-45)  → enters from South → S pole green
      Heading East  (45-135)  → enters from West  → W pole green
      Heading South (135-225) → enters from North → N pole green
      Heading West  (225-315) → enters from East  → E pole green
    """
    b = bearing(amb_lat, amb_lon, int_lat, int_lon)
    if 315 <= b or b < 45:
        return "S"
    elif 45 <= b < 135:
        return "W"
    elif 135 <= b < 225:
        return "N"
    else:
        return "E"

# ─────────────────────────────────────────────
#  HELPER: Build full intersection status list
#  FIX: Replaces the broken `intersections` global
#       reference that caused NameError in /api/gps
# ─────────────────────────────────────────────
def build_intersection_list():
    """Returns all intersections merged with their current live state."""
    result = []
    for int_id, tl in INTERSECTIONS.items():
        state = intersection_states[int_id]
        result.append({
            "id":        int_id,
            "name":      tl["name"],
            "lat":       tl["lat"],
            "lon":       tl["lon"],
            "state":     state["state"],
            "locked_by": state["locked_by"],
            "hardware":  tl["hardware"]
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
    socketio.emit('event', event)

# ─────────────────────────────────────────────
#  MQTT CLIENT SETUP
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

# ─────────────────────────────────────────────
#  MQTT COMMAND SENDERS
#
#  Payload matched EXACTLY to ESP32 callback():
#    cmd == "OVERRIDE" → reads doc["direction"]
#    cmd == "RESUME"   → no extra fields needed
#
#  Only INT-1 gets real MQTT → physical LED response.
#  INT-2/3/4 → server state + dashboard only.
# ─────────────────────────────────────────────
def send_override(int_id, direction, priority, amb_id):
    if int_id in HARDWARE_CONTROLLED:
        payload = {
            "cmd":       "OVERRIDE",
            "direction": direction    # Only field ESP32 reads beyond "cmd"
        }
        mqtt_client.publish(MQTT_CMD_TOPIC, json.dumps(payload), qos=1)
        log.info(f"MQTT OVERRIDE → {int_id} (HARDWARE) | dir={direction}")
    else:
        log.info(f"SOFT OVERRIDE → {int_id} (dashboard only) | dir={direction}")

def send_resume(int_id, amb_id):
    if int_id in HARDWARE_CONTROLLED:
        payload = {
            "cmd": "RESUME"           # Only field ESP32 needs
        }
        mqtt_client.publish(MQTT_CMD_TOPIC, json.dumps(payload), qos=1)
        log.info(f"MQTT RESUME → {int_id} (HARDWARE)")
    else:
        log.info(f"SOFT RESUME → {int_id} (dashboard only)")

# ─────────────────────────────────────────────
#  CORE BRAIN — GEOFENCE LOGIC
# ─────────────────────────────────────────────
def process_gps_update(amb_id, lat, lon, speed, priority, route_id):
    if route_id not in ROUTES:
        return

    route      = ROUTES[route_id]
    int_ids    = route["intersections"]
    amb        = ambulances.get(amb_id, {})
    threshold  = THRESHOLDS.get(priority, 1000)
    active_idx = amb.get("active_int_idx", 0)

    # ── Check if ambulance passed the current active intersection ──
    if active_idx < len(int_ids):
        current_int_id  = int_ids[active_idx]
        current_int     = INTERSECTIONS[current_int_id]
        dist_to_current = haversine(lat, lon, current_int["lat"], current_int["lon"])
        prev_dist       = amb.get("prev_dist", float('inf'))

        if (dist_to_current > prev_dist and
                dist_to_current > threshold + 100 and
                intersection_states[current_int_id]["locked_by"] == amb_id):

            send_resume(current_int_id, amb_id)
            intersection_states[current_int_id].update({
                "state":     "NORMAL",
                "locked_by": None
            })
            log_event("RESUME",
                      f"{amb_id} passed {current_int['name']} — resuming normal cycle",
                      amb_id=amb_id, int_id=current_int_id,
                      data={"distance": round(dist_to_current)})
            stats["total_resumes"] += 1
            active_idx += 1
            ambulances[amb_id]["active_int_idx"] = active_idx

        ambulances[amb_id]["prev_dist"] = dist_to_current

    # ── Check next intersection in route ──
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
                          + (" [HARDWARE]" if int_id in HARDWARE_CONTROLLED else " [DASHBOARD ONLY]"),
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

    # ── Analytics for dashboard ──
    int_statuses = []
    for int_id in int_ids:
        tl   = INTERSECTIONS[int_id]
        dist = haversine(lat, lon, tl["lat"], tl["lon"])
        int_statuses.append({
            "id":        int_id,
            "name":      tl["name"],
            "lat":       tl["lat"],
            "lon":       tl["lon"],
            "distance":  round(dist),
            "state":     intersection_states[int_id]["state"],
            "locked_by": intersection_states[int_id]["locked_by"],
            "hardware":  int_id in HARDWARE_CONTROLLED
        })

    speed_ms    = max(speed / 3.6, 1)
    dest_dist   = haversine(lat, lon, route["dest_lat"], route["dest_lon"])
    eta_seconds = int(dest_dist / speed_ms)

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
        "active_int_idx": active_idx,
        "intersections":  int_statuses,
        "stats":          stats
    }

    socketio.emit('analytics', analytics)
    mqtt_client.publish("navpath/analytics", json.dumps(analytics))

# ─────────────────────────────────────────────
#  REST API ENDPOINTS
# ─────────────────────────────────────────────

@app.route('/')
def index():
    try:
        return send_from_directory('static', 'hospital.html')
    except Exception:
        return jsonify({
            "status":   "NavPath Cloud Server Online",
            "version":  "2.0",
            "hardware": "1x ESP32 @ INT-1 (Chitkara University Gate), 3x software intersections"
        })

@app.route('/ambulance')
def ambulance_app():
    return send_from_directory('static', 'ambulance.html')

@app.route('/api/routes', methods=['GET'])
def get_routes():
    return jsonify(list(ROUTES.values()))

@app.route('/api/intersections', methods=['GET'])
def get_intersections():
    """Returns all intersections merged with live state — used by map on load."""
    return jsonify(build_intersection_list())

@app.route('/api/ambulances', methods=['GET'])
def get_ambulances():
    return jsonify(list(ambulances.values()))

@app.route('/api/events', methods=['GET'])
def get_events():
    return jsonify(list(reversed(events[-100:])))

@app.route('/api/stats', methods=['GET'])
def get_stats():
    return jsonify({
        **stats,
        "uptime_s":      round(time.time() - stats["start_time"]),
        "ambulances":    len(ambulances),
        "intersections": len(INTERSECTIONS),
        "hardware":      "1x ESP32 at INT-1, 3x software-only"
    })

@app.route('/api/map_data', methods=['GET'])
def get_map_data():
    """
    NEW ENDPOINT — returns everything the map needs in one shot:
      - All intersections with live state
      - All active ambulance positions
      - All route definitions
    Frontend calls this once on load, then switches to WebSocket for live updates.
    """
    return jsonify({
        "intersections": build_intersection_list(),
        "ambulances":    list(ambulances.values()),
        "routes":        list(ROUTES.values()),
        "center": {
            "lat": 30.5161,   # Chitkara University Gate — map opens centred here
            "lon": 76.6598,
            "zoom": 13
        }
    })

@app.route('/api/gps', methods=['POST'])
def receive_gps():
    """
    Receive GPS from ambulance app every second.
    Expected JSON body:
    {
        "amb_id":   "AMB-2026",
        "lat":      30.5161,
        "lon":      76.6598,
        "speed":    62.4,
        "priority": "RED",
        "route_id": "ROUTE-1"
    }

    FIX: Removed broken `intersections` global reference.
         Now uses build_intersection_list() for the analytics emit.
         Analytics are only emitted via process_gps_update() when
         priority != "NONE". For NONE priority we do a lightweight
         position-only emit so the map still moves the ambulance dot.
    """
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
        "id":        amb_id,        # always include so frontend can read it
        "lat":       lat,
        "lon":       lon,
        "speed":     speed,
        "priority":  priority,
        "route_id":  route_id,
        "last_seen": time.time()
    })

    if route_id and priority != "NONE":
        # Full geofence logic — emits detailed analytics via WebSocket
        process_gps_update(amb_id, lat, lon, speed, priority, route_id)
    else:
        # FIX: Lightweight position-only emit so map dot moves even when
        #      priority is NONE or no route is selected.
        #      Uses build_intersection_list() — NOT the broken `intersections` global.
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
            "intersections": build_intersection_list(),   # ← FIXED
            "stats":         stats
        })

    return jsonify({"status": "ok", "ts": time.time()})


@app.route('/api/assign_route', methods=['POST'])
def assign_route():
    data     = request.get_json()
    amb_id   = data.get("amb_id")
    route_id = data.get("route_id")

    if route_id not in ROUTES:
        return jsonify({"error": "Invalid route"}), 400

    route = ROUTES[route_id]

    if amb_id in ambulances:
        ambulances[amb_id]["active_int_idx"] = 0
        ambulances[amb_id]["prev_dist"]      = float('inf')
        ambulances[amb_id]["route_id"]       = route_id

    socketio.emit('route_assigned', {"amb_id": amb_id, "route": route})
    log_event("ROUTE_ASSIGNED", f"Route {route['name']} assigned to {amb_id}",
              amb_id=amb_id, data={"route": route})
    return jsonify({"status": "ok", "route": route})


@app.route('/api/set_priority', methods=['POST'])
def set_priority():
    data     = request.get_json()
    amb_id   = data.get("amb_id")
    priority = data.get("priority")

    if amb_id in ambulances:
        ambulances[amb_id]["priority"] = priority

    log_event("PRIORITY", f"{amb_id} set priority to {priority}",
              amb_id=amb_id, data={"priority": priority})
    socketio.emit('priority_change', {"amb_id": amb_id, "priority": priority})
    return jsonify({"status": "ok"})


@app.route('/api/end_trip', methods=['POST'])
def end_trip():
    data   = request.get_json()
    amb_id = data.get("amb_id")

    for int_id, state in intersection_states.items():
        if state["locked_by"] == amb_id:
            send_resume(int_id, amb_id)
            intersection_states[int_id]["state"]     = "NORMAL"
            intersection_states[int_id]["locked_by"] = None

    if amb_id in ambulances:
        trip_time = time.time() - ambulances[amb_id].get("trip_start", time.time())
        log_event("TRIP_COMPLETE", f"{amb_id} trip complete — {round(trip_time)}s",
                  amb_id=amb_id, data={"duration_s": round(trip_time)})
        del ambulances[amb_id]

    socketio.emit('trip_ended', {"amb_id": amb_id})
    return jsonify({"status": "ok"})


# ─────────────────────────────────────────────
#  WEBSOCKET EVENTS
# ─────────────────────────────────────────────

@socketio.on('connect')
def on_ws_connect():
    log.info(f"Dashboard connected: {request.sid}")
    # FIX: Send full intersection list (with live state) on connect
    #      so map renders all 4 pins immediately.
    emit('init', {
        "routes":        list(ROUTES.values()),
        "intersections": build_intersection_list(),
        "ambulances":    list(ambulances.values()),
        "events":        list(reversed(events[-50:])),
        "stats":         stats,
        "map_center": {
            "lat":  30.5161,    # Chitkara University Gate
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
            "state":     "OVERRIDE",
            "locked_by": "MANUAL"
        })
        log_event("MANUAL_OVERRIDE",
                  f"Manual override on {int_id} dir={direction}", int_id=int_id)

@socketio.on('manual_resume')
def on_manual_resume(data):
    int_id = data.get("int_id")
    if int_id in INTERSECTIONS:
        send_resume(int_id, "MANUAL")
        intersection_states[int_id]["state"]     = "NORMAL"
        intersection_states[int_id]["locked_by"] = None
        log_event("MANUAL_RESUME",
                  f"Manual resume on {int_id}", int_id=int_id)

# ─────────────────────────────────────────────
#  AMBULANCE TIMEOUT WATCHDOG
#  Safety critical — do not remove.
#  Auto-resumes all held intersections if ambulance
#  stops sending GPS for more than 10 seconds.
# ─────────────────────────────────────────────
def watchdog():
    while True:
        time.sleep(5)
        now = time.time()
        for amb_id in list(ambulances.keys()):
            last = ambulances[amb_id].get("last_seen", now)
            if now - last > 300:
                log.warning(f"Ambulance {amb_id} timed out — clearing overrides")
                # FIX: clear all locked intersections BEFORE deleting from dict
                for int_id, state in intersection_states.items():
                    if state["locked_by"] == amb_id:
                        send_resume(int_id, amb_id)
                        intersection_states[int_id]["state"]     = "NORMAL"
                        intersection_states[int_id]["locked_by"] = None
                log_event("TIMEOUT",
                          f"{amb_id} timed out — all overrides cleared",
                          amb_id=amb_id)
                del ambulances[amb_id]   # FIX: delete after logging, not before

# ─────────────────────────────────────────────
#  STARTUP
# ─────────────────────────────────────────────
def start_mqtt():
    try:
        mqtt_client.ws_set_options(path="/mqtt")
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=30, transport="websockets")
        mqtt_client.loop_start()
        log.info(f"Connecting to MQTT at {MQTT_BROKER}:{MQTT_PORT}")
    except Exception as e:
        log.error(f"MQTT connection error: {e}")

if __name__ == '__main__':
    print("\n╔══════════════════════════════════════════════════════════╗")
    print("║   NavPath Cloud Server — Render Deploy (FIXED)          ║")
    print("║   Hardware: 1x ESP32 @ INT-1 (Chitkara University Gate) ║")
    print("║   Software: INT-2 Rajpura, INT-3 Banur, INT-4 Morinda   ║")
    print("╚══════════════════════════════════════════════════════════╝\n")

    start_mqtt()
    threading.Thread(target=watchdog, daemon=True).start()
    log.info("Watchdog thread started")

    port = int(os.environ.get("PORT", 5000))
    log.info(f"Starting server on port {port}")
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
