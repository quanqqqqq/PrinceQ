# Personal Work Queue implementation brief

Build a local-first task and goal management application in this existing official React/Vite/TypeScript/Tailwind/shadcn project. All implementation work must be made in this repository.

## Non-negotiable product model

- The Agent is the primary natural-language interaction layer.
- The Agent should infer a task's Eisenhower quadrant when possible, show its reasoning and confidence, and mark it as awaiting confirmation. The user can confirm or change the quadrant later using natural language.
- The four-quadrant view presents the distribution of all active requirements/tasks. It is not the only work-queue ranking algorithm.
- Goals and executable tasks are separate entities. The Agent should guide a user to decompose a goal into tasks. Each task can reference its original goal and display that goal as a tag.
- Provide a dedicated Goals tab with a clear goal-to-task view and progress.
- The work queue is separately ranked using deadline, manual priority, dependency readiness/blocking, estimated effort, user habits, context switching and manual overrides. Store an explainable score breakdown.
- Task lifecycle: inbox/unclaimed, claimed, in_progress, blocked, completed, archived. Leave room for human, agent and automation actors.
- Allow task claiming, releasing, starting, blocking and completing. Enforce one active claim per task.
- Write operations must support idempotency keys.
- Create/update + queue refresh + operation log must be transactional.
- Habit files are stored in this project under habits/. Skill/Agent reads them on every call. Separate explicit habits, inferred habits, hard constraints and scoring weights. Include schema versions and history. Validate writes and use atomic replacement where practical.
- Agent input panel is included in the web UI. In this version it should be functional against a deterministic local command endpoint for supported commands, and the code must leave a clean adapter boundary for replacing it with a real Agent runtime later. Do not fake an LLM. Clearly label deterministic local mode.
- Web UI and Skill must share the same local task API and SQLite source of truth.

## Technology and project constraints

- Keep the official frontend template and its conventions.
- Add a local Node service in this repository. Use only local dependencies. Use SQLite as the source of truth. Prefer Node's built-in sqlite support available in the installed Node version, avoiding native compilation packages if possible.
- Add scripts so one command can run the API and Vite concurrently, and one setup command initializes the database.
- Use a randomly selected stable dev port 28641 for the web app and 28642 for the API; update spark.json accordingly.
- The app must work on localhost on macOS.
- Do not expose the server beyond loopback by default.
- Validate all input with zod. Use parameterized SQL. Protect against duplicate operations and invalid state transitions.
- Seed a compact set of clearly labeled demo goals/tasks so the UI is meaningful on first run. No more than six tasks.

## Pages and UI

Use a Linear-inspired professional task workspace as the main visual language, combined with a ChatGPT-like Agent composer and Perplexity-like structured result/reason panels. Prefer a light neutral UI with precise borders, compact typography and restrained indigo/blue accents; avoid purple gradients and decorative glassmorphism.

Global left navigation and a compact top bar. Routes:

1. `/` Work queue: ranked, actionable tasks with position, score explanation, status, goal tag, quadrant confirmation state, claim/start/complete/block actions.
2. `/matrix` Quadrants: four active quadrants plus an unclassified/review-needed lane. Show all active tasks. Quadrant cards are display-oriented; simple filtering and task detail are enough. Do not use quadrant alone to rank the queue.
3. `/goals` Goals: goal cards/list with progress, linked tasks, and goal detail drawer or panel. Include a deterministic "draft tasks" interaction that produces a preview and requires user confirmation before creating tasks.
4. `/activity` Operation history and queue recalculation records.

A persistent right-side Agent panel on desktop, drawer on narrower screens. The Agent input should support local deterministic commands such as:
- create a task
- create a goal
- show queue
- claim/start/complete/block a task by title
- move/change a task quadrant
- add/list/disable an explicit habit
- explain why a task ranks where it does
When the command is ambiguous or destructive/batch-like, return a preview/clarification rather than writing.

## Data model

At minimum implement tables for:
- goals
- tasks
- actors
- task_assignments
- task_dependencies
- queue_snapshots / queue_entries or equivalent explainable ranking records
- operations with unique idempotency_key
- agent_sessions / agent_messages

Task fields should support title, description, goal_id, status, importance, urgency, quadrant_source, quadrant_confidence, quadrant_reason, quadrant_confirmed, deadline, estimated_minutes, cognitive_load, task_type, manual_priority, queue position/score, timestamps and version.

## Local API

Implement REST endpoints sufficient for the UI and future Skill:
- health
- goals CRUD + decomposition preview/confirm
- tasks list/create/read/update and lifecycle actions
- quadrant suggestion confirm/change
- queue read/recalculate/explain
- activity list
- habits read/write/disable
- agent message/session endpoints, with SSE or a clean event response shape if practical

Publish an OpenAPI-like concise reference in `docs/local-api.md` because the Skill will call it.

## Quality

- Add unit tests for queue scoring, quadrant inference and state transition validation.
- Add integration tests for idempotent create and claim conflict.
- Preserve the official app shell conventions and use existing shadcn components.
- All visible buttons must work. Do not add fake, disabled or "coming soon" controls.
- Add a clear empty state and error state.
- Keep files maintainable; split large components.
- Update package scripts and dependencies as needed.
- Run npm install, tests and npm run lint. Fix all errors.

Implement now. Do not only describe the solution. At the end, print a concise summary of files changed, commands run, test results and any intentionally deferred item.