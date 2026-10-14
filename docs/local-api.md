# PrinceQ · Local API reference

> `server/http/routes.ts` is the source of truth for this surface. This document is kept in sync with it.

Base URL: `http://127.0.0.1:28642`

Loopback only by default (`API_HOST = 127.0.0.1`, `API_PORT = 28642`; override with `PWQ_API_HOST` / `PWQ_API_PORT`). No auth, no TLS — the service is not meant to be reachable from another host.

- JSON in, JSON out. Request bodies must be `application/json`; bodies over 256 KiB are rejected with `bad_request`.
- Every successful response is `200` with `Cache-Control: no-store`. There is no `201`.
- Agent responses disclose `mode` and `source`: enabled local Claude/Codex uses `agent`; otherwise the explicit command parser uses `deterministic-local`. Model write intents require preview confirmation.
- SQLite at `data/work-queue.db` (`PWQ_DB_PATH`) is the single source of truth, shared live with the web UI on port `28641`. Queue scoring uses algorithm version `pwq-queue-1.0.0`.
- Habit files live in `habits/*.json` (`PWQ_HABITS_DIR`) and are read on every queue recalculation.

Seeded actors (`GET /api/meta` returns the live list; `display_name_zh` is the Chinese display mirror):

| id | kind | display_name | display_name_zh |
|----|------|--------------|-----------------|
| `actor-human-me` | human — the default actor for every write | Me | 我 |
| `actor-agent-local` | agent | Local Agent (deterministic) | 本地助手（确定性） |
| `actor-automation-cron` | automation | Scheduled automation | 定时自动化 |

## Conventions

### Idempotency

Send an `Idempotency-Key` request header on every write (`POST`, `PATCH`). Keys are global across operation types and never expire — they are rows in the `operations` table.

- First call with a key: the mutation runs, the queue is recalculated, and the operation is logged. All three commit or roll back together.
- Repeat call with the same key: the stored response is returned verbatim with `replayed: true` (and `operation.replayed: true`). The mutation does **not** re-run, so no duplicate task and no stolen claim. The request body is not even compared — the key alone decides.
- On a replay, `queue_snapshot` is `null` (no recalculation happened).
- Omitting the header is allowed: the server generates a per-request key (`task-create-<uuid>` etc.), which makes the call effectively non-idempotent. Retries will duplicate.

`replayed` only appears in the response envelope of some routes; see the per-endpoint sections.

### Errors

Every failure returns the same shape:

```json
{ "error": { "code": "conflict", "message": "…", "details": { "from": "completed", "action": "claim" } } }
```

`details` is optional and route-specific.

| code | status | raised when |
|------|--------|-------------|
| `validation_failed` | 400 | zod rejected the body or query string; `details` is the zod issue array — including a half-supplied `duration_value`/`duration_unit` pair and out-of-range duration prefs |
| `bad_request` | 400 | malformed/oversized JSON, dependency cycle, self-dependency, no accepted drafts, no suggested quadrant to confirm, a manual quadrant move, a failed duration conversion, clearing a duration while a unit is still set |
| `not_found` | 404 | unknown task/goal/actor/session id, unknown habit id, unknown or expired preview token |
| `method_not_allowed` | 405 | the path exists under a different method |
| `not_found` | 404 | the path matches no route at all |
| `conflict` | 409 | invalid lifecycle transition, claim held by another actor, `expected_version` mismatch, already-confirmed preview, SQLite `UNIQUE constraint failed` |
| `version_conflict` | 409 | a `/api/settings/*` write's `expected_version` no longer matches that file's `updated_at`; the response body also carries the current `snapshot` |
| `unprocessable` | 422 | defined in `server/lib/errors.ts` but not raised by any current route |
| `internal_error` | 500 | unhandled exception; `message` is the raw error text |

### Optimistic concurrency

`PATCH /api/tasks/:id` and `PATCH /api/goals/:id` accept an optional `expected_version` (positive integer). If it does not equal the stored `version`, the write is rejected with `conflict` and `details: { expected, actual }` (tasks only). Omit it to force the write. `version` increments on every mutation of the row, including lifecycle actions and quadrant changes.

The `/api/settings/*` writes use the same idea against the habit files, with three differences: the version is the file's `updated_at` **timestamp string**, it is **required** rather than optional (there is no way to force a settings write), and a mismatch is `version_conflict` with the current snapshot attached. The four files are versioned independently, so editing a constraint cannot invalidate a pending weights save.

### CORS

Preflight `OPTIONS` returns `204`. `Access-Control-Allow-Origin` is echoed only for `http://localhost:28641` and `http://127.0.0.1:28641`. Allowed methods: `GET, POST, PATCH, OPTIONS`. Allowed headers: `Content-Type, Idempotency-Key`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api` | Service hint returned for discovery |
| GET | `/api/health` | Mode, db path, algorithm version, row counts |
| GET | `/api/meta` | Quadrant labels, agent mode, supported commands, actors |
| GET | `/api/tasks` | List tasks with filters |
| POST | `/api/tasks` | Create a task (runs quadrant inference) |
| GET | `/api/tasks/:id` | Task + assignment history + score explanation |
| PATCH | `/api/tasks/:id` | Update task fields |
| POST | `/api/tasks/:id/actions` | Apply a lifecycle action |
| POST | `/api/tasks/:id/dependencies` | Add a dependency edge |
| POST | `/api/tasks/:id/quadrant/confirm` | Accept the suggested quadrant |
| POST | `/api/tasks/:id/quadrant/change` | Override the quadrant |
| POST | `/api/tasks/:id/quadrant/resuggest` | Re-run quadrant inference |
| GET | `/api/goals` | List goals with progress |
| POST | `/api/goals` | Create a goal |
| GET | `/api/goals/:id` | Goal + its tasks |
| PATCH | `/api/goals/:id` | Update goal fields |
| POST | `/api/goals/:id/decomposition/preview` | Draft tasks without writing any |
| POST | `/api/goals/:id/decomposition/confirm` | Create the accepted drafts |
| GET | `/api/queue` | Current ranking with score breakdowns |
| POST | `/api/queue/recalculate` | Force a new snapshot |
| GET | `/api/queue/explain/:id` | Score breakdown for one task |
| GET | `/api/activity` | Operation log + recent snapshots |
| GET | `/api/habits` | All four habit files |
| POST | `/api/habits` | Add an explicit habit |
| POST | `/api/habits/enabled` | Enable/disable a habit |
| POST | `/api/habits/weights` | Update scoring weights |
| POST | `/api/habits/duration-prefs` | Update the duration conversion prefs (hours/day, days/month) |
| GET | `/api/settings` | The whole settings snapshot (four versions + all four files, flattened) |
| POST | `/api/settings/conversion` | Set the duration conversion coefficients |
| POST | `/api/settings/conversion/reset` | Restore 8 hours/day, 20 days/month |
| POST | `/api/settings/constraints` | Create a hard constraint |
| PATCH | `/api/settings/constraints/:id` | Edit a constraint's statement / kind / value |
| POST | `/api/settings/constraints/:id/enabled` | Enable or disable a constraint |
| POST | `/api/settings/explicit` | Create an explicit habit |
| PATCH | `/api/settings/explicit/:id` | Edit an explicit habit's statement / kind |
| POST | `/api/settings/explicit/:id/enabled` | Enable or disable an explicit habit |
| POST | `/api/settings/inferred/:id/enabled` | Enable or disable an inferred habit |
| POST | `/api/settings/inferred/:id/adopt` | Adopt an inferred habit as an explicit one |
| POST | `/api/settings/weights/preview` | Try a weights draft — writes nothing |
| POST | `/api/settings/weights` | Store the scoring weights and preferences |
| POST | `/api/agent/message` | Send a natural-language command |
| POST | `/api/agent/confirm` | Confirm a pending agent preview |
| GET | `/api/agent/sessions` | 20 most recently updated sessions |
| GET | `/api/agent/sessions/:id` | Session + full message history |
| GET | `/api/events` | SSE stream of queue snapshots |

Writes that go through `withOperation` (operation log + idempotency + queue refresh): `POST /api/tasks`, `PATCH /api/tasks/:id`, all four `POST /api/tasks/:id/*` routes, `POST /api/goals`, `PATCH /api/goals/:id`, `POST /api/goals/:id/decomposition/confirm`, `POST /api/queue/recalculate`, the four `/api/habits` writes, the twelve `/api/settings/*` writes, and both agent routes (wrapped inside the adapter). `POST /api/goals/:id/decomposition/preview` does **not** — it only inserts a pending-preview row, and neither does `POST /api/settings/weights/preview`, which writes nothing at all. `POST /api/habits/duration-prefs` is logged like the rest but skips the queue refresh: it changes no task's minutes, so no ranking input moved. The `/api/settings/*` writes skip it too, except `POST /api/settings/weights` — those six numbers are the ranking formula's coefficients, so that one re-ranks on the spot.

### GET /api/health

No params. Returns `status`, `mode`, `database`, `algorithm_version`, `now`, `counts: { goals, tasks, operations }`.

### GET /api/meta

No params. Returns `quadrant_labels` (raw English reason phrases stored as `quadrant_reason`), `quadrant_titles` (`{ q1..q4 → 中文短标签 }`), `algorithm_version`, `agent_mode` (enum key, kept English) plus `agent_mode_label` (中文展示名), `supported_commands` (`{ command, example, description_zh }[]` — `command`/`example` are the sendable English values, `description_zh` is the Chinese label), `default_actor_id`, and `actors` (raw rows ordered by kind then display name, each augmented with `display_name_zh`).

English enum keys (`q1..q4`, `deterministic-local`, actor ids) are preserved; Chinese fields are display-only mirrors.

### GET /api/tasks

Query params, all optional:

| param | type | notes |
|-------|------|-------|
| `status` | comma-separated `TaskStatus` | each value must be one of the six statuses |
| `active` | `true` / `1` | overrides `status` with `inbox,claimed,in_progress,blocked` |
| `goal_id` | string ≤60 | exact match |
| `quadrant` | `q1`\|`q2`\|`q3`\|`q4`\|`unclassified` | `unclassified` means `quadrant IS NULL` |
| `unconfirmed` | `true` / `1` | only tasks with `quadrant_confirmed = false` |

Returns `{ tasks: Task[] }`, each task extended with `available_actions: TaskAction[]`. Ordered by queue position (nulls last), then newest first.

### POST /api/tasks

| field | type | required |
|-------|------|----------|
| `title` | string, 1–200, trimmed | yes |
| `description` | string ≤4000, nullable | no |
| `goal_id` | string ≤60, nullable | no — `not_found` if the goal is unknown |
| `deadline` | ISO-8601 date or datetime, nullable | no — normalised to a full ISO string |
| `estimated_minutes` | int 1–10000, nullable | no |
| `duration_value` | number >0 and ≤100000, nullable | no — only together with `duration_unit` |
| `duration_unit` | `minute`\|`day`\|`month`, nullable | no — only together with `duration_value` |
| `cognitive_load` | `low`\|`medium`\|`high`, nullable | no |
| `task_type` | `deep_work`\|`shallow_work`\|`communication`\|`admin`\|`review`\|`learning`, nullable | no |
| `manual_priority` | int −2…2 | no — defaults to 0 |
| `importance` | int 1–5 | no |
| `urgency` | int 1–5 | no |
| `depends_on` | string[] ≤20 | no — every id must exist |

The task is created in `inbox`. Quadrant inference always runs; supplying **both** `importance` and `urgency` marks the result `quadrant_source: "user"`, `quadrant_confirmed: true`, otherwise `"agent"` / `false` with a `quadrant_confidence`.

`duration_value` and `duration_unit` must appear **together or not at all** — one without the other is `validation_failed`. Supplying the pair makes the server convert it to minutes with the current prefs and store that in `estimated_minutes`, **overriding any `estimated_minutes` sent in the same request**; the pair itself is kept so the task can be displayed in the unit the user chose. Supplying only `estimated_minutes` leaves both duration columns NULL. See [Duration conversion](#duration-conversion).

Response: `{ task, operation, queue_snapshot, replayed }`.

### GET /api/tasks/:id

Path param `id`. Returns `{ task, assignments, explanation }` — `task` includes `available_actions`, `assignments` is the full claim history newest-first, `explanation` is the same payload as `GET /api/queue/explain/:id`. `not_found` for an unknown id.

### PATCH /api/tasks/:id

At least one non-`expected_version` field is required, otherwise `validation_failed`.

Updatable: `title`, `description`, `goal_id`, `deadline`, `estimated_minutes`, `duration_value` + `duration_unit` (same pairing rule as on create), `cognitive_load`, `task_type`, `manual_priority` (int −2…2), `manual_override` (number −50…50), `importance` (int 1–5), `urgency` (int 1–5). Plus `expected_version`.

The three duration columns move as a unit here:

- the pair → re-converted with the current prefs; `estimated_minutes`, `duration_value` and `duration_unit` are all written (any `estimated_minutes` in the same body is ignored);
- `estimated_minutes` alone → only that column is written, and the task's recorded value/unit are left untouched (an older client editing minutes must not silently erase them);
- `duration_value: null` with `duration_unit: null` → all three columns are cleared. A null value with a non-null unit is `bad_request`.

Status is **not** updatable here — use the actions endpoint.

Response: `{ task, operation, replayed }`.

### POST /api/tasks/:id/actions

| field | type | required |
|-------|------|----------|
| `action` | `claim`\|`release`\|`start`\|`block`\|`unblock`\|`complete`\|`archive`\|`reopen` | yes |
| `actor_id` | string 1–60 | no — defaults to `actor-human-me` |
| `reason` | string ≤500, nullable | no — stored as `blocked_reason` on `block`, as the release reason on `release`/`complete`/`archive` |

Response: `{ task, operation, queue_snapshot, replayed }`. The logged `operation_type` is `task.<action>`.

### POST /api/tasks/:id/dependencies

Body: `{ "depends_on_id": "<task id>" }` (required, 1–60 chars). Both tasks must exist. Self-dependency and cycles return `bad_request`. Duplicate edges are silently ignored.

Response: `{ task, operation }` — no `replayed` key. The returned task has updated `depends_on`, `blocks` and `dependency_ready`.

### POST /api/tasks/:id/quadrant/confirm

No body. Marks the current suggestion as user-confirmed (`quadrant_source: "user"`, `quadrant_confirmed: true`) and appends to `quadrant_reason`. `bad_request` if the task has no quadrant.

Response: `{ task, operation, replayed }`.

### POST /api/tasks/:id/quadrant/change

| field | type | required |
|-------|------|----------|
| `quadrant` | `q1`\|`q2`\|`q3`\|`q4` | yes |
| `reason` | string ≤500 | no |

`importance` and `urgency` are snapped to match (4 for the "important" and "urgent" axes, 2 otherwise), `quadrant_confidence` is cleared, and the task becomes user-confirmed. Response: `{ task, operation, replayed }`.

### POST /api/tasks/:id/quadrant/resuggest

No body. Re-runs inference from the task's current fields and resets it to `quadrant_source: "agent"`, `quadrant_confirmed: false`. Response: `{ task, operation }` — no `replayed` key.

### GET /api/goals

No params. Returns `{ goals: GoalWithProgress[] }`, newest first, each with `progress: { total, completed, in_flight, open, ratio }` computed over non-archived linked tasks.

### POST /api/goals

| field | type | required |
|-------|------|----------|
| `title` | string 1–200 | yes |
| `description` | string ≤4000, nullable | no |
| `target_date` | ISO-8601 date or datetime, nullable | no |
| `color` | string ≤40, nullable | no |

Created with `status: "active"`. The queue refresh is skipped (goals cannot affect ranking). Response: `{ goal, operation, replayed }`.

### GET /api/goals/:id

Returns `{ goal, tasks }` — all tasks linked to the goal, unfiltered by status. `not_found` for an unknown id.

### PATCH /api/goals/:id

At least one non-`expected_version` field required. Updatable: `title`, `description`, `status` (`active`\|`paused`\|`achieved`\|`dropped`), `target_date`, `color`. Plus `expected_version`.

Response: `{ goal, operation }` — no `replayed` key.

### POST /api/goals/:id/decomposition/preview

No body. Writes no tasks. Picks a deterministic keyword-matched template (delivery / learning / research / habit, else generic), producing four drafts whose deadlines are spread evenly up to the goal's `target_date` when it has one.

Response: `{ preview: { goal_id, goal_title, preview_token, drafts, notes } }`. Each draft is `{ title, description, estimated_minutes, task_type, cognitive_load, deadline, suggestion }` where `suggestion` is `{ quadrant, importance, urgency, confidence, reason, signals }`. Draft titles are `"<goal title>: <phase>"`.

The token is single-use and is the only way to create these tasks.

### POST /api/goals/:id/decomposition/confirm

| field | type | required |
|-------|------|----------|
| `preview_token` | string 4–80 | yes |
| `accepted_titles` | string[] ≤20 | no — omit to accept every draft |

Titles must match the preview's draft titles exactly. An unknown token is `not_found`; a token already consumed is `conflict`; an empty accepted set is `bad_request`. The `:id` path param is ignored — the goal comes from the token's stored payload.

Response: `{ goal, tasks, operation, replayed }`.

### GET /api/queue

No params. Returns `{ snapshot, entries }`. `entries` are `{ position, score, task, breakdown }` ordered by position; `breakdown` is `{ task_id, score, factors, notes, computed_at }` with each factor `{ key, label, value, weight, contribution, detail }`. Only active-status tasks are ranked. On the very first read with no snapshot in the database, one is computed and written.

### POST /api/queue/recalculate

Body: `{ "reason": "<string 1–120>" }`, optional (defaults to `manual-recalculate`). Note the snapshot's stored `reason` is the operation type `queue.recalculate`, not the supplied string — the supplied value lands in the operation's `summary` and `detail`.

Response: `{ queue, operation }` — no `replayed` key.

### GET /api/queue/explain/:id

Path param is a task id. Returns `{ task_id, position, breakdown, snapshot }`. Tasks with no entry in the latest snapshot (completed, archived, or created after it) get `position: null` and a breakdown scored on the fly. `not_found` for an unknown task.

### GET /api/activity

Returns `{ operations, snapshots }` — operations newest-first, plus the 25 most recent snapshots. `operation.replayed` is always `false` in this listing.

Query params (all optional; validated with zod, bound as parameters in SQL):

| param | meaning |
|-------|---------|
| `limit` | page size, clamped to 1–500, default 100 (non-numeric falls back to 100) |
| `query` | free-text search over task / goal titles (falls back to the operation summary), 1–120 chars |
| `type` | comma-separated `operation_type` whitelist (e.g. `task.create,goal.create`) |
| `from` | inclusive lower bound on `created_at` (ISO-8601 instant or bare date) |
| `to` | inclusive upper bound on `created_at` (ISO-8601 instant or bare date) |

Malformed `from` / `to` (unparseable dates) return `400 validation_failed`. Filters apply to `operations`; `snapshots` stays the recent recalculation history.

### GET /api/habits

No params. Returns the four files keyed `explicit`, `inferred`, `constraints`, `weights`. Each is `{ schema_version, updated_at, payload, history }`. `weights.payload` is `{ weights, preferred_task_types, peak_hours, hours_per_day, days_per_month }`.

`hours_per_day` (0.5–24, default 8) and `days_per_month` (1–31, default 20) are the duration conversion prefs, not scoring inputs. A `weights.json` written before the feature has neither key; zod fills in the defaults on read, so the file is never rejected and is not rewritten until something else updates it.

### POST /api/habits

| field | type | required |
|-------|------|----------|
| `statement` | string 3–400 | yes |
| `kind` | string 1–60 | no |

Appends to `habits/explicit.json` with `source: "user"` and a history entry, via validate-then-atomic-rename. Response: `{ habit, habits, operation }` — no `replayed` key.

### POST /api/habits/enabled

| field | type | required |
|-------|------|----------|
| `file` | `explicit`\|`inferred` | yes |
| `id` | string 1–60 | yes |
| `enabled` | boolean | yes |

`not_found` for an unknown id. Disabled entries are retained but excluded from scoring. Response: `{ habit, habits, operation }`.

### POST /api/habits/weights

At least one of `deadline`, `manual_priority`, `dependency`, `effort`, `habit_alignment`, `context_switch` — each a number 0–2. Unsupplied weights keep their current value. Response: `{ weights, habits, operation }` with `weights` being the full merged set.

### POST /api/habits/duration-prefs

| field | type | required |
|-------|------|----------|
| `hours_per_day` | number 0.5–24 | no — but at least one of the two |
| `days_per_month` | number 1–31 | no — but at least one of the two |

An empty body is `validation_failed`, as is an out-of-range value. The unsupplied key keeps its current value; the merged pair is validated, appended to `habits/weights.json` with a history entry, and written via validate-then-atomic-rename. Logged as `habit.duration_prefs.update`.

The queue refresh is skipped: this changes no task's `estimated_minutes`, so no ranking input moved. Response: `{ prefs, habits, operation }`, where `prefs` is the full merged `{ hours_per_day, days_per_month }`.

## `/api/settings/*`

The four habit files are one settings page in the UI, so this route family presents them as a single snapshot and writes them one resource at a time. `GET /api/habits` is unchanged and still returns the raw envelopes — the Agent runtime and the queue scorer read that one.

### GET /api/settings

No params, no operation log entry — a plain read. All four files are read fresh on every call (nothing is cached; the user, the Skill, or a hand edit can change them between calls).

```json
{
  "versions": { "explicit": "…", "inferred": "…", "constraints": "…", "weights": "…" },
  "weights": {
    "weights": { "deadline": 1, "manual_priority": 1, "dependency": 1,
                 "effort": 1, "habit_alignment": 1, "context_switch": 1 },
    "preferred_task_types": ["deep_work"],
    "peak_hours": [9, 10, 11]
  },
  "conversion": { "hours_per_day": 8, "days_per_month": 20 },
  "explicit": [{ "id": "habit_1", "statement": "…", "kind": "preference", "enabled": true,
                 "confidence": null, "source": "user", "updated_at": "…" }],
  "inferred": [{ "id": "habit_2", "statement": "…", "kind": "scheduling", "enabled": true,
                 "confidence": 0.7, "source": "observed", "updated_at": "…" }],
  "constraints": [{ "id": "hc_1", "statement": "…", "kind": "forbidden_window",
                    "enabled": true, "value": "20:00-07:00" }]
}
```

`versions.*` is each file's envelope `updated_at` — the value every write must echo back as `expected_version`.

The two conversion coefficients live in `weights.json`'s payload but are lifted to the snapshot's top-level `conversion`, and are deliberately **absent** from `weights`. They affect duration conversion only, never scoring; leaving them inside `weights` would invite the UI (and a reader) to treat a folding factor as a ranking preference.

An adopted habit also carries `source_relation` — `{ type: "adopted_from_inferred", inferred_id }` — so the UI can trace it back to the observation it came from.

### Writes: the shared contract

Every write below (except the weights preview) does the same five things in the same order:

1. **zod-validate** the body → `validation_failed` (400) with the issue array.
2. **Check `expected_version`** against the target file's current `updated_at` → `version_conflict` (409) if it moved. This happens *before* anything is written, so a rejected write leaves nothing behind: no file change, no history entry, no operation row.
3. **Mutate the payload**, set `updated_at`, and prepend a history entry (newest first, capped at 200).
4. **Write atomically** — validate, then temp file → `fsync` → `rename`, so a half-written habit file is not reachable.
5. **Log it** through `withOperation` with `target_type: "habit"`, honouring `Idempotency-Key` exactly as the task routes do (an identical re-run replays the stored snapshot without re-applying the mutation).

The response is always `{ snapshot }` — the full, post-write snapshot, so a client needs no follow-up `GET`.

A `version_conflict` body carries that same snapshot alongside the error envelope:

```json
{
  "snapshot": { "versions": { "…": "…" } },
  "error": { "code": "version_conflict", "message": "设置已在别处被修改", "details": {} }
}
```

Nothing is ever deleted. `enabled: false` is the only removal: the entry stays for history and is excluded from scoring (`loadHabitContext` filters on it). There is no delete route.

### POST /api/settings/conversion · POST /api/settings/conversion/reset

| field | type | required |
|-------|------|----------|
| `hours_per_day` | number 0.5–24 | no — but at least one of the two |
| `days_per_month` | **integer** 1–31 | no — but at least one of the two |
| `expected_version` | `versions.weights` | yes |

The unsupplied key keeps its value; the scoring weights in the same file are untouched. `days_per_month` must be whole here (half a working day means nothing), which is one notch stricter than `/api/habits/duration-prefs`. An empty body (version only) is `validation_failed`.

`/reset` takes only `expected_version` and restores 8 hours/day, 20 days/month. Logged as `settings.conversion.update` / `settings.conversion.reset`.

As everywhere else, changing these affects **later** conversions only — a stored `estimated_minutes` is never recomputed.

### POST /api/settings/constraints · PATCH /api/settings/constraints/:id · POST /api/settings/constraints/:id/enabled

| field | create | patch |
|-------|--------|-------|
| `statement` | required, 1–400 | optional |
| `kind` | required, one of `forbidden_window`, `max_daily_minutes`, `required_buffer` | optional, **any** string 1–60 |
| `value` | required, ≤200 | optional |
| `expected_version` | `versions.constraints` | same |

The asymmetry on `kind` is deliberate. Creation is restricted to the three known kinds, but **reads are tolerant**: `constraintSchema` accepts any 1–60 character string, so a hand-edited or legacy kind does not make the whole file fail validation. A `PATCH` that omits `kind` keeps the stored value verbatim — editing an old entry's value must not silently rewrite or drop a kind the user put there. Data that reads back has to be writable back.

A `PATCH` must change at least one field besides the version. Unknown `:id` is `not_found` (404). `enabled` takes `{ enabled: boolean, expected_version }` and logs `settings.constraint.enable` / `.disable`.

### POST /api/settings/explicit · PATCH /api/settings/explicit/:id · POST /api/settings/explicit/:id/enabled

| field | create | patch |
|-------|--------|-------|
| `statement` | required, 1–400 | optional |
| `kind` | optional string 1–60 — defaults to `preference` | optional |
| `expected_version` | `versions.explicit` | same |

New entries get `source: "user"` and `confidence: null` — a statement the user made has no observational uncertainty to report. `created_at` is kept on disk but not projected into the snapshot.

### POST /api/settings/inferred/:id/enabled

`{ enabled: boolean, expected_version }` against `versions.inferred`. There is deliberately **no create or edit** for inferred habits: their content is a conclusion drawn from observation, not something the user said, so the only decisions available are "stop using it" and "adopt it as my own" (below).

### POST /api/settings/inferred/:id/adopt

| field | type | required |
|-------|------|----------|
| `expected_version` | `versions.inferred` | yes |
| `expected_explicit_version` | `versions.explicit` | yes |

A **dual-resource write**: it inserts a new `explicit` entry and disables the `inferred` source. Both versions are therefore required, and **both are checked before either file is touched** — either mismatch is a 409 with nothing written, so there is no half-adopted state where the habit exists twice or vanishes entirely.

The new explicit entry copies the statement and kind, and carries `source: "user"`, `confidence: null` (the observational confidence no longer applies once the user owns the statement) and `source_relation: { type: "adopted_from_inferred", inferred_id }`.

The original inferred entry is **kept** and only flipped to `enabled: false`. It is the evidence the adoption was based on; deleting it would erase why the explicit habit exists. Logged as `settings.inferred.adopt`.

### POST /api/settings/weights/preview

| field | type | required |
|-------|------|----------|
| `weights` | all six keys, each 0–2 | yes |
| `preferred_task_types` | `TaskType[]` | no |
| `peak_hours` | int[] 0–23, ≤24 entries | no |

A dry run, and the only route in this family that is **not** a write. It does not touch any file, append any history entry, write any `operations` row, or advance any version — and it takes **no** `expected_version`, precisely because it has nothing to conflict with. A user can preview as many drafts as they like without making their own version stale.

Returns `{ weights, message }`, where `message` is a Chinese one-liner naming what the draft emphasises. Not idempotency-keyed (there is nothing to replay).

### POST /api/settings/weights

The same three fields plus a required `expected_version` (`versions.weights`). All six weights are required — the draft is stored whole, so there is no ambiguity about which of them a partial body would have left alone. `preferred_task_types` and `peak_hours` keep their stored values when omitted, and the two conversion coefficients in the same file are untouched.

This is the **only** settings write that refreshes the queue: those six numbers are the coefficients in the ranking formula, so a save that did not re-rank would leave the displayed queue disagreeing with the stored settings. Logged as `settings.weights.save`.

### Duration conversion

A task's effort fact is `estimated_minutes`, and it is the only duration anything reads — the queue's `effort` factor, the thresholds in it, every score. `duration_value` / `duration_unit` are a record of what the user typed, so the value can be shown back in their own unit.

Conversion happens server-side on every create/update that carries the pair, reading `habits/weights.json` fresh each time (nothing is cached), then rounding to a whole minute:

| unit | minutes |
|------|---------|
| `minute` | the value itself |
| `day` | value × `hours_per_day` × 60 |
| `month` | value × `days_per_month` × `hours_per_day` × 60 |

At the defaults (8 h/day, 20 days/month) `2 day` → 960 and `1 month` → 9600. A non-finite or non-positive value is `bad_request` — it is never silently floored to 0, which would read as a quick win to the scorer.

Changing the prefs affects **later** conversions only. An `estimated_minutes` already in the database is the fact recorded at write time; nothing recomputes or rewrites it. To re-convert a task under new prefs, re-send its duration pair.

The two columns (`duration_value REAL`, `duration_unit TEXT`, both nullable with CHECK constraints matching the ranges above) are added by the idempotent `migrateTaskDurationColumns` migration, which runs on server start and on `npm run db:setup`. Existing rows are **never backfilled**: NULL on both columns is itself the fact "this was entered in minutes", and the UI falls back to displaying `estimated_minutes` as minutes. Inventing a unit for them would both decide for the user and make `duration_value` disagree with what was actually typed.

### POST /api/agent/message

| field | type | required |
|-------|------|----------|
| `message` | string 1–1000 | yes |
| `session_id` | string ≤60, nullable | no — a new session is created, titled from the first 60 chars of the message |
| `actor_id` | string ≤60 | no — defaults to `actor-human-me` |
| `target_task_id` | string ≤60 | no — pick a candidate/recommendation by its stable task id; bypasses title matching so identical titles still resolve to exactly one task |
| `target_goal_id` | string ≤60 | no — same, for goals |

Response: `{ session, messages, result, invalidates }`. `messages` is the persisted pair (user message, then agent reply). `invalidates` lists which UI caches went stale: any of `tasks`, `goals`, `queue`, `activity`, `habits`; empty for read-only and non-writing replies.

`result` is the structured reply:

```json
{
  "kind": "preview",
  "headline": "4 draft task(s) for \"Ship the billing rewrite\" — confirm to create.",
  "reasoning": ["…"],
  "blocks": [{ "type": "facts", "title": "Drafts", "items": [{ "label": "…", "value": "…" }] }],
  "pending_action": { "token": "preview_…", "command": "confirm_decomposition", "summary": "…", "affected_task_ids": [] },
  "matched_command": "draft tasks",
  "mode": "deterministic-local"
}
```

`kind` is one of `applied`, `preview`, `clarification`, `answer`, `error`. Block types are `facts`, `list`, `tasks` (task ids), `score`, `task_candidates` / `goal_candidates` (ambiguity cards; each carries a hidden `task_id`/`goal_id` the UI echoes back in `target_task_id`/`target_goal_id` — never rendered to the user) and `decomposition_preview` (the editable draft list).

### POST /api/agent/confirm

| field | type | required |
|-------|------|----------|
| `token` | string 4–80 | yes — from a previous reply's `pending_action.token` |
| `session_id` | string ≤60, nullable | no |
| `actor_id` | string ≤60 | no |
| `accepted_drafts` | `{index,title,description?}[]` ≤20 | no — only create/override the checked drafts (same contract as `/api/goals/:id/decomposition/confirm`); omit to create every draft |

Consumes the pending preview and performs the write. Same response shape as `/api/agent/message`. A reused token is `conflict`, an unknown one `not_found`. Ambiguous titles return a `clarification` with `task_candidates`/`goal_candidates` blocks — each card shows title/goal/status/deadline and carries a hidden `task_id`/`goal_id`; clicking a card re-sends the command with that `target_task_id`/`target_goal_id`, so even identical titles resolve to exactly one task. The id is never rendered to the user.

### POST /api/agent/cancel

| field | type | required |
|-------|------|----------|
| `token` | string 4–80 | yes — the preview token to cancel |
| `session_id` | string ≤60, nullable | no |
| `actor_id` | string ≤60 | no |

Cancels a pending decomposition preview: marks the token consumed **without creating any task**. The user's "取消" button in the agent panel calls this; after cancellation (or refresh, thanks to server-side revocation plus a local `disabledTokens` cache) the old confirm button cannot re-run. Idempotent — cancelling an already-consumed token returns the same result.

### GET /api/agent/sessions

No params. Returns `{ sessions }` — the 20 most recently updated, each `{ id, title, created_at, updated_at, message_count }`.

### GET /api/agent/sessions/:id

Returns `{ session, messages }` with the full history in chronological order. `not_found` for an unknown id.

### GET /api/events

Server-sent events, `Content-Type: text/event-stream`. Emits a `queue` event whose `data` is the latest `QueueSnapshot` whenever the snapshot id changes, otherwise a `: keep-alive` comment, polled every 3 s. Purely a change notification — refetch `/api/queue` to get the entries.

```
event: queue
data: {"id":"snap_…","created_at":"…","reason":"task.create","algorithm_version":"pwq-queue-1.0.0","entry_count":7}
```

### GET /api

Returns `{ service, reference, mode }` — a discovery hint, not an index of routes.

## 本地 CLI Agent 运行时（/api/agent/runtime-*）

A local CLI binary (`claude` / `codex`) can be wired in as a second processing path for `POST /api/agent/message`. It is **off by default**, and when it is off everything above still describes the whole surface — the rule-based parser (`deterministic-local`) remains the only path. The routes here configure that runtime, detect it, test it, and report its state; `POST /api/agent/message` gains a few optional fields rather than changing shape.

Two invariants hold across this whole family, and the rest of the section is mostly their consequences:

- **The model never writes to the database.** A write intent becomes a preview token; the write itself is performed later by the existing deterministic service, via `POST /api/agent/preview/confirm`.
- **A failure is reported, never hidden.** A single agent error does not silently fall back to the parser — the caller is told what happened and offered the next steps.

### Where the configuration lives

`config/agent-runtime.json`, inside the project — deliberately **not** in `habits/`. The habit files are the user's ranking preferences; this one is a runtime switch ("which executable, with what argv"), and mixing them would turn a habit file's `history` into a log of config edits. Writes reuse the habits' validate-then-atomic-rename (temp file → `fsync` → `rename`), so a killed process cannot leave half a JSON behind, and the envelope carries the same `history` (newest first, capped at 50) + `updated_at` optimistic-concurrency pair.

**只存环境变量名 `allowed_env_names`，绝不存值。** The names are what get persisted; the values are read from the live `process.env` at spawn time, in `server/agent/cli-exec.ts`. That is why the file is safe on disk and why `GET` can echo it back verbatim — **there is no secret in it to redact**, so no route in this family masks a field.

| field | type | notes |
|-------|------|-------|
| `schema_version` | `1` | server-owned |
| `enabled` | boolean | `false` is the safe default |
| `provider` | `claude`\|`codex` | |
| `cli_path` | string ≤400 | required and **absolute** when enabled; may be empty when disabled (the not-yet-configured state) |
| `model` | string 1–120, nullable | `null` = the provider's own default |
| `args` | string[] ≤32 | each item ≤200 chars, NUL rejected |
| `timeout_ms` | int 500–120000 | |
| `working_directory` | string ≤400 | must resolve **inside the project root** |
| `allowed_env_names` | string[] ≤32 | names only, `^[A-Z_][A-Z0-9_]*$`, ≤60 chars each |
| `field_sources` | `Record<string, 'auto'\|'manual'>`, **optional** | per-field provenance; `{}` when absent. See [POST /api/agent/runtime-detect](#post-apiagentruntime-detect) |
| `detected` | unknown, **optional** nullable | last detection snapshot, for display only; `null` when absent |
| `updated_at` | ISO string | server-owned; the value every `PUT` must echo as `expected_version` |
| `history` | `{ at, change }[]` | server-owned |

A missing file reads back as the safe default (disabled, no `cli_path`). A file that is unparseable or fails validation is **`bad_request`, not a silent fallback to the default** — otherwise "my config got corrupted" would look exactly like "I haven't configured it yet", and the user would never see the line they need to fix.

### GET /api/agent/runtime-config

No params. Returns `{ config: AgentRuntimeConfig, updated_at }` (`updated_at` is the same string as `config.updated_at`, lifted for convenience).

```bash
curl -s http://127.0.0.1:28642/api/agent/runtime-config
```

```json
{
  "config": {
    "schema_version": 1, "enabled": true, "provider": "claude",
    "cli_path": "/usr/local/bin/claude", "model": null,
    "args": ["--print"], "timeout_ms": 20000,
    "working_directory": "/path/to/personal-work-queue",
    "allowed_env_names": ["PATH", "ANTHROPIC_API_KEY"],
    "updated_at": "2026-10-13T02:11:04.512Z",
    "history": [{ "at": "2026-10-13T02:11:04.512Z", "change": "PUT /api/agent/runtime-config (actor-human-me)" }]
  },
  "updated_at": "2026-10-13T02:11:04.512Z"
}
```

Note `allowed_env_names` lists `ANTHROPIC_API_KEY` — **the name**. The key's value is never stored here and never returned by any route.

### PUT /api/agent/runtime-config

| field | type | required |
|-------|------|----------|
| `config` | the writable fields above (no `schema_version` / `updated_at` / `history` — the server owns those, and sending them does nothing) | yes |
| `expected_version` | string 1–80 — the current `updated_at` | yes |

```bash
curl -s -X PUT http://127.0.0.1:28642/api/agent/runtime-config \
  -H 'Content-Type: application/json' \
  -d '{"config":{"enabled":true,"provider":"claude","cli_path":"/usr/local/bin/claude",
       "model":null,"args":["--print"],"timeout_ms":20000,
       "working_directory":"/path/to/personal-work-queue",
       "allowed_env_names":["PATH","ANTHROPIC_API_KEY"]},
       "expected_version":"2026-10-13T02:11:04.512Z"}'
```

Response: `{ config, updated_at, replayed: false }`.

`expected_version` must equal the stored `updated_at`; a mismatch is `409 version_conflict` with `details: { expected, actual }` and the current config attached as `current`, and **nothing is written**. Re-`PUT`ing an identical payload is **idempotent and does not bump `updated_at`** — the stored config is returned as-is. (Compared on the writable fields only; `updated_at` / `history` are products of a write, not inputs to one.) Without that, every save in the settings UI would invalidate the version another tab is holding.

Validation beyond zod, in `validateRuntimeConfigInput`:

- `enabled: true` → `cli_path` required **and absolute**. `enabled: false` → it may be empty (the unconfigured state).
- A non-empty `cli_path` must be absolute **regardless of the switch**: a relative path drifts with the process's cwd, which makes "which binary runs" an undetermined thing. Turning the switch off does not buy an exemption.
- `working_directory` must resolve inside the project root. This is the sandbox boundary — the model is launched within the project, and cannot have its cwd pointed at `/` or the user's home to go reading files. It is stored resolved.
- `args`: each item ≤200 chars and free of NUL (which would truncate the string at `execve`). `model` ≤120 chars.

A successful write **invalidates the health cache**: the path may now point at a different binary, so the previous "it answers" conclusion is immediately worthless.

### GET /api/agent/runtime-providers

Returns `{providers: [{provider, candidate, connection}]}` for Claude and Codex. Installation discovery is local version/help only. `connection` is the last actual model check for the exact CLI path, effective argv, working directory, timeout and environment-name whitelist; a changed invocation has no inherited proof.

### POST /api/agent/runtime-test

Body `{}` tests the configured CLI, including while the assistant is disabled. Alternatively pass both `provider` and `cli_path` to test a discovered candidate without switching or enabling the assistant. Unpaired fields, extra options and undiscovered executable paths are rejected.

The test sends only a fixed OK question, never queue context. It creates no session, business row or operation. It stores diagnostic evidence in the sibling `agent-runtime.json.connections.json` file without changing the runtime configuration version. Success requires a complete standalone OK answer and no timeout/cancellation; warnings remain separate from the answer.

Response includes `ok`, `stdout_excerpt`, `exit_code`, `timed_out`, `reason`, `warnings`, `status`, `provider`, `cli_path`, `checked_at` and `latency_ms`. A missing configured CLI is a validation error. An explicit candidate uses that CLI's own default model/arguments, never another provider's model overrides.

### POST /api/agent/runtime-detect

| field | type | required |
|-------|------|----------|
| `provider` | `'claude' \| 'codex'` | no — omit to look for both |
| `persist` | boolean, default `false` | no |
| `expected_version` | string 1–80 — the current `updated_at` | **yes when `persist: true`** (otherwise `400`) |

There is deliberately no "where to look" or "which basename" parameter, since accepting one would turn this into "spawn any file I name".

Answers one narrow question — *is there a runnable `claude` / `codex` on this machine, where, and which non-interactive flags does its `--help` claim to support*.

**Writing is opt-in.** With `persist` omitted or `false` — the default — **nothing is written**: no database row, no session, no config file. Only `persist: true` writes back, and even then it never overwrites a `manual` field; see "Who applies the patch" below.

```bash
curl -s -X POST http://127.0.0.1:28642/api/agent/runtime-detect \
  -H 'Content-Type: application/json' -d '{"provider":"claude"}'
```

```json
{
  "detected_at": "2026-10-13T09:40:11.204Z",
  "latency_ms": 48,
  "candidates": [
    {
      "provider": "claude",
      "path": "/Users/me/.local/bin/claude",
      "rank": 1,
      "exists": true,
      "version": "2.1.274",
      "exit_code": 0,
      "timed_out": false,
      "latency_ms": 41,
      "auth_status": "unknown",
      "capabilities": {
        "non_interactive": true,
        "output_formats": ["json", "stream", "text"],
        "supports_model_flag": true,
        "help_checked": true
      }
    }
  ],
  "recommended": { "...": "the same object as candidates[0] here" },
  "config_patch": {
    "provider": "claude",
    "cli_path": "/Users/me/.local/bin/claude",
    "model": null,
    "timeout_ms": 20000,
    "working_directory": "/path/to/personal-work-queue",
    "recommended_args": ["--output-format", "json"],
    "model_source": "cli-config"
  },
  "persisted": false,
  "note": "本地只读检测：每个候选只执行 --version 与 --help ..."
}
```

**Where it looks.** A fixed whitelist of directories, in this order — `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `<project>/node_modules/.bin` — followed by the entries of `PATH` in `PATH` order. Deduplicated by absolute path, keeping the earlier position, which is what makes the whitelist win. **Subdirectories are never recursed** and relative `PATH` entries (a historical `.`) are dropped, since their meaning drifts with the process's cwd. A candidate must be an executable regular file: a directory named `claude`, or a non-executable file, is not a candidate.

`rank` is that ordering, 1-based. `recommended` is the first candidate that both exists and exited `0` — a binary that is installed but cannot run is reported, never recommended — and is `null` when there is none, in which case `config_patch.cli_path` and `provider` are `null` too (`working_directory` and `timeout_ms` still carry usable defaults).

`version` is the first line of `--version` output, trimmed, control characters stripped, capped at 200 chars; `null` when nothing usable came back. Invalid UTF-8 becomes U+FFFD rather than an error.

**`capabilities` comes from the `--help` text, by reading it.** Each existing candidate gets two probes, in this order: `--version` first, then `--help`. The division of labour is strict — **`--version` alone decides whether a candidate is usable**, so `version`, `exit_code` and `timed_out` all come from it, while `--help` only contributes capability text. A CLI whose `--help` times out, exits non-zero, or fails to spawn therefore stays a perfectly good candidate and can still be `recommended`; it just gets `help_checked: false` and, with it, the conservative defaults `non_interactive: false`, `output_formats: []`, `supports_model_flag: false`. "Not read" is not the same as "not supported", and treating it as support would push flags the CLI doesn't know into `recommended_args`. `latency_ms` on a candidate is the total of both probes.

The three flags are **parsed out of the help string, never tried out** — detection does not run a flag to see whether it works. Matching is on standalone tokens, so `--model-list` is not `--model` and a `-points` in prose is not `-p`. `output_formats` is non-empty only when help actually mentions `--output-format`, and format names are taken only from quoted or parenthesised fragments on those lines: in `--output-format <fmt>` the `<fmt>` is syntax notation, not a format called `fmt`.

**The security contract** — these are the reasons the route is safe to expose, and each is covered by a test in `tests/agent-detect.test.ts`:

- **Only `--version` and `--help` are ever executed.** Both are self-description calls: no prompt, no model, no network, no billable call. `--help` output is read as text and nothing more.
- **No `auth` / `login` / `status` subcommand is ever run** — those reach the network and can mutate the CLI's own login state. Hence `auth_status` is **hard-coded `'unknown'`**: unknown is reported as unknown rather than guessed.
- **No credential file is opened**, and the probe's environment is **`PATH` only** (via `runCli`'s env whitelist), so `ANTHROPIC_API_KEY` and friends are neither read nor forwarded to the binary being probed.
- **No shell.** `spawn(..., { shell: false })` with literal `['--version']` / `['--help']` arrays, so a file whose *name* contains `;` or `$(...)` is just a filename — and it isn't a candidate anyway, because the basename must match exactly.
- `model` is always `null` and `model_source` is always `'cli-config'`: which model to use is the CLI's own configuration, and detection does not guess one. `recommended_args` is held to the same line — it is non-empty only when there is a `recommended` candidate whose `help_checked` is `true`, and it may contain **only a help-confirmed output-format flag** (concretely `['--output-format', 'json']` when help lists `json`, otherwise `[]`). It never contains prompt text, never `--model`, and not `-p` / `--print` either: that flag's job is to carry the prompt, and prompt argv is built by `buildProviderPromptArgs`. A skip-permissions flag could not appear there under any help text.

#### Who applies the patch

`config_patch` is a **suggestion the server does not apply on its own initiative**. Adopting it is always an explicit caller action — either the client merges it and saves through `PUT`, or it asks for `persist: true`. Both routes record the outcome in two **optional** config fields:

| field | type | notes |
|-------|------|-------|
| `field_sources` | `Record<string, 'auto' \| 'manual'>` | per-field provenance. Missing in an older config file → reads back as `{}` |
| `detected` | unknown, nullable | the last detection snapshot, for display. Missing → reads back as `null` |

Both are accepted by `PUT /api/agent/runtime-config` and **passed through without strict validation** — they are display metadata that no spawn decision reads, so a client adding a key must not be able to turn the whole config into a `400`. `field_sources` keys are intentionally not narrowed to a fixed field enum for the same reason.

**A `manual` field is never overwritten by a re-detect.** With the client-side merge the mechanism is simply that nothing is written: the route returns the patch, the client merges only the fields it still has marked `auto`, and saves through the existing `PUT`. "Restore the auto value" is therefore the same ordinary `PUT` — the client merges the detected value in and flips `field_sources[field]` back to `'auto'`. **There is no restore-auto endpoint**, which is the point: a second write path would need its own optimistic-concurrency story, and the existing `expected_version` already has one.

**`persist: true`** is the server-side shortcut for that same merge, for clients that would rather not reimplement it. It requires `expected_version` (a missing one is a `400`, never a silent overwrite), and its concurrency semantics are identical to `PUT`'s: `expected_version` must equal the current `updated_at`, or the call fails `409 version_conflict` — carrying the current config — **and writes nothing**. On success the response is the normal detection payload plus `persisted: true`, the written `config`, and its `updated_at`.

What the merge does, in priority order:

1. **`detected` is always replaced** with the full snapshot — refreshing "what did the last detection see" is the whole point of persisting, even when nothing was found.
2. **`manual` fields are left completely alone** — value and marker both. This is where the "auto-detection will not quietly clobber the path I typed" promise is enforced, so it outranks any detection conclusion.
3. **With no `recommended` candidate, not one value changes.** Only the snapshot is written. The patch's `provider` and `cli_path` are `null` in that case, and writing those through would read as "detection failed ⇒ your config is erased".

Otherwise six fields are merged where the marker is not `manual` — `provider`, `cli_path`, `model` (always `null`), `args` (from `recommended_args`), `timeout_ms`, `working_directory` — and each one merged is marked `'auto'`.

**`enabled`, `allowed_env_names` and `schema_version` are never in scope.** Detection will not enable the Agent for you, and will not touch the env-name whitelist: those two are boundaries the user authorised, not facts that can be inferred.

One deliberate difference from `PUT`: there is **no same-payload idempotency short-circuit**. The snapshot carries a fresh `detected_at`, so **a repeat persist bumps `updated_at` every time**. That is intended — "when was this last detected" is itself information the user is looking at. The cost is that another tab's held version goes stale, which is acceptable because persisting is a button the user presses, not something the UI fires repeatedly.

### GET /api/agent/runtime-status

No params. The live state panel, which forces a fresh health probe (the TTL cache is bypassed — a status panel wants a current conclusion, not a cached one).

```json
{
  "configured": true,
  "enabled": true,
  "provider": "claude",
  "health": { "ok": true, "reason": null, "checked_at": "2026-10-13T02:12:30.004Z" },
  "effective_mode": "agent",
  "background": { "implemented": false, "status": "not_implemented" }
}
```

- `configured` means the file has actually been written at least once, not merely that a default was read back (it compares `updated_at` against the default's epoch value).
- `provider` is `null` while disabled.
- `effective_mode` is `agent` when health is `ok`, otherwise `deterministic-local` — the same decision `POST /api/agent/message` makes in `auto` mode.
- **A background resident agent is not implemented.** `background` is hard-coded to `{ implemented: false, status: 'not_implemented' }` and reported that way always, rather than pretending the capability exists.

### POST /api/agent/message — the runtime extension

Three optional request fields are added on top of the body documented above:

| field | type | notes |
|-------|------|-------|
| `processing_mode` | `auto`\|`agent`\|`command` | default `auto`. `auto` picks by health; `agent` forces the model and **errors rather than quietly downgrading** when it is not ready; `command` forces the rule parser |
| `retry_of` | string ≤60, nullable | the id of the message being retried — a marker only |
| `fallback` | boolean | **only `true`** permits a fall back to the parser after an agent failure. Default: no fallback |

The response keeps `{ session, messages, result, invalidates }` and **adds five optional fields**: `mode`, `provider`, `source`, `fallback_reason`, `available_actions`. Clients that ignore them see no change. (This supersedes the blanket claim at the top of this document that every agent reply carries `"mode": "deterministic-local"` — with the runtime enabled, `mode` may be `agent`.)

`source` is the honest record of which path actually ran:

| `source` | meaning |
|----------|---------|
| `agent` | the local CLI model produced the reply |
| `deterministic-local` | the rule parser ran — by request (`processing_mode: 'command'`), or in `auto` because the runtime was not ready (`fallback_reason` says which) |
| `deterministic-local-fallback` | the agent failed **and** the request carried `fallback: true` |
| `agent-error` | the agent failed and no fallback was requested |

**A single agent error, timeout, non-zero exit, or unparseable output does not silently fall back.** The reply is `kind: "error"` with `source: "agent-error"`, `fallback_reason` naming the failure kind, and

```json
{ "available_actions": ["retry_agent", "process_with_command_mode"] }
```

so the UI can offer the two real choices instead of showing parser output the user will mistake for the model's. The health cache is invalidated on that failure, so the next request re-probes.

Across every branch — model, parser, fallback, error — **the user's original message is always persisted and the session is never lost**: `persistExchange` runs after all branches, so one failed model call cannot cost the conversation its context.

### POST /api/agent/preview/confirm · POST /api/agent/preview/cancel

The model's write intent only ever becomes a **preview token**; it never reaches the database directly. These two routes are where such a preview is accepted or dropped.

| route | body |
|-------|------|
| `POST /api/agent/preview/confirm` | `{ token, session_id?, actor_id? }` |
| `POST /api/agent/preview/cancel` | `{ token, session_id? }` |

`token` is 4–80 chars. Both return the same `{ session, messages, result, invalidates }` envelope as `/api/agent/message`, with `kind: "applied"`. An unknown or expired token is `not_found`; an already-confirmed one is `conflict`.

On confirm, the write is executed by the **existing deterministic service** — the model is not in the write path at any point. The whitelist of actions a preview may carry is exactly four:

`create_task` · `create_goal` · `task_action` · `add_habit`

Anything outside it — a complex or unrecognised action — is allowed into the natural-language plan the model writes back to the user, and **nothing else**: it never becomes a confirmable write. The ceiling on what a model can cause is therefore the same four deterministic operations that the rule parser already exposes, no matter what it emits.

### Compatibility with /api/agent/confirm · /api/agent/cancel

The older `POST /api/agent/confirm` and `POST /api/agent/cancel` — the **goal decomposition** preview pair documented above — are **unchanged**. They keep their own token namespace, their own `accepted_drafts` contract, and their existing behaviour. The `/api/agent/preview/*` routes are additive and sit beside them; neither pair consumes the other's tokens.

## Task lifecycle

Statuses: `inbox`, `claimed`, `in_progress`, `blocked`, `completed`, `archived`. The first four are the *active* set (`?active=1`) and the only ones the queue ranks.

| action | from | to | claim effect | needs the claim? |
|--------|------|----|--------------|------------------|
| `claim` | `inbox` | `claimed` | acquires | no |
| `release` | `claimed`, `in_progress`, `blocked` | `inbox` | releases | yes |
| `start` | `claimed`, `blocked` | `in_progress` | keeps | yes |
| `block` | `claimed`, `in_progress` | `blocked` | keeps | yes |
| `unblock` | `blocked` | `claimed` | keeps | yes |
| `complete` | `claimed`, `in_progress` | `completed` | releases | yes |
| `archive` | `inbox`, `claimed`, `in_progress`, `blocked`, `completed` | `archived` | releases | no |
| `reopen` | `completed`, `archived` | `inbox` | releases | no |

"Needs the claim" means the acting `actor_id` must be the current claim holder. Acting without a claim gives `conflict` ("nobody holds a claim on it"); acting while someone else holds it gives `conflict` with `details.held_by`.

A task carries at most one unreleased claim. This is enforced twice: in `applyAction` (a second `claim` is rejected before it reaches SQL) and by a partial unique index that surfaces as `409 conflict` via the `UNIQUE constraint failed` branch of `sendError`. Claiming an already-claimed task is reported as the transition failure `Task is already claimed.` because the status is no longer `inbox`.

Side effects: `started_at` is stamped on the first move to `in_progress`; `completed_at` on `complete` and cleared on any move back to `inbox`; `blocked_reason` is set from `reason` on `block` and cleared on every other transition. `GET /api/tasks` and `GET /api/tasks/:id` report the legal next moves in `available_actions`.

## Agent commands

`POST /api/agent/message` runs a regex/keyword intent matcher — not a model. `GET /api/meta` returns the same list in `supported_commands`.

| command | example | description_zh |
|---------|---------|----------------|
| create a task | `create task "Draft Q3 review notes" by tomorrow, takes 45m` | 创建一个任务 |
| create a goal | `create goal "Ship the billing rewrite" by 2026-12-01` | 创建一个目标 |
| show queue | `show queue top 5` | 查看队列排名 |
| show goals | `list goals` | 查看目标列表 |
| claim / release / start / complete / block a task | `start "Draft Q3 review notes"` | 领取 / 释放 / 开始 / 完成 / 受阻 一个任务 |
| change a task quadrant | `move "Draft Q3 review notes" to q2` | 修改任务象限 |
| confirm a quadrant suggestion | `confirm the quadrant for "Draft Q3 review notes"` | 确认象限建议 |
| draft tasks for a goal | `draft tasks for goal "Ship the billing rewrite"` | 为目标拟任务草稿 |
| add / list / disable an explicit habit | `add habit "deep work before noon"` | 新增 / 列出 / 停用显式习惯 |
| explain a ranking | `why is "Draft Q3 review notes" ranked first` | 解释一次排名 |

Also recognised: `help`. Deadlines parse from `today`/`tonight`/`by eod`/`tomorrow`/`next week`/`in N days`/`YYYY-MM-DD` (and the Chinese equivalents `今天`/`明天`/`下周`), estimates from `45m`/`2h`/`30分钟`. Titles are taken from quotes when present.

The write-guard behaviour, which a caller must handle rather than retry around:

- **Ambiguous subject** — a title matching zero or several tasks/goals returns `kind: "clarification"` with the candidates and writes nothing. Lookup is exact-match-first, then substring, case-insensitive.
- **Batch or destructive phrasing** — anything matching `all`/`every`/`everything`/`each` against tasks or goals, any of `delete`/`remove`/`wipe`/`purge`/`clear`/`reset`/`drop`, or `archive|complete|close all` returns `kind: "preview"` with `matched_command: "batch guard"` and writes nothing. There is no way to force it through this endpoint; issue per-item commands instead.
- **Unmatched input** — `kind: "clarification"` listing the supported commands.
- **Decomposition** — `draft tasks for goal …` returns `kind: "preview"` with a `pending_action`. The tasks exist only after `POST /api/agent/confirm` with that token.
- **Rejected write** — a valid intent whose write fails (bad transition, claim conflict) returns `kind: "error"` with the message; the transaction rolled back, so no partial change landed.

## Example flow

Create a task, take it through to completion, then read the queue and explain the ranking. Each write carries its own `Idempotency-Key`.

```bash
BASE=http://127.0.0.1:28642

# 1. create
TASK=$(curl -s -X POST $BASE/api/tasks \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: flow-create-1' \
  -d '{"title":"Draft Q3 review notes","estimated_minutes":45,"deadline":"2026-10-20"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["task"]["id"])')

# 2. claim → start → complete (claim holder defaults to actor-human-me)
curl -s -X POST $BASE/api/tasks/$TASK/actions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: flow-claim-1' \
  -d '{"action":"claim"}'

curl -s -X POST $BASE/api/tasks/$TASK/actions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: flow-start-1' \
  -d '{"action":"start"}'

curl -s -X POST $BASE/api/tasks/$TASK/actions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: flow-complete-1' \
  -d '{"action":"complete"}'

# 3. read the queue
curl -s $BASE/api/queue

# 4. explain one task's score
curl -s $BASE/api/queue/explain/$TASK

# 5. same question through the agent
curl -s -X POST $BASE/api/agent/message \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: flow-agent-1' \
  -d '{"message":"why is \"Draft Q3 review notes\" ranked first"}'
```

Replaying step 1 with `Idempotency-Key: flow-create-1` returns the same task with `replayed: true` and `queue_snapshot: null` — no second task is created.


## 本轮补齐：连续评分、类型高峰与 CLI 输出

`POST /api/tasks/:id/matrix-score` 接收 `{importance_score, urgency_score, reason, source?, confidence?, expected_version?}`。分数0..100，最多一位小数；reason4..2000字，confidence0..1；source默认agent，仍待用户确认。创建任务可接受同结构嵌套matrix_score（不含version）。CLI score-task未传版本时先读取任务，提交始终带当前版本。网页复评请求通过 `/api/tasks/:id/rescoring-request`、`GET /api/rescoring-requests`、`POST /api/rescoring-requests/:id/submit|confirm|cancel`；建议仅改变changed_axes，确认前不写任务。

`GET /api/settings` 的 weights 快照新增可选 `task_type_peak_hours`；weights的preview/save也接收。它是任务类型到0..23整点数组的映射，键限定deep_work/shallow_work/communication/admin/review/learning。缺失类型键继承peak_hours，明确[]表示该类型没有高峰；恢复继承需删除键。旧文件读取补空map，不自动写回；换算保存保留此map，队列habit_alignment实际按当前任务类型选时段。

助手结果新增可选answer全文与warnings数组：`{code: model_config_warning|nonzero_exit|cli_warning, message: 中文摘要}`。不返回原始stderr或密钥值。headline仍为摘要，会话恢复和界面保留answer全文。runtime-test新增status=success|success_with_warning|failure与warnings；最终答案必须为独立OK。超时/取消即使有部分输出也失败，无答案或仅诊断也失败；有效完整回答伴非零退出可成功，但必须显示警告。

Claude当前本机help确认支持 `-p PROMPT --tools '' --output-format text --safe-mode --no-session-persistence`，保留本机模型/认证，关闭定制与会话写入，避免已回答却不退出。Codex使用 `exec --json --sandbox read-only --ephemeral --skip-git-repo-check --color never PROMPT`，只提取completed agent_message，忽略诊断/统计事件。stdin默认EOF，环境仍为安全基础名+用户白名单，危险注入变量不透传；不改全局模型/认证配置。

安装检测只执行version/help；CLI可运行不等同模型已连接。设置页重新检测列出两种provider，选择Claude推荐60秒、Codex推荐120秒；同一provider的手动超时保留。切换provider时清除另一CLI的模型与参数。真实业务配置是否启用仍由用户决定，后台工作Agent尚未启用执行能力。

### 后续集成修复补充

AgentResult可选provider随原回复存储；会话恢复以result.mode/provider标记来源，旧回复未记录provider时只显示Agent，不使用当前配置猜测历史提供方。前端根据pa_模型预览token调用独立preview/confirm|cancel，目标拆分继续原confirm|cancel；请求失败不注销客户端按钮。

GoalProgress计数现为互斥：open仅inbox，in_flight为claimed+in_progress，blocked单独返回，completed独立；total不含archived，ratio=completed/total。此修复为只读聚合，无需新增数据库列或迁移。

### 助手首条消息与连接验证

启用后首条模型消息会建立健康缓存，不要求先打开设置页。健康缓存按provider、CLI路径、目录、基础参数分开判断；关闭状态或另一CLI的结果不能误用于当前调用。`runtime-status.connection`单列上次实际模型验证，`health`仍只代表CLI安装检查。后台Agent执行能力仍未实现。

Codex非交互调用使用JSONL事件流与ephemeral会话，参考[官方CLI文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)。实际参数兼容性以已安装CLI的help和端到端结果为准。

普通运行时 PUT 未传 `detected` / `field_sources` 时保留原元数据；显式 `detected: null` 才清除检测快照。这样自动保存启用状态或编辑模型时不会触发重新检测与额外版本变化。

## PrinceQ 工作助手提示词与上下文

固定身份、排期规则及预览输出规范位于 `server/agent/princeq-system-prompt.md`。
Claude 每次通过 `--system-prompt-file` 加载本次组装的私有临时文件；Codex 每次通过 `model_instructions_file` 使用包含固定指令、Skill 合同和个人设置的临时指令文件，同时隔离其他 developer/项目指令。
参考 [Codex 配置文档](https://learn.chatgpt.com/docs/config-file/config-reference)。仅覆盖本次调用，不修改用户级 CLI 配置。

`prompt-context.ts` 每轮读入当前 session 的全部已保存消息（助手 answer 全文优先）、预览内容及实际 pending/confirmed/cancelled 状态；所有状态任务和目标的全部公开字段、任务依赖与领取记录、目标进度和关联任务；明确/推断习惯、硬约束、工作时段、排序偏好与耗时换算。
数据中附有 UTC 当前时间、本地日期与时区，`PWQ_TIME_ZONE` 可覆盖本机时区。当前用户消息单独出现一次，新会话不读取其他会话历史。
队列排序由完整任务集合在内存中重新计算，组装上下文不写队列快照或任务数据。数据与固定指令分开传入，工作上下文经 stdin 一次写完并关闭，避免命令参数长度限制。
完整上下文超过 2 MiB 时明确返回 `context_too_large`，不静默截断。CLI/模型本身的上下文上限仍取决于当前提供方。
模型能力由 PrinceQ Skill 操作合同定义，保留四类旧建议形状兼容；未知动作或额外字段被整条拒绝。只有用户点击确认接口才执行；文本中的“确认”或历史助手的“已执行”不视为写入证据。

同一会话引用的旧目标拆分预览也带上实际 pending/resolved 状态；resolved 仅表示已被处理，具体确认效果仍看最新工作快照与会话里的应用结果。
Codex 的工作助手调用关闭外部 apps、MCP 与插件配置，保持 read-only 沙箱；模型输出仍只能走已注册的待确认动作。固定连接探针保持原调用方式。
新操作使用稳定 ID；新目标先确认获取 ID，再创建关联任务。四类旧动作仍兼容按唯一标题关联的同批创建；名称不唯一时不猜目标。


## PrinceQ Skill v2

操作合同以 `GET /api/skills/princeq` 为准；提供完整 context、预览列表/单项、POST previews 和 /:token/confirm|cancel。内外 Agent 共用合同及既有业务路由，模型只有 proposed_actions 表达能力。外部确认要求 confirmed=true，当前没有鉴权；统一预留入口是 server/skills/access.ts。详情见 skill/references/operations.md。

新增 DELETE /api/tasks/:id 与 DELETE /api/goals/:id，body 为可选 expected_version，均记录操作并刷新队列；目标删除保留任务。新增 POST /api/tasks/:id/dependencies/remove {depends_on_id}。Skill 客户端默认将任务、目标、队列、设置写转成统一预览。嵌入式模型默认加载 Skill 与机器合同，完整个人设置按只读 JSON 数据进入原生系统指令；Claude/Codex 每次都使用独立私有临时指令文件，并在调用后移除，避免完整个人设置进入 argv 时触发长度限制。Claude 的文件参数参考[官方 CLI 文档](https://code.claude.com/docs/en/cli-reference)。

本机 Skill 默认安装目录参考 [Codex 官方文档](https://learn.chatgpt.com/docs/build-skills) 和 [Claude Code 官方文档](https://code.claude.com/docs/en/skills)；安装脚本不改变 CLI 全局配置。

个人设置的业务内容完整注入；助手运行时仅发送公开的 provider/model/超时/目录/CLI 路径、环境变量名与参数数量，不发送环境变量值、自定义参数文本或认证凭据。
