from datetime import datetime

# Emergency requests in-memory state
emergency_requests = {}  # id -> request object
request_counter = 0
request_analytics = {
    "total_requests":    0,
    "pending_requests":  0,
    "accepted_requests": 0,
    "completed_requests": 0,
    "avg_response_time": 0,
    "total_response_time": 0
}


def new_request_id():
    global request_counter
    request_counter += 1
    return f"REQ-{request_counter:05d}"


def record_created(req):
    request_analytics["total_requests"] += 1
    request_analytics["pending_requests"] += 1


def record_accepted(response_time):
    request_analytics["pending_requests"] = max(0, request_analytics["pending_requests"] - 1)
    request_analytics["accepted_requests"] += 1
    request_analytics["total_response_time"] += response_time
    if request_analytics["accepted_requests"] > 0:
        request_analytics["avg_response_time"] = request_analytics["total_response_time"] / request_analytics["accepted_requests"]


def record_completed():
    request_analytics["accepted_requests"] = max(0, request_analytics["accepted_requests"] - 1)
    request_analytics["completed_requests"] += 1
*** End Patch