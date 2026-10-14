/**
 * 新建任务草稿（UX-21）的语义测试。
 *
 * 覆盖：
 *   - 空/非空判定：manual_priority 的 '0' 档位算空，advanced 有键算有内容
 *   - serialize → parse 往返不丢字段（含 advanced 的 string/number/boolean）
 *   - parse 对坏数据的容错：损坏 JSON、错误 schemaVersion、非对象、空串 → null
 *   - normalize 的防御性：丢未知键、number 型优先级转字符串、过滤 advanced 非法值
 *   - duration_unit 的兼容：旧草稿没这个键、或存了非法值，都回退成 'minute'
 *   - restore 的自愈：空 store 给 EMPTY，坏数据给 EMPTY 并顺手清空存储
 *   - 「关闭后再打开可恢复」的两轮往返
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATE_TASK_DRAFT_KEY,
  CREATE_TASK_DRAFT_SCHEMA,
  EMPTY_CREATE_TASK_DRAFT,
  type CreateTaskDraftFields,
  type CreateTaskDraftStore,
  isCreateTaskDraftEmpty,
  normalizeCreateTaskFields,
  parseCreateTaskDraft,
  restoreCreateTaskDraft,
  serializeCreateTaskDraft,
} from '../src/lib/task-draft.ts';

/** 围绕同一个 key 的内存 store，顺带暴露 Map 以断言「真的清空了」。 */
function memoryStore(): CreateTaskDraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    load: () => map.get(CREATE_TASK_DRAFT_KEY) ?? null,
    save: (value: string) => {
      map.set(CREATE_TASK_DRAFT_KEY, value);
    },
    clear: () => {
      map.delete(CREATE_TASK_DRAFT_KEY);
    },
  };
}

const empty = (): CreateTaskDraftFields => ({ ...EMPTY_CREATE_TASK_DRAFT });

test('版本化 key 形状正确', () => {
  assert.equal(CREATE_TASK_DRAFT_KEY, 'pwq.create-task-draft.v1');
  assert.equal(CREATE_TASK_DRAFT_SCHEMA, 1);
});

test('isCreateTaskDraftEmpty: 空草稿为空，manual_priority 的 0 档位也算空', () => {
  assert.equal(isCreateTaskDraftEmpty(empty()), true);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), manual_priority: '0' }), true);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), manual_priority: '' }), true);
  // 纯空白不算内容。
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), title: '   ' }), true);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), description: '\n ' }), true);
});

test('isCreateTaskDraftEmpty: 手动优先级非 0、任一文本、advanced 有键都算有内容', () => {
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), manual_priority: '3' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), manual_priority: '-1' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), title: '写周报' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), description: '写完发群里' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), goal_id: 'goal-1' }), false);
  assert.equal(
    isCreateTaskDraftEmpty({ ...empty(), deadline_local: '2026-10-13T18:00' }),
    false,
  );
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), estimated_minutes_text: '45' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), task_type: 'deep_work' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), cognitive_load: 'high' }), false);
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), advanced: { repeat: 'weekly' } }), false);
  // 空 advanced 对象不算内容。
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), advanced: {} }), true);
});

test('serialize → parse 往返保留全部字段（含 advanced 的三种标量）', () => {
  const fields: CreateTaskDraftFields = {
    title: '整理三季度复盘笔记',
    description: '产出一页纸结论',
    goal_id: 'goal-42',
    deadline_local: '2026-10-20T09:30',
    estimated_minutes_text: '90',
    duration_unit: 'day',
    task_type: 'deep_work',
    cognitive_load: 'high',
    manual_priority: '2',
    advanced: { repeat: 'weekly', reminder_minutes: 15, pinned: true },
  };

  const parsed = parseCreateTaskDraft(serializeCreateTaskDraft(fields, '2026-10-12T12:30:00.000Z'));
  assert.deepEqual(parsed, fields);
});

test('serialize 产出的信封带版本与 savedAt', () => {
  const raw = serializeCreateTaskDraft({ ...empty(), title: 'x' }, '2026-10-12T12:30:00.000Z');
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(envelope.schemaVersion, CREATE_TASK_DRAFT_SCHEMA);
  assert.equal(envelope.savedAt, '2026-10-12T12:30:00.000Z');
  assert.equal((envelope.fields as CreateTaskDraftFields).title, 'x');
});

test('parse: 损坏 JSON / 错误 schemaVersion / 非对象 / 空串都返回 null', () => {
  assert.equal(parseCreateTaskDraft('not-json'), null);
  assert.equal(parseCreateTaskDraft('{"schemaVersion":1,"fields":'), null);
  assert.equal(
    parseCreateTaskDraft(JSON.stringify({ schemaVersion: 2, savedAt: '', fields: empty() })),
    null,
  );
  assert.equal(
    parseCreateTaskDraft(JSON.stringify({ schemaVersion: 1, savedAt: '', fields: 'nope' })),
    null,
  );
  assert.equal(parseCreateTaskDraft(JSON.stringify({ schemaVersion: 1, savedAt: '' })), null);
  assert.equal(parseCreateTaskDraft(JSON.stringify(['a', 'b'])), null);
  assert.equal(parseCreateTaskDraft(JSON.stringify('plain string')), null);
  assert.equal(parseCreateTaskDraft(''), null);
  assert.equal(parseCreateTaskDraft(null), null);
  assert.equal(parseCreateTaskDraft(undefined), null);
});

test('normalize: 丢弃未知键、number 型 manual_priority 转字符串', () => {
  const normalized = normalizeCreateTaskFields({
    title: '写周报',
    manual_priority: 3,
    bogus: 'should-be-dropped',
    id: 'not-a-draft-field',
  });

  assert.deepEqual(normalized, {
    ...EMPTY_CREATE_TASK_DRAFT,
    title: '写周报',
    manual_priority: '3',
  });
  assert.equal('bogus' in normalized, false);
  assert.equal('id' in normalized, false);
});

test('normalize: 非法字段值回退到缺省，非对象输入也返回合法对象', () => {
  const normalized = normalizeCreateTaskFields({
    title: { nested: true },
    description: ['a'],
    goal_id: null,
    task_type: false,
  });
  assert.deepEqual(normalized, EMPTY_CREATE_TASK_DRAFT);

  for (const input of [null, undefined, 'string', 42, true, ['a'], NaN]) {
    assert.deepEqual(normalizeCreateTaskFields(input), EMPTY_CREATE_TASK_DRAFT);
  }
});

test('normalize: duration_unit 只认三个单位，旧草稿与非法值一律回退 minute', () => {
  for (const unit of ['minute', 'day', 'month']) {
    assert.equal(normalizeCreateTaskFields({ duration_unit: unit }).duration_unit, unit);
  }

  // 旧草稿（这个键出现之前写的）与任何非法值都回到 'minute'——也就是数值直接
  // 当分钟数，与该字段存在之前的行为逐字一致。所以 schemaVersion 不必升。
  const legacy = normalizeCreateTaskFields({ title: '旧草稿', estimated_minutes_text: '90' });
  assert.equal(legacy.duration_unit, 'minute');
  for (const bad of ['week', '', 'MINUTE', 3, null, { unit: 'day' }]) {
    assert.equal(normalizeCreateTaskFields({ duration_unit: bad }).duration_unit, 'minute');
  }
});

test('isCreateTaskDraftEmpty: 只改单位没填数值不算有内容', () => {
  // 单位永远有值（默认 'minute'），单独切到「天」并没有填任何东西——否则空对话
  // 框一打开就会显示「清空草稿」。
  assert.equal(isCreateTaskDraftEmpty({ ...empty(), duration_unit: 'day' }), true);
  assert.equal(
    isCreateTaskDraftEmpty({ ...empty(), duration_unit: 'day', estimated_minutes_text: '2' }),
    false,
  );
});

test('normalize: 过滤 advanced 里的非法值，全非法时置 undefined', () => {
  const kept = normalizeCreateTaskFields({
    ...empty(),
    advanced: {
      repeat: 'weekly',
      reminder_minutes: 15,
      pinned: true,
      cleared: null,
      nested: { a: 1 },
      list: [1, 2],
      fn: undefined,
    },
  });
  assert.deepEqual(kept.advanced, {
    repeat: 'weekly',
    reminder_minutes: 15,
    pinned: true,
    cleared: null,
  });

  const allBad = normalizeCreateTaskFields({ ...empty(), advanced: { nested: {}, list: [] } });
  assert.equal(allBad.advanced, undefined);

  const emptyAdvanced = normalizeCreateTaskFields({ ...empty(), advanced: {} });
  assert.equal(emptyAdvanced.advanced, undefined);

  const notAnObject = normalizeCreateTaskFields({ ...empty(), advanced: 'nope' });
  assert.equal(notAnObject.advanced, undefined);
});

test('restoreCreateTaskDraft: 空 store 返回 EMPTY 且不抛错', () => {
  const store = memoryStore();
  assert.deepEqual(restoreCreateTaskDraft(store), EMPTY_CREATE_TASK_DRAFT);
  assert.equal(store.map.size, 0);
});

test('restoreCreateTaskDraft: save 后恢复与原字段深等', () => {
  const store = memoryStore();
  const fields: CreateTaskDraftFields = {
    ...empty(),
    title: '整理三季度复盘笔记',
    estimated_minutes_text: '90',
    manual_priority: '2',
  };

  store.save(serializeCreateTaskDraft(fields));
  assert.deepEqual(restoreCreateTaskDraft(store), fields);
  // 恢复不消费草稿：存储里仍然留着。
  assert.equal(store.map.size, 1);
});

test('restoreCreateTaskDraft: 损坏数据返回 EMPTY 并清空存储', () => {
  const store = memoryStore();
  store.save('not-json');

  assert.deepEqual(restoreCreateTaskDraft(store), EMPTY_CREATE_TASK_DRAFT);
  assert.equal(store.map.size, 0);
});

test('关闭后再打开可恢复：两轮 update → save → restore 结果一致', () => {
  const store = memoryStore();

  // 第一轮：填标题 + 时长，关闭（不清空），再打开。
  let fields = { ...empty(), title: '整理三季度复盘笔记' };
  store.save(serializeCreateTaskDraft(fields));
  fields = { ...fields, estimated_minutes_text: '90' };
  store.save(serializeCreateTaskDraft(fields));

  const firstReopen = restoreCreateTaskDraft(store);
  assert.deepEqual(firstReopen, fields);

  // 第二轮：在恢复出来的草稿上继续改，再关再开。
  const edited = { ...firstReopen, cognitive_load: 'high', manual_priority: '2' };
  store.save(serializeCreateTaskDraft(edited));

  const secondReopen = restoreCreateTaskDraft(store);
  assert.deepEqual(secondReopen, edited);
  // 幂等：不再写入也能反复恢复出同一份。
  assert.deepEqual(restoreCreateTaskDraft(store), secondReopen);
});
