/** PrinceQ's application instructions and request-scoped, read-only work context. */
import {usableObservation} from '../../shared/habit-inference.ts';
import {inferenceConnection} from './habit-inference-availability.ts';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {all, get, type Row} from '../db/connection.ts';
import {listTasks, listGoals, listAssignments} from '../repo/tasks.ts';
import {readAllHabits, buildSettingsSnapshot, type HabitContext} from '../domain/habits.ts';
import {rankTasks} from '../domain/queue.ts';
import {availableActions} from '../domain/transitions.ts';
import {displayDemoText} from '../../shared/demo-text.ts';
import type {AgentRequest} from './runtime.ts';
import type {AgentRuntimeConfig} from './runtime-config.ts';

export const PRINCEQ_SYSTEM_PROMPT_FILE = fileURLToPath(new URL('./princeq-system-prompt.md', import.meta.url));
export const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
export const readPrinceQSystemPrompt = () => fs.readFileSync(PRINCEQ_SYSTEM_PROMPT_FILE, 'utf8');
function jsonValue(raw: unknown, fallback: unknown = null): any {
  if (typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function clock(at: Date) {
  let timezone = process.env.PWQ_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', {timeZone: timezone}).format(at); } catch { timezone = 'Asia/Shanghai'; }
  return {now_utc: at.toISOString(), timezone,
    local_date: new Intl.DateTimeFormat('sv-SE', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(at),
    local_datetime: new Intl.DateTimeFormat('sv-SE', {timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).format(at)};
}
/** No queue snapshots are written: ranking is recomputed in memory from the same complete task set. */
export function buildPrinceQContext(req: AgentRequest, cfg: AgentRuntimeConfig, sessionId?: string | null) {
  const at = new Date();
  const tasks = listTasks(req.db);
  const goals = listGoals(req.db);
  const habits = readAllHabits();
  const activeHabits: HabitContext = {
    weights: habits.weights.payload.weights,
    preferredTaskTypes: habits.weights.payload.preferred_task_types,
    peakHours: habits.weights.payload.peak_hours,
    peakHoursByTaskType: habits.weights.payload.task_type_peak_hours,
    explicit: habits.explicit.payload.entries.filter(item => item.enabled),
    inferred: inferenceConnection(cfg).connected ? habits.inferred.payload.entries.filter(item => item.enabled && usableObservation(item)) : [],
    constraints: habits.constraints.payload.entries.filter(item => item.enabled),
  };
  const ranked = rankTasks(tasks, activeHabits, at);
  const byId = new Map(ranked.map(item => [item.task.id, item]));
  const previews = sessionId ? all<Row>(req.db,
    'SELECT token, summary, actions_json, status, created_at, resolved_at FROM agent_pending_actions WHERE session_id = ? ORDER BY created_at, rowid',
    [sessionId]).map(row => ({token: row.token, summary: row.summary, actions: jsonValue(row.actions_json, []),
      status: row.status, created_at: row.created_at, resolved_at: row.resolved_at})) : [];
  const previewStatus = new Map(previews.map(row => [row.token, row.status]));
  const history = sessionId ? all<Row>(req.db,
    'SELECT id, role, content, result, created_at FROM agent_messages WHERE session_id = ? ORDER BY created_at, rowid',
    [sessionId]).map(row => {
      const result = jsonValue(row.result);
      return {id: row.id, role: row.role === 'user' ? 'user' : 'assistant',
        content: row.role === 'user' ? row.content : result?.answer ?? result?.headline ?? row.content,
        created_at: row.created_at, result,
        preview_status: result?.pending_action?.token ? previewStatus.get(result.pending_action.token) ?? 'unknown' : null};
    }) : [];
  const legacyPreviews = history.flatMap(message => {
    const token = message.result?.pending_action?.token;
    if (typeof token !== 'string' || previewStatus.has(token)) return [];
    const row = get<Row>(req.db, 'SELECT token, kind, payload, created_at, consumed_at FROM pending_previews WHERE token = ?', [token]);
    if (!row) return [];
    const status = row.consumed_at ? 'resolved' : 'pending';
    message.preview_status = status;
    return [{token:row.token, kind:row.kind, payload:jsonValue(row.payload), status,
      created_at:row.created_at, resolved_at:row.consumed_at}];
  });
  return {
    context_version: 'princeq.work-context.v1',
    completeness: {history:'all_saved_messages_in_current_session', tasks:'all_statuses_and_all_fields', goals:'all_statuses_and_all_fields', habits:'all_current_entries_and_preferences', truncated:false},
    clock: clock(at), runtime: {provider: cfg.provider, configured_model: cfg.model},
    current_message: {content: req.message, target_task_id: req.targetTaskId ?? null, target_goal_id: req.targetGoalId ?? null, intent: req.intent ?? null},
    current_actor: get<Row>(req.db, 'SELECT id, kind, display_name FROM actors WHERE id = ?', [req.actorId]) ?? null,
    available_actors: all<Row>(req.db, 'SELECT id, kind, display_name FROM actors ORDER BY kind, id'),
    personal_settings: { ...buildSettingsSnapshot(), inferred_effectiveness: {agent_connected:inferenceConnection(cfg).connected,effective_ids:activeHabits.inferred.map(item=>item.id),policy:'real_evidence_only; expires_after_30_days; advisory_only'}, assistant: {enabled:cfg.enabled,provider:cfg.provider,configured_model:cfg.model,timeout_ms:cfg.timeout_ms,cli_path:cfg.cli_path,working_directory:cfg.working_directory,allowed_env_names:cfg.allowed_env_names,custom_args_count:cfg.args.length,updated_at:cfg.updated_at}, presentation: {autosave:'blur_then_idle_500ms',assistant_writes:'preview_then_confirm'} },
    history,
    work_snapshot: {
      tasks: tasks.map(task => ({...task, display_title: displayDemoText(task.title, task.is_demo),
        display_description: task.description ? displayDemoText(task.description, task.is_demo) : null,
        queue_position: byId.get(task.id)?.position ?? null, queue_score: byId.get(task.id)?.breakdown.score ?? null,
        available_actions: availableActions(task.status), assignment_history: listAssignments(req.db, task.id)})),
      goals: goals.map(goal => ({...goal, display_title: displayDemoText(goal.title, goal.is_demo),
        display_description: goal.description ? displayDemoText(goal.description, goal.is_demo) : null,
        task_ids: tasks.filter(task => task.goal_id === goal.id).map(task => task.id)})),
      queue: ranked.map(item => ({task_id:item.task.id, position:item.position, score:item.breakdown.score, breakdown:item.breakdown})),
      habits: {explicit:habits.explicit.payload.entries, inferred:habits.inferred.payload.entries,
        constraints:habits.constraints.payload.entries, preferences:habits.weights.payload,
        versions:{explicit:habits.explicit.updated_at, inferred:habits.inferred.updated_at,
          constraints:habits.constraints.updated_at, weights:habits.weights.updated_at}},
      model_previews: previews,
      goal_decomposition_previews: legacyPreviews,
    },
  };
}
export function serializePrinceQContext(context: ReturnType<typeof buildPrinceQContext>): string {
  const payload = JSON.stringify(context);
  if (Buffer.byteLength(payload, 'utf8') > MAX_CONTEXT_BYTES) throw new Error('PRINCEQ_CONTEXT_TOO_LARGE');
  return payload;
}
