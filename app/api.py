from flask import Blueprint, jsonify, request
from datetime import datetime
from .requests_state import emergency_requests, new_request_id, record_created, record_accepted, record_completed, request_analytics

emergency_bp = Blueprint('emergency', __name__)


@emergency_bp.route('/api/emergency_requests', methods=['POST'])
def create_emergency_request():
    data = request.get_json()
    if not data:
        return jsonify({"error": "No data"}), 400

    req_id = new_request_id()
    now = datetime.now().isoformat()
    new_request = {
        "id": req_id,
        "patient_name": data.get("patient_name", "Unknown Patient"),
        "location": data.get("location", "Unknown Location"),
        "priority": data.get("priority", "YELLOW"),
        "phone": data.get("phone", ""),
        "medical_issue": data.get("medical_issue", ""),
        "status": "PENDING",
        "created_at": now,
        "assigned_ambulance": None,
        "accepted_at": None,
        "completed_at": None,
        "response_time": None
    }

    emergency_requests[req_id] = new_request
    record_created(new_request)

    # Emit via SocketIO if available (import at runtime to avoid circular import)
    try:
        from server import socketio
        socketio.emit('request_created', new_request)
    except Exception:
        pass

    return jsonify(new_request), 201


@emergency_bp.route('/api/emergency_requests', methods=['GET'])
def get_emergency_requests():
    status = request.args.get('status')
    result = list(emergency_requests.values())
    if status:
        result = [r for r in result if r['status'] == status]
    result.sort(key=lambda x: x['created_at'], reverse=True)
    return jsonify(result)


@emergency_bp.route('/api/emergency_requests/<req_id>', methods=['GET'])
def get_emergency_request(req_id):
    if req_id not in emergency_requests:
        return jsonify({"error": "Request not found"}), 404
    return jsonify(emergency_requests[req_id])


@emergency_bp.route('/api/emergency_requests/<req_id>/accept', methods=['POST'])
def accept_emergency_request(req_id):
    # Accept and dispatch an emergency request
    if req_id not in emergency_requests:
        return jsonify({"error": "Request not found"}), 404

    data = request.get_json() or {}
    amb_id = data.get('amb_id')

    if not amb_id:
        return jsonify({"error": "Ambulance ID required"}), 400

    # Check ambulance availability by inspecting server.ambulances at runtime
    try:
        from server import ambulances
    except Exception:
        ambulances = {}

    if amb_id not in ambulances:
        return jsonify({"error": f"Ambulance {amb_id} not available"}), 400

    req = emergency_requests[req_id]
    now = datetime.now().isoformat()
    req['status'] = 'ACCEPTED'
    req['assigned_ambulance'] = amb_id
    req['accepted_at'] = now

    created = datetime.fromisoformat(req['created_at'])
    accepted = datetime.fromisoformat(req['accepted_at'])
    response_time = (accepted - created).total_seconds()
    req['response_time'] = int(response_time)

    record_accepted(response_time)

    try:
        from server import socketio
        socketio.emit('request_updated', req)
    except Exception:
        pass

    return jsonify(req)


@emergency_bp.route('/api/emergency_requests/<req_id>/complete', methods=['POST'])
def complete_emergency_request(req_id):
    if req_id not in emergency_requests:
        return jsonify({"error": "Request not found"}), 404

    req = emergency_requests[req_id]
    req['status'] = 'COMPLETED'
    req['completed_at'] = datetime.now().isoformat()

    record_completed()

    try:
        from server import socketio
        socketio.emit('request_updated', req)
    except Exception:
        pass

    return jsonify(req)


@emergency_bp.route('/api/request_analytics', methods=['GET'])
def get_request_analytics():
    avg = request_analytics.get('avg_response_time', 0)
    return jsonify({
        **request_analytics,
        "response_time_str": f"{int(avg//60)}:{int(avg%60):02d}" if avg > 0 else "0:00"
    })
