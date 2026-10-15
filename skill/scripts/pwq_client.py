#!/usr/bin/env python3
"""Deterministic CLI client for the PrinceQ local API.

Standard library only. Talks to http://127.0.0.1:28642 (override with
PWQ_API_BASE or --base). Every write sends an Idempotency-Key; by default the
key is fresh for each new invocation. Reuse the printed --idempotency-key
when retrying; --stable-key derives a key from method + full path + body.

Duration: a task's effort fact is always `estimated_minutes`. Supplying
--duration-value with --duration-unit lets the server convert for you, using
the current habits prefs (minute → as-is, day → value*hours_per_day*60,
month → value*days_per_month*hours_per_day*60, rounded). Read or change those
prefs with `habits-duration`.

Settings (`/api/settings/*`): the four habit files are one settings page, read
as a single snapshot with `habits-settings` and written through
`habits-conversion` / `habits-explicit` / `habits-constraints` /
`habits-weights preview|save`. Every settings write carries
`--expected-version` — the matching `versions.*` value from the snapshot — and
a stale one is rejected with 409 `version_conflict` whose body carries the
current snapshot. Read the snapshot immediately before writing; never reuse a
version from an earlier turn.

Exit codes: 0 success, 1 API error (JSON error envelope printed), 2 usage
error, 3 transport failure (service unreachable).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Pipes on Windows otherwise inherit the legacy console code page.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8')

DEFAULT_BASE = os.environ.get("PWQ_API_BASE", "http://127.0.0.1:28642")
TIMEOUT = float(os.environ.get("PWQ_API_TIMEOUT", "130"))

TASK_ACTIONS = (
    "claim", "release", "start", "block", "unblock", "complete", "archive", "restore", "reopen",
)
QUADRANTS = ("q1", "q2", "q3", "q4")
COGNITIVE_LOADS = ("low", "medium", "high")
TASK_TYPES = ("deep_work", "shallow_work", "communication", "admin", "review", "learning")
HABIT_FILES = ("explicit", "inferred")
DURATION_UNITS = ("minute", "day", "month")

# The three kinds `POST /api/settings/constraints` accepts. Reads are tolerant of
# other values (hand-edited legacy data survives a round trip), but creating one
# is restricted to these.
CONSTRAINT_KINDS = ("forbidden_window", "max_daily_minutes", "required_buffer")
WEIGHT_KEYS = (
    "deadline", "manual_priority", "dependency", "effort", "habit_alignment", "context_switch",
)


# --------------------------------------------------------------------------- #
# transport
# --------------------------------------------------------------------------- #

def idempotency_key(method, path, body, op, override=None, fresh=False, stable=False):
    """New calls use fresh keys; explicit reuse or stable mode makes retries replay."""
    if override:
        return override
    if stable and not fresh:
        canonical = json.dumps(body or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        digest = hashlib.sha256(f"{method}\n{path}\n{canonical}".encode()).hexdigest()[:20]
        return f"pwq-{op}-{digest}"
    return f"pwq-{op}-{uuid.uuid4()}"


def request(base: str, method: str, path: str, body: dict | None = None,
            query: dict | None = None, key: str | None = None) -> dict:
    url = base.rstrip("/") + path
    if query:
        clean = {k: v for k, v in query.items() if v is not None}
        if clean:
            url += "?" + urllib.parse.urlencode(clean)

    data = None
    headers = {"Accept": "application/json", "X-PrinceQ-Agent": os.environ.get("PRINCEQ_AGENT_NAME", "princeq-skill-client")}
    if os.environ.get("PWQ_API_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["PWQ_API_TOKEN"]
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key is not None:
        headers["Idempotency-Key"] = key

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": {"code": f"http_{exc.code}", "message": raw[:500]}}
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        sys.exit(1)
    except urllib.error.URLError as exc:
        print(json.dumps({"error": {
            "code": "unreachable",
            "message": f"cannot reach {url}: {exc.reason}",
            "hint": "start the API with 'npm run dev' (or 'npm run dev:api') in the project repo",
        }}, indent=2), file=sys.stderr)
        sys.exit(3)

    return json.loads(raw) if raw else {}


def emit(payload: dict) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def write(args, op: str, path: str, body: dict | None) -> None:
    """Business writes submit a preview; explicit confirmations use their own endpoint."""
    key = idempotency_key("POST", path, body, op, args.idempotency_key, args.new_key, args.stable_key)
    print(f"idempotency-key: {key}", file=sys.stderr)
    emit(submit_or_control(args, "POST", path, body, key))


def patch(args, op: str, path: str, body: dict) -> None:
    key = idempotency_key("PATCH", path, body, op, args.idempotency_key, args.new_key, args.stable_key)
    print(f"idempotency-key: {key}", file=sys.stderr)
    emit(submit_or_control(args, "PATCH", path, body, key))


def submit_or_control(args, method, path, body, key):
    # Conversation/confirmation APIs are explicit controls. Ordinary task/goal/settings
    # writes never execute from the portable client until a preview is accepted.
    if path.startswith('/api/agent/'):
        return request(args.base, method, path, body=body, key=key)
    body = dict(body or {})
    if path.startswith('/api/habits'):
        snapshot = request(args.base, 'GET', '/api/settings')
        if path == '/api/habits':
            path = '/api/settings/explicit'
            body['expected_version'] = snapshot['versions']['explicit']
        elif path == '/api/habits/duration-prefs':
            path = '/api/settings/conversion'
            body['expected_version'] = snapshot['versions']['weights']
        elif path == '/api/habits/weights':
            path = '/api/settings/weights'
            body = {'weights': {**snapshot['weights']['weights'], **body}, 'expected_version':snapshot['versions']['weights']}
        elif path == '/api/habits/enabled':
            file = body.pop('file')
            ident = body.pop('id')
            path = f'/api/settings/{file}/{urllib.parse.quote(ident, safe="")}/enabled'
            body['expected_version'] = snapshot['versions'][file]
    manifest = request(args.base, 'GET', '/api/skills/princeq')
    parts = path.strip('/').split('/')
    for operation in manifest['operations']:
        pattern = operation['path'].strip('/').split('/')
        if operation['method'] != method or len(pattern) != len(parts):
            continue
        if any(a != ':id' and a != b for a,b in zip(pattern,parts)):
            continue
        action = {'action':'skill_operation', 'operation':operation['name'], 'payload':body}
        if ':id' in pattern:
            action['target_id'] = urllib.parse.unquote(parts[pattern.index(':id')])
        return request(args.base, 'POST', '/api/skills/princeq/previews', body={'actions':[action]}, key=key)
    print(json.dumps({'error':{'code':'unsupported_skill_operation','message':f'No preview contract for {method} {path}'}}), file=sys.stderr)
    sys.exit(2)


def cmd_skill_manifest(args):
    emit(request(args.base, 'GET', '/api/skills/princeq'))


def cmd_skill_context(args):
    emit(request(args.base, 'GET', '/api/skills/princeq/context', query={'session_id':args.session_id}))


def cmd_skill_previews(args):
    path = '/api/skills/princeq/previews' + ('/' + urllib.parse.quote(args.token,safe='') if args.token else '')
    emit(request(args.base, 'GET', path))


def cmd_skill_propose(args):
    try:
        raw = sys.stdin.read() if args.json == '-' else args.json
        payload = json.loads(raw)
        actions = payload if isinstance(payload,list) else payload.get('actions',[payload] if payload.get('action') else None)
        if not isinstance(actions,list) or not actions:
            raise ValueError('provide an action, actions array, or {"actions":[...]}')
    except (ValueError, AttributeError) as exc:
        print(f'error: {exc}',file=sys.stderr);sys.exit(2)
    body = {'actions':actions}
    if args.session_id: body['session_id'] = args.session_id
    if args.summary: body['summary'] = args.summary
    key = idempotency_key('POST','/api/skills/princeq/previews',body,'skill-propose',args.idempotency_key,args.new_key,args.stable_key)
    print(f'idempotency-key: {key}',file=sys.stderr)
    emit(request(args.base,'POST','/api/skills/princeq/previews',body=body,key=key))


def cmd_skill_resolve(args):
    if args.command == 'skill-confirm' and not args.confirmed:
        print('error: display the preview and obtain user confirmation, then pass --confirmed',file=sys.stderr);sys.exit(2)
    action = 'confirm' if args.command == 'skill-confirm' else 'cancel'
    path = '/api/skills/princeq/previews/' + urllib.parse.quote(args.token,safe='') + '/' + action
    body = {'confirmed':True} if action == 'confirm' else {}
    key = idempotency_key('POST',path,body,'skill-'+action,args.idempotency_key,args.new_key,args.stable_key)
    print(f'idempotency-key: {key}',file=sys.stderr)
    emit(request(args.base,'POST',path,body=body,key=key))


def cmd_delete_task(args):
    body=prune({'expected_version':args.expected_version})
    key=idempotency_key('DELETE','/api/tasks/'+args.task_id,body,'task-delete',args.idempotency_key,args.new_key,args.stable_key)
    print(f'idempotency-key: {key}',file=sys.stderr)
    emit(submit_or_control(args,'DELETE','/api/tasks/'+urllib.parse.quote(args.task_id,safe=''),body,key))


def cmd_delete_goal(args):
    body=prune({'expected_version':args.expected_version})
    key=idempotency_key('DELETE','/api/goals/'+args.goal_id,body,'goal-delete',args.idempotency_key,args.new_key,args.stable_key)
    print(f'idempotency-key: {key}',file=sys.stderr)
    emit(submit_or_control(args,'DELETE','/api/goals/'+urllib.parse.quote(args.goal_id,safe=''),body,key))


def cmd_remove_dependency(args):
    write(args,'dependency-remove','/api/tasks/'+urllib.parse.quote(args.task_id,safe='')+'/dependencies/remove',{'depends_on_id':args.depends_on_id})


def prune(body: dict) -> dict:
    return {k: v for k, v in body.items() if v is not None}


def duration_pair(args) -> dict:
    """The `{duration_value, duration_unit}` pair, or `{}` when neither was given.

    The two keys must travel together: the server rejects a half-supplied pair
    with `validation_failed`, and inventing the missing half would be guessing
    on the user's behalf. Caught here so the usage error is exit 2, not a 400.
    """
    value, unit = args.duration_value, args.duration_unit
    if value is None and unit is None:
        return {}
    if value is None or unit is None:
        print("error: --duration-value and --duration-unit must be supplied together",
              file=sys.stderr)
        sys.exit(2)
    return {"duration_value": value, "duration_unit": unit}


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def cmd_health(args):
    emit(request(args.base, "GET", "/api/health"))


def cmd_meta(args):
    emit(request(args.base, "GET", "/api/meta"))


def cmd_queue(args):
    emit(request(args.base, "GET", "/api/queue"))


def cmd_recalculate(args):
    body = prune({"reason": args.reason})
    write(args, "queue-recalc", "/api/queue/recalculate", body)


def cmd_explain(args):
    emit(request(args.base, "GET", f"/api/queue/explain/{urllib.parse.quote(args.task_id, safe='')}"))


def cmd_tasks(args):
    emit(request(args.base, "GET", "/api/tasks", query={
        "status": args.status,
        "active": "1" if args.active else None,
        "goal_id": args.goal_id,
        "quadrant": args.quadrant,
        "unconfirmed": "1" if args.unconfirmed else None,
    }))


def cmd_task(args):
    emit(request(args.base, "GET", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}"))


def matrix_score_body(args, with_version=False):
    scores=(args.importance_score, args.urgency_score)
    if any(v is None or not math.isfinite(v) or not 0 <= v <= 100 or abs(v*10-round(v*10)) > 1e-8 for v in scores):
        print("error: both scores must be finite 0..100 numbers with at most one decimal", file=sys.stderr)
        sys.exit(2)
    if not args.reason or not 4 <= len(args.reason.strip()) <= 2000:
        print("error: --reason must contain 4..2000 characters", file=sys.stderr)
        sys.exit(2)
    if args.confidence is not None and (not math.isfinite(args.confidence) or not 0 <= args.confidence <= 1):
        print("error: --confidence must be finite and in 0..1", file=sys.stderr)
        sys.exit(2)
    body=prune({"importance_score":scores[0], "urgency_score":scores[1], "reason":args.reason,
                "source":args.source, "confidence":args.confidence})
    if with_version:
        version=args.expected_version
        if version is None:
            payload=request(args.base,"GET",f"/api/tasks/{urllib.parse.quote(args.task_id,safe='')}")
            version=payload.get("task",{}).get("version")
        if not isinstance(version,int) or isinstance(version,bool) or version <= 0:
            print("error: a positive --expected-version or task version is required",file=sys.stderr)
            sys.exit(2)
        body["expected_version"]=version
    return body


def cmd_score_task(args):
    body=matrix_score_body(args,with_version=True)
    write(args,"task-matrix-score",f"/api/tasks/{urllib.parse.quote(args.task_id,safe='')}/matrix-score",body)


def cmd_rescoring(args):
    if args.action == "list":
        emit(request(args.base,"GET","/api/rescoring-requests",query={"status":args.status}))
        return
    if args.action == "request":
        if not args.task_id or not (args.target_quadrant or args.axis):
            print("error: request requires --task-id and --target-quadrant or --axis",file=sys.stderr);sys.exit(2)
        body=prune({"target_quadrant":args.target_quadrant,"changed_axes":args.axis})
        write(args,"rescore-request",f"/api/tasks/{urllib.parse.quote(args.task_id,safe='')}/rescoring-request",body)
        return
    if not args.id:
        print("error: --id is required",file=sys.stderr);sys.exit(2)
    if args.action == "submit":
        if not args.reason or not 4 <= len(args.reason.strip()) <= 2000 or not args.agent_name or len(args.agent_name) > 120 or (args.importance_score is None and args.urgency_score is None):
            print("error: submit requires --reason, --agent-name and at least one score",file=sys.stderr);sys.exit(2)
        for score in (args.importance_score,args.urgency_score):
            if score is not None and (not math.isfinite(score) or not 0 <= score <= 100 or abs(score*10-round(score*10))>1e-8):
                print("error: scores must be finite 0..100 with one decimal",file=sys.stderr);sys.exit(2)
        if args.confidence is not None and (not math.isfinite(args.confidence) or not 0 <= args.confidence <= 1):
            print("error: --confidence must be finite and in 0..1",file=sys.stderr);sys.exit(2)
        body=prune({"importance_score":args.importance_score,"urgency_score":args.urgency_score,
                    "reason":args.reason,"confidence":args.confidence,"agent_name":args.agent_name})
    else:
        body={}
    write(args,"rescore-"+args.action,f"/api/rescoring-requests/{urllib.parse.quote(args.id,safe='')}/{args.action}",body)


def cmd_create_task(args):
    body = prune({
        "title": args.title,
        "description": args.description,
        "goal_id": args.goal_id,
        "deadline": args.deadline,
        "estimated_minutes": args.estimated_minutes,
        "cognitive_load": args.cognitive_load,
        "task_type": args.task_type,
        "manual_priority": args.manual_priority,
        "importance": args.importance,
        "urgency": args.urgency,
        "depends_on": args.depends_on or None,
    })
    # The pair wins over --estimated-minutes: the server stores the converted
    # minutes and keeps the value+unit for display in the original unit.
    body.update(duration_pair(args))
    if any(v is not None for v in (args.importance_score,args.urgency_score,args.reason,args.source,args.confidence)):
        body["matrix_score"]=matrix_score_body(args)
    write(args, "task-create", "/api/tasks", body)


def cmd_update_task(args):
    body = prune({
        "title": args.title,
        "description": args.description,
        "goal_id": args.goal_id,
        "deadline": args.deadline,
        "estimated_minutes": args.estimated_minutes,
        "cognitive_load": args.cognitive_load,
        "task_type": args.task_type,
        "manual_priority": args.manual_priority,
        "manual_override": args.manual_override,
        "importance": args.importance,
        "urgency": args.urgency,
        "expected_version": args.expected_version,
    })
    body.update(duration_pair(args))
    if not body or set(body) == {"expected_version"}:
        print("error: supply at least one field to update", file=sys.stderr)
        sys.exit(2)
    patch(args, "task-update", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}", body)


def cmd_task_action(args):
    body = prune({"action": args.action, "actor_id": args.actor_id, "reason": args.reason})
    write(args, f"task-{args.action}", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}/actions", body)


def cmd_dependency(args):
    body = {"depends_on_id": args.depends_on_id}
    write(args, "task-dependency", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}/dependencies", body)


def cmd_quadrant_confirm(args):
    write(args, "quadrant-confirm", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}/quadrant/confirm", {})


def cmd_quadrant_resuggest(args):
    write(args, "quadrant-resuggest", f"/api/tasks/{urllib.parse.quote(args.task_id, safe='')}/quadrant/resuggest", {})


def cmd_goals(args):
    emit(request(args.base, "GET", "/api/goals"))


def cmd_goal(args):
    emit(request(args.base, "GET", f"/api/goals/{urllib.parse.quote(args.goal_id, safe='')}"))


def cmd_create_goal(args):
    body = prune({
        "title": args.title,
        "description": args.description,
        "target_date": args.target_date,
        "color": args.color,
    })
    write(args, "goal-create", "/api/goals", body)


def cmd_update_goal(args):
    body = prune({
        "title": args.title,
        "description": args.description,
        "status": args.status,
        "target_date": args.target_date,
        "color": args.color,
        "expected_version": args.expected_version,
    })
    if not body or set(body) == {"expected_version"}:
        print("error: supply at least one field to update", file=sys.stderr)
        sys.exit(2)
    patch(args, "goal-update", f"/api/goals/{urllib.parse.quote(args.goal_id, safe='')}", body)


def cmd_decompose_preview(args):
    gid = urllib.parse.quote(args.goal_id, safe='')
    # Not an idempotent write: it only stores a single-use preview token.
    emit(request(args.base, "POST", f"/api/goals/{gid}/decomposition/preview", body={}))


def cmd_decompose_confirm(args):
    body = prune({
        "preview_token": args.preview_token,
        "accepted_titles": args.accept or None,
    })
    gid = urllib.parse.quote(args.goal_id, safe='')
    write(args, "decompose-confirm", f"/api/goals/{gid}/decomposition/confirm", body)


def cmd_activity(args):
    emit(request(args.base, "GET", "/api/activity", query={"limit": args.limit}))


def cmd_habits_list(args):
    emit(request(args.base, "GET", "/api/habits"))


def cmd_habits_add(args):
    body = prune({"statement": args.statement, "kind": args.kind})
    write(args, "habit-add", "/api/habits", body)


def cmd_habits_disable(args):
    # Default is to disable; --enable flips the entry back on.
    body = {"file": args.file, "id": args.id, "enabled": bool(args.enable)}
    write(args, "habit-enabled", "/api/habits/enabled", body)


def cmd_habits_duration(args):
    """Read the duration conversion prefs, or update one/both of them.

    No flags → a read of `/api/habits`, reduced to the two keys that matter.
    Changing them only affects *later* conversions: minutes already stored on a
    task are the fact recorded at write time and are never recomputed.
    """
    body = prune({"hours_per_day": args.hours_per_day, "days_per_month": args.days_per_month})
    if not body:
        weights = request(args.base, "GET", "/api/habits").get("weights", {})
        payload = weights.get("payload", {})
        emit({
            "hours_per_day": payload.get("hours_per_day"),
            "days_per_month": payload.get("days_per_month"),
            "updated_at": weights.get("updated_at"),
        })
        return
    write(args, "habit-duration-prefs", "/api/habits/duration-prefs", body)


# --------------------------------------------------------------------------- #
# settings (/api/settings/*)
# --------------------------------------------------------------------------- #
#
# The four habit files are one settings page, so they are read as a single
# snapshot and written one resource at a time with optimistic concurrency.
#
# Every write body carries `expected_version` — the matching `versions.*` value
# from the snapshot. A stale one is a 409 `version_conflict` (exit 1) whose body
# carries the current snapshot, so the fix is always "re-read, re-decide,
# re-send", never "retry with a fresh key". Read the snapshot immediately before
# writing; a version from an earlier turn may already be stale.

def settings_snapshot(args) -> dict:
    return request(args.base, "GET", "/api/settings")


def resolve_version(args, file: str, supplied: str | None) -> str:
    """The `expected_version` for `file`: the supplied one, or a freshly read one.

    Omitting --expected-version is a convenience for one-shot calls, not a way
    to skip the check: the version is read a moment before the write, so a
    concurrent change still loses the race and still gets a 409.
    """
    if supplied:
        return supplied
    versions = settings_snapshot(args).get("versions", {})
    version = versions.get(file)
    if not version:
        print(f"error: snapshot has no versions.{file}; cannot build the write",
              file=sys.stderr)
        sys.exit(2)
    return version


def cmd_habits_settings(args):
    """The whole settings snapshot: four versions, weights, conversion, entries."""
    emit(settings_snapshot(args))


def cmd_habits_conversion(args):
    """Change the duration conversion coefficients, or restore the defaults.

    `--reset` restores 8 hours/day and 20 days/month. Changing these affects
    only *later* conversions — minutes already stored on a task are the fact
    recorded at write time and are never recomputed.
    """
    if args.reset:
        if args.hours_per_day is not None or args.days_per_month is not None:
            print("error: --reset restores the defaults; do not combine it with "
                  "--hours-per-day/--days-per-month", file=sys.stderr)
            sys.exit(2)
        body = {"expected_version": resolve_version(args, "weights", args.expected_version)}
        write(args, "settings-conversion-reset", "/api/settings/conversion/reset", body)
        return

    body = prune({"hours_per_day": args.hours_per_day, "days_per_month": args.days_per_month})
    if not body:
        print("error: supply --hours-per-day and/or --days-per-month, or --reset",
              file=sys.stderr)
        sys.exit(2)
    body["expected_version"] = resolve_version(args, "weights", args.expected_version)
    write(args, "settings-conversion", "/api/settings/conversion", body)


def cmd_habits_explicit(args):
    """Explicit (user-stated) habits: list, add, enable/disable, adopt an inferred one."""
    if args.action == "list":
        emit(settings_snapshot(args).get("explicit", []))
        return

    if args.action == "add":
        if not args.statement:
            print("error: habits-explicit add requires --statement", file=sys.stderr)
            sys.exit(2)
        body = prune({"statement": args.statement, "kind": args.kind})
        body["expected_version"] = resolve_version(args, "explicit", args.expected_version)
        write(args, "settings-explicit-create", "/api/settings/explicit", body)
        return

    if args.action == "enable":
        if not args.id:
            print("error: habits-explicit enable requires --id", file=sys.stderr)
            sys.exit(2)
        # Disabling is a soft delete: the entry stays for history, excluded from
        # scoring. There is no hard delete, here or in the API.
        body = {
            "enabled": not args.disable,
            "expected_version": resolve_version(args, "explicit", args.expected_version),
        }
        write(args, "settings-explicit-enabled",
              f"/api/settings/explicit/{urllib.parse.quote(args.id, safe='')}/enabled", body)
        return

    # adopt-inferred — a dual-resource write: it inserts into explicit AND
    # disables the inferred source, so both versions are checked before either
    # file is touched. Either mismatch is a 409 and nothing is written.
    if not args.id:
        print("error: habits-explicit adopt-inferred requires --id (the inferred habit's id)",
              file=sys.stderr)
        sys.exit(2)
    inferred_version, explicit_version = args.expected_version, args.expected_explicit_version
    if inferred_version is None or explicit_version is None:
        versions = settings_snapshot(args).get("versions", {})
        inferred_version = inferred_version or versions.get("inferred")
        explicit_version = explicit_version or versions.get("explicit")
    if not inferred_version or not explicit_version:
        print("error: adopt needs both versions; snapshot is missing one", file=sys.stderr)
        sys.exit(2)
    body = {
        "expected_version": inferred_version,
        "expected_explicit_version": explicit_version,
    }
    write(args, "settings-inferred-adopt",
          f"/api/settings/inferred/{urllib.parse.quote(args.id, safe='')}/adopt", body)


def cmd_habits_inferred(args):
    """Inferred habits: list, or enable/disable one.

    There is deliberately no add/edit — an inferred habit is an observation, not
    something the user said. Promote one with `habits-explicit adopt-inferred`.
    """
    if args.action == "list":
        emit(settings_snapshot(args).get("inferred", []))
        return
    if not args.id:
        print("error: habits-inferred enable requires --id", file=sys.stderr)
        sys.exit(2)
    body = {
        "enabled": not args.disable,
        "expected_version": resolve_version(args, "inferred", args.expected_version),
    }
    write(args, "settings-inferred-enabled",
          f"/api/settings/inferred/{urllib.parse.quote(args.id, safe='')}/enabled", body)


def cmd_habits_constraints(args):
    """Hard constraints: list, add, enable/disable. Highest habit precedence."""
    if args.action == "list":
        emit(settings_snapshot(args).get("constraints", []))
        return

    if args.action == "add":
        if not args.statement or not args.kind or args.value is None:
            print("error: habits-constraints add requires --statement, --kind and --value",
                  file=sys.stderr)
            sys.exit(2)
        body = {
            "statement": args.statement,
            "kind": args.kind,
            "value": args.value,
            "expected_version": resolve_version(args, "constraints", args.expected_version),
        }
        write(args, "settings-constraint-create", "/api/settings/constraints", body)
        return

    if not args.id:
        print("error: habits-constraints enable requires --id", file=sys.stderr)
        sys.exit(2)
    body = {
        "enabled": not args.disable,
        "expected_version": resolve_version(args, "constraints", args.expected_version),
    }
    write(args, "settings-constraint-enabled",
          f"/api/settings/constraints/{urllib.parse.quote(args.id, safe='')}/enabled", body)


def weights_draft(args) -> dict:
    """The `{weights, preferred_task_types?, peak_hours?}` body to try or store.

    Two ways to say it, and they are mutually exclusive:

    - `--json '{"weights": {...}, "peak_hours": [...]}'` — the whole draft. The
      server requires all six weights, so a `--json` draft must carry all six:
      a half-draft would silently mean "the other five keep their stored
      values", which is not what a preview should be showing.
    - individual `--deadline 2 --effort 0 …` flags — merged over the *current*
      stored weights, which are read here and sent explicitly, so the resulting
      draft is still complete and the preview still shows the real outcome.
    """
    named = prune({key: getattr(args, key) for key in WEIGHT_KEYS})
    if args.json and named:
        print("error: use --json or the individual weight flags, not both", file=sys.stderr)
        sys.exit(2)

    if not args.json:
        if not named:
            print("error: supply --json, or at least one of: "
                  + ", ".join(f"--{key.replace('_', '-')}" for key in WEIGHT_KEYS),
                  file=sys.stderr)
            sys.exit(2)
        stored = settings_snapshot(args).get("weights", {}).get("weights", {})
        missing = [key for key in WEIGHT_KEYS if key not in stored and key not in named]
        if missing:
            print("error: snapshot is missing these weights, so they must be given "
                  "explicitly: " + ", ".join(missing), file=sys.stderr)
            sys.exit(2)
        return {"weights": {**stored, **named}}

    try:
        draft = json.loads(args.json)
    except json.JSONDecodeError as exc:
        print(f"error: --json is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(2)
    if not isinstance(draft, dict):
        print("error: --json must be an object, e.g. "
              '\'{"weights": {"deadline": 2, ...}}\'', file=sys.stderr)
        sys.exit(2)
    # Accept the six weights at the top level as a shorthand for {"weights": …}.
    if "weights" not in draft and any(key in draft for key in WEIGHT_KEYS):
        draft = {"weights": draft}
    weights = draft.get("weights")
    if not isinstance(weights, dict):
        print('error: --json needs a "weights" object with all six keys: '
              + ", ".join(WEIGHT_KEYS), file=sys.stderr)
        sys.exit(2)
    missing = [key for key in WEIGHT_KEYS if key not in weights]
    if missing:
        print("error: --json is missing these weights: " + ", ".join(missing), file=sys.stderr)
        sys.exit(2)
    return {k: v for k, v in draft.items()
            if k in ("weights", "preferred_task_types", "peak_hours", "task_type_peak_hours")}


def cmd_habits_weights(args):
    """Try a weights draft (`preview`) or store it (`save`).

    `preview` writes nothing at all — no file, no history entry, no operation
    log row, no version bump — and takes no `expected_version`, so previewing
    repeatedly can never make the user's own version stale.
    """
    draft = weights_draft(args)
    if args.action == "preview":
        emit(request(args.base, "POST", "/api/settings/weights/preview", body=draft))
        return
    draft["expected_version"] = resolve_version(args, "weights", args.expected_version)
    write(args, "settings-weights-save", "/api/settings/weights", draft)


def cmd_agent_message(args):
    body = prune({"message": args.message, "session_id": args.session_id, "actor_id": args.actor_id, "processing_mode":"agent", "fallback":False})
    write(args, "agent-message", "/api/agent/message", body)


def cmd_agent_preview(args):
    if args.action == "confirm" and not args.confirmed:
        print("error: confirmation requires --confirmed after user approval",file=sys.stderr);sys.exit(2)
    body=prune({"token":args.token,"session_id":args.session_id})
    write(args,"agent-preview-"+args.action,"/api/agent/preview/"+args.action,body)


def cmd_agent_confirm(args):
    if not args.confirmed:
        print("error: confirmation requires --confirmed after user approval",file=sys.stderr);sys.exit(2)
    body = prune({"token": args.token, "session_id": args.session_id, "actor_id": args.actor_id})
    write(args, "agent-confirm", "/api/agent/confirm", body)


def cmd_agent_cancel(args):
    body = prune({"token": args.token, "session_id": args.session_id, "actor_id": args.actor_id})
    write(args, "agent-cancel", "/api/agent/cancel", body)


def cmd_agent_sessions(args):
    if args.session_id:
        emit(request(args.base, "GET", f"/api/agent/sessions/{urllib.parse.quote(args.session_id, safe='')}"))
    else:
        emit(request(args.base, "GET", "/api/agent/sessions"))


# --------------------------------------------------------------------------- #
# parser
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pwq_client.py",
        description=(
            "PrinceQ Skill client: business writes create previews; skill-confirm --confirmed executes after user approval. "
            "Effort is always stored as estimated_minutes; --duration-value with "
            "--duration-unit (minute|day|month) lets the server convert using the "
            "current habits prefs (see habits-duration)."
        ),
    )
    p.add_argument("--base", default=DEFAULT_BASE, help=f"API base URL (default {DEFAULT_BASE})")
    p.add_argument("--idempotency-key", default=None, help="explicit Idempotency-Key for this write")
    p.add_argument("--new-key", action="store_true", default=False,
                   help="fresh key (compatibility alias; fresh is already the default)")
    p.add_argument("--stable-key", action="store_true", default=False,
                   help="derive a retry key from method + full path + body")

    # The same global flags, repeated on every subcommand so they work on either
    # side of it. SUPPRESS keeps an omitted flag from clobbering the global value.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--base", default=argparse.SUPPRESS)
    common.add_argument("--idempotency-key", default=argparse.SUPPRESS)
    common.add_argument("--new-key", action="store_true", default=argparse.SUPPRESS)
    common.add_argument("--stable-key", action="store_true", default=argparse.SUPPRESS)

    sub = p.add_subparsers(dest="command", required=True)

    def add(name, fn, help_text):
        s = sub.add_parser(name, help=help_text, parents=[common])
        s.set_defaults(func=fn)
        return s

    def add_duration(s):
        """The value+unit pair, shared by create-task and update-task."""
        s.add_argument("--duration-value", type=float, metavar="N",
                       help="duration in --duration-unit; converted to estimated_minutes "
                            "with the current habits prefs. Requires --duration-unit")
        s.add_argument("--duration-unit", choices=DURATION_UNITS,
                       help="unit of --duration-value: minute → as-is, "
                            "day → N*hours_per_day*60, month → N*days_per_month*hours_per_day*60. "
                            "Overrides --estimated-minutes in the same call")

    # reads
    add("health", cmd_health, "service status, db path, row counts")
    add("meta", cmd_meta, "quadrant labels, supported agent commands, actors")
    add("queue", cmd_queue, "current ranking with score breakdowns")
    add("goals", cmd_goals, "list goals with progress")
    add("habits-list", cmd_habits_list, "read all four habit files")

    s = add("tasks", cmd_tasks, "list tasks with filters")
    s.add_argument("--status", help="comma-separated statuses")
    s.add_argument("--active", action="store_true", help="only inbox/claimed/in_progress/blocked")
    s.add_argument("--goal-id")
    s.add_argument("--quadrant", choices=QUADRANTS + ("unclassified",))
    s.add_argument("--unconfirmed", action="store_true", help="only unconfirmed quadrants")

    s = add("task", cmd_task, "one task with assignments and score explanation")
    s.add_argument("task_id")

    s = add("explain", cmd_explain, "score breakdown for one task")
    s.add_argument("task_id")

    s = add("goal", cmd_goal, "one goal with its tasks")
    s.add_argument("goal_id")

    s = add("activity", cmd_activity, "operation log plus recent snapshots")
    s.add_argument("--limit", type=int, default=50, help="1-500, default 50")

    s = add("agent-sessions", cmd_agent_sessions, "list agent sessions, or one session's history")
    s.add_argument("--session-id")

    # Portable Skill read/preview/confirmation entrypoints.
    add('skill-manifest',cmd_skill_manifest,'read the current PrinceQ operation schemas')
    s=add('skill-context',cmd_skill_context,'complete tasks/goals/settings and optional session history')
    s.add_argument('--session-id')
    s=add('skill-previews',cmd_skill_previews,'list pending previews or read one token')
    s.add_argument('token',nargs='?')
    s=add('skill-propose',cmd_skill_propose,'propose one/batch operations without changing business data')
    s.add_argument('--json',required=True,help='action / actions array / object; use - to read stdin')
    s.add_argument('--session-id')
    s.add_argument('--summary')
    s=add('skill-confirm',cmd_skill_resolve,'execute a preview only after explicit user approval')
    s.add_argument('token')
    s.add_argument('--confirmed',action='store_true')
    s=add('skill-cancel',cmd_skill_resolve,'cancel a preview without executing it')
    s.add_argument('token')
    s=add('delete-task',cmd_delete_task,'preview permanent task deletion')
    s.add_argument('task_id');s.add_argument('--expected-version',type=int)
    s=add('delete-goal',cmd_delete_goal,'preview permanent deletion of goal and all linked tasks')
    s.add_argument('goal_id');s.add_argument('--expected-version',type=int)
    s=add('remove-dependency',cmd_remove_dependency,'preview dependency removal')
    s.add_argument('task_id');s.add_argument('depends_on_id')

    # task writes
    s = add("create-task", cmd_create_task, "create a task (runs quadrant inference)")
    s.add_argument("title")
    s.add_argument("--description")
    s.add_argument("--goal-id")
    s.add_argument("--deadline", help="ISO date or datetime")
    s.add_argument("--estimated-minutes", type=int,
                   help="1-10000; the stored effort fact. Ignored when the duration pair is given")
    add_duration(s)
    s.add_argument("--cognitive-load", choices=COGNITIVE_LOADS)
    s.add_argument("--task-type", choices=TASK_TYPES)
    s.add_argument("--manual-priority", type=int, help="-2..2")
    s.add_argument("--importance", type=int, help="1..5; with --urgency marks quadrant user-confirmed")
    s.add_argument("--urgency", type=int, help="1..5")
    s.add_argument("--depends-on", action="append", metavar="TASK_ID")

    s.add_argument("--importance-score",type=float)
    s.add_argument("--urgency-score",type=float)
    s.add_argument("--reason",help="4..2000 characters; explain both axes")
    s.add_argument("--source",choices=("agent","user"))
    s.add_argument("--confidence",type=float)

    s=add("score-task",cmd_score_task,"submit continuous matrix scores; remains unconfirmed for source=agent")
    s.add_argument("task_id")
    s.add_argument("--importance-score",type=float,required=True)
    s.add_argument("--urgency-score",type=float,required=True)
    s.add_argument("--reason",required=True)
    s.add_argument("--source",choices=("agent","user"))
    s.add_argument("--confidence",type=float)
    s.add_argument("--expected-version",type=int,help="read automatically when omitted")

    s=add("rescoring",cmd_rescoring,"request/submit/confirm/cancel rescoring without invented axis values")
    s.add_argument("action",choices=("list","request","submit","confirm","cancel"))
    s.add_argument("--task-id")
    s.add_argument("--id")
    s.add_argument("--status",choices=("pending","awaiting_confirm","done","cancelled"))
    s.add_argument("--target-quadrant",choices=QUADRANTS)
    s.add_argument("--axis",action="append",choices=("importance","urgency"))
    s.add_argument("--importance-score",type=float)
    s.add_argument("--urgency-score",type=float)
    s.add_argument("--reason")
    s.add_argument("--agent-name")
    s.add_argument("--confidence",type=float)

    s = add("update-task", cmd_update_task, "patch task fields (not status)")
    s.add_argument("task_id")
    s.add_argument("--title")
    s.add_argument("--description")
    s.add_argument("--goal-id")
    s.add_argument("--deadline")
    s.add_argument("--estimated-minutes", type=int,
                   help="1-10000; leaves duration_value/duration_unit as they are")
    add_duration(s)
    s.add_argument("--cognitive-load", choices=COGNITIVE_LOADS)
    s.add_argument("--task-type", choices=TASK_TYPES)
    s.add_argument("--manual-priority", type=int)
    s.add_argument("--manual-override", type=float, help="-50..50")
    s.add_argument("--importance", type=int)
    s.add_argument("--urgency", type=int)
    s.add_argument("--expected-version", type=int)

    s = add("task-action", cmd_task_action, "apply a lifecycle action")
    s.add_argument("task_id")
    s.add_argument("action", choices=TASK_ACTIONS)
    s.add_argument("--actor-id", help="defaults to actor-human-me")
    s.add_argument("--reason")

    s = add("dependency", cmd_dependency, "add a dependency edge")
    s.add_argument("task_id")
    s.add_argument("depends_on_id")

    s = add("quadrant-confirm", cmd_quadrant_confirm, "accept the suggested quadrant")
    s.add_argument("task_id")

    s = add("quadrant-resuggest", cmd_quadrant_resuggest, "re-run the local keyword rules")
    s.add_argument("task_id")

    # goal writes
    s = add("create-goal", cmd_create_goal, "create a goal")
    s.add_argument("title")
    s.add_argument("--description")
    s.add_argument("--target-date")
    s.add_argument("--color")

    s = add("update-goal", cmd_update_goal, "patch goal fields")
    s.add_argument("goal_id")
    s.add_argument("--title")
    s.add_argument("--description")
    s.add_argument("--status", choices=("active", "paused", "achieved", "dropped"))
    s.add_argument("--target-date")
    s.add_argument("--color")
    s.add_argument("--expected-version", type=int)

    s = add("decompose-preview", cmd_decompose_preview, "draft tasks for a goal, writing nothing")
    s.add_argument("goal_id")

    s = add("decompose-confirm", cmd_decompose_confirm, "create accepted drafts from a preview token")
    s.add_argument("goal_id")
    s.add_argument("preview_token")
    s.add_argument("--accept", action="append", metavar="TITLE",
                   help="exact draft title; repeatable; omit to accept all")

    # queue + habit writes
    s = add("recalculate", cmd_recalculate, "force a new queue snapshot")
    s.add_argument("--reason")

    s = add("habits-add", cmd_habits_add, "append an explicit habit")
    s.add_argument("statement")
    s.add_argument("--kind")

    s = add("habits-disable", cmd_habits_disable, "disable (or re-enable) a habit entry")
    s.add_argument("file", choices=HABIT_FILES)
    s.add_argument("id")
    s.add_argument("--enable", action="store_true", help="re-enable instead of disabling")

    s = add("habits-weights", cmd_habits_weights,
            "try (preview) or store (save) the six scoring weights, each 0-2")
    s.add_argument("action", choices=("preview", "save"),
                   help="preview writes nothing at all; save stores the draft")
    s.add_argument("--json", metavar="JSON",
                   help='the whole draft, e.g. \'{"weights": {"deadline": 2, '
                        '"manual_priority": 1, "dependency": 1, "effort": 0, '
                        '"habit_alignment": 1, "context_switch": 1}, "peak_hours": [9, 10]}\'. '
                        "All six weights are required; preferred_task_types and "
                        "peak_hours are optional and keep their stored values when omitted")
    for w in ("deadline", "manual-priority", "dependency", "effort", "habit-alignment",
              "context-switch"):
        s.add_argument(f"--{w}", type=float,
                       help="0-2; merged over the currently stored weights. "
                            "Cannot be combined with --json")
    s.add_argument("--expected-version", metavar="ISO",
                   help="versions.weights from the snapshot (save only); "
                        "read fresh when omitted")

    s = add("habits-duration", cmd_habits_duration,
            "read or change the duration conversion prefs (hours/day, days/month)")
    s.add_argument("--hours-per-day", type=float, metavar="H",
                   help="0.5-24; used for day → minutes (and month → minutes)")
    s.add_argument("--days-per-month", type=float, metavar="D",
                   help="1-31; used for month → minutes. Omit both flags to read the current prefs")

    # settings (/api/settings/*) — one snapshot, four independently versioned
    # files. Every write takes --expected-version; omit it and the version is
    # read a moment before the write (convenience, not a way to skip the check).
    add("habits-settings", cmd_habits_settings,
        "the whole settings snapshot: four versions, weights, conversion, all entries")

    s = add("habits-conversion", cmd_habits_conversion,
            "change the duration conversion coefficients, or --reset to 8h/20d")
    s.add_argument("--hours-per-day", type=float, metavar="H", help="0.5-24")
    s.add_argument("--days-per-month", type=int, metavar="D",
                   help="1-31, whole days only")
    s.add_argument("--reset", action="store_true",
                   help="restore the defaults (8 hours/day, 20 days/month)")
    s.add_argument("--expected-version", metavar="ISO",
                   help="versions.weights from the snapshot; read fresh when omitted")

    s = add("habits-explicit", cmd_habits_explicit,
            "explicit habits: list, add, enable/disable, or adopt an inferred one")
    s.add_argument("action", choices=("list", "add", "enable", "adopt-inferred"))
    s.add_argument("--statement", help="the habit, in the user's own words (add)")
    s.add_argument("--kind", help="free-form grouping label; defaults to preference (add)")
    s.add_argument("--id", help="entry id (enable), or the inferred habit's id (adopt-inferred)")
    s.add_argument("--disable", action="store_true",
                   help="with `enable`: turn the entry off instead. A soft delete — "
                        "the entry is kept for history and excluded from scoring")
    s.add_argument("--expected-version", metavar="ISO",
                   help="versions.explicit from the snapshot "
                        "(versions.inferred for adopt-inferred); read fresh when omitted")
    s.add_argument("--expected-explicit-version", metavar="ISO",
                   help="adopt-inferred only: versions.explicit. Adopt writes both files, "
                        "so both versions are checked before either is touched")

    s = add("habits-inferred", cmd_habits_inferred,
            "inferred habits: list, or enable/disable one (no add — they are observations)")
    s.add_argument("action", choices=("list", "enable"))
    s.add_argument("--id", help="entry id (enable)")
    s.add_argument("--disable", action="store_true", help="turn the entry off instead")
    s.add_argument("--expected-version", metavar="ISO",
                   help="versions.inferred from the snapshot; read fresh when omitted")

    s = add("habits-constraints", cmd_habits_constraints,
            "hard constraints: list, add, or enable/disable one")
    s.add_argument("action", choices=("list", "add", "enable"))
    s.add_argument("--statement", help="what the constraint says, in plain words (add)")
    s.add_argument("--kind", choices=CONSTRAINT_KINDS,
                   help="add only. Reads tolerate other (legacy, hand-edited) kinds")
    s.add_argument("--value", help="the constraint's value, e.g. 20:00-07:00 or 240 (add)")
    s.add_argument("--id", help="entry id (enable)")
    s.add_argument("--disable", action="store_true", help="turn the constraint off instead")
    s.add_argument("--expected-version", metavar="ISO",
                   help="versions.constraints from the snapshot; read fresh when omitted")

    # agent
    s = add("agent-preview",cmd_agent_preview,"confirm/cancel a model write preview (distinct from goal decomposition)")
    s.add_argument("action",choices=("confirm","cancel"))
    s.add_argument("--confirmed",action="store_true")
    s.add_argument("token")
    s.add_argument("--session-id")
    s = add("agent-message", cmd_agent_message, "send a deterministic natural-language command")
    s.add_argument("message")
    s.add_argument("--session-id")
    s.add_argument("--actor-id")

    s = add("agent-confirm", cmd_agent_confirm, "confirm a pending agent preview token")
    s.add_argument("--confirmed",action="store_true")
    s.add_argument("token")
    s.add_argument("--session-id")
    s.add_argument("--actor-id")

    s = add("agent-cancel", cmd_agent_cancel, "cancel a pending agent preview token, writing nothing")
    s.add_argument("token")
    s.add_argument("--session-id")
    s.add_argument("--actor-id")

    return p


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
