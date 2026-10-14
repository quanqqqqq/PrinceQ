/** Manual end-to-end smoke check against a running local API (not part of `npm test`). */
const BASE = 'http://127.0.0.1:28642';

const call = async (method, path, body, key) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

const goals = await call('GET', '/api/goals');
const goal = goals.json.goals.find((g) => g.title.includes('billing'));
console.log('goal:', goal.title);

const preview = await call('POST', `/api/goals/${goal.id}/decomposition/preview`);
const p = preview.json.preview;
console.log(`drafts: ${p.drafts.length}`);
for (const d of p.drafts) {
  console.log(`  - ${d.title} | ${d.suggestion.quadrant} ${Math.round(d.suggestion.confidence * 100)}%`);
}

const confirm = await call(
  'POST',
  `/api/goals/${goal.id}/decomposition/confirm`,
  { preview_token: p.preview_token },
  'dec-smoke-1',
);
console.log(
  `confirmed: created ${confirm.json.tasks.length} tasks, progress ${confirm.json.goal.progress.completed}/${confirm.json.goal.progress.total}`,
);

const reuse = await call(
  'POST',
  `/api/goals/${goal.id}/decomposition/confirm`,
  { preview_token: p.preview_token },
  'dec-smoke-2',
);
console.log(`token reuse → HTTP ${reuse.status}: ${reuse.json.error?.message}`);

const habits = await call('GET', '/api/habits');
const h = habits.json;
console.log(
  `habits — explicit ${h.explicit.payload.entries.length}, inferred ${h.inferred.payload.entries.length}, constraints ${h.constraints.payload.entries.length}`,
);
console.log('weights:', JSON.stringify(h.weights.payload.weights));

const addHabit = await call(
  'POST',
  '/api/habits',
  { statement: 'Smoke: review PRs after lunch' },
  'habit-smoke-1',
);
console.log(`habit added: ${addHabit.json.habit.statement} (${addHabit.json.habit.id})`);

const activity = await call('GET', '/api/activity?limit=6');
console.log(`activity — ops ${activity.json.operations.length}, snapshots ${activity.json.snapshots.length}`);
for (const o of activity.json.operations.slice(0, 5)) {
  console.log(`  ${o.status} ${o.operation_type} | ${o.summary}`);
}

const agentDraft = await call('POST', '/api/agent/message', {
  message: 'draft tasks for goal "Demo goal: Learn SQLite internals"',
});
console.log(`agent draft → ${agentDraft.json.result.kind}: ${agentDraft.json.result.headline}`);
const token = agentDraft.json.result.pending_action?.token;

const agentConfirm = await call('POST', '/api/agent/confirm', { token }, 'agent-dec-smoke');
console.log(`agent confirm → ${agentConfirm.json.result.kind}: ${agentConfirm.json.result.headline}`);

const quad = await call('POST', '/api/agent/message', {
  message: 'move "Smoke test urgent customer escalation" to q2',
});
console.log(`quadrant move → ${quad.json.result.kind}: ${quad.json.result.headline}`);

const health = await call('GET', '/api/health');
console.log('final counts:', health.json.counts);
