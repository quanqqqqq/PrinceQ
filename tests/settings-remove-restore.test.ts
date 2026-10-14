/**
 * 「移除 / 恢复 / 忽略 / 未保存 / 恢复默认」这一组交互的纯逻辑层测试。
 *
 * 设置页没有 DELETE——移除就是 `enabled: false` 的软移除，所以界面必须自己把
 * 一份列表劈成「在用」与「已移除」两段，并且能认出哪条推断已经被采纳过（否则
 * 用户会重复点采纳，真实数据里就是这么出现三条重复的）。这些判断全都是纯函数，
 * 放在 `settings-contract.ts` 里由 node:test 直接覆盖，不需要 DOM。
 *
 * 脏数据是硬要求：habits/*.json 是本机文件，用户随手改过是常态，所以
 * `findAdoptedInferredIds` 面对任何形状的 `source_relation` 都只能跳过，不能抛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BALANCED_WEIGHTS,
  adoptToastMessage,
  findAdoptedInferredIds,
  isWeightsDirty,
  splitByEnabled,
} from '../src/components/settings/settings-contract.ts';
import type {
  ExplicitHabitEntry,
  SettingsWeights,
  WeightsDraft,
  WeightsPayload,
} from '../src/lib/settings-client.ts';

/** 造一条明确习惯；只有测试关心的字段需要传。 */
function explicit(overrides: Partial<ExplicitHabitEntry> & { id: string }): ExplicitHabitEntry {
  return {
    statement: `habit ${overrides.id}`,
    kind: 'scheduling',
    enabled: true,
    confidence: null,
    source: 'user',
    ...overrides,
  };
}

/** 一份完整的已存偏好快照，dirty 比较的基线。 */
const SAVED: WeightsPayload = {
  weights: { ...DEFAULT_BALANCED_WEIGHTS },
  preferred_task_types: ['deep_work', 'communication'],
  peak_hours: [9, 10, 14],
};

/** 与 SAVED 等价的草稿（深拷），用来验证「没动过 ≠ dirty」。 */
const cleanDraft = (): WeightsDraft => ({
  weights: { ...SAVED.weights },
  preferred_task_types: [...SAVED.preferred_task_types],
  peak_hours: [...SAVED.peak_hours],
});

// ── splitByEnabled ──────────────────────────────────────────────────────────

test('splitByEnabled 把一份列表劈成在用与已移除两段，各自保持原序', () => {
  const entries = [
    explicit({ id: 'a', enabled: true }),
    explicit({ id: 'b', enabled: false }),
    explicit({ id: 'c', enabled: true }),
    explicit({ id: 'd', enabled: false }),
  ];

  const { active, removed, removedCount } = splitByEnabled(entries);

  assert.deepEqual(
    active.map((entry) => entry.id),
    ['a', 'c'],
    '在用的保持文件里的原序，不重排',
  );
  assert.deepEqual(removed.map((entry) => entry.id), ['b', 'd']);
  assert.equal(removedCount, 2, 'N 就是已移除的条数，折叠区标题要用它');
});

test('splitByEnabled 空数组两段都空，计数为 0', () => {
  const { active, removed, removedCount } = splitByEnabled([]);
  assert.deepEqual(active, []);
  assert.deepEqual(removed, []);
  assert.equal(removedCount, 0);
});

test('splitByEnabled 全部 enabled → 没有已移除，折叠区该整块隐藏', () => {
  const entries = [explicit({ id: 'a' }), explicit({ id: 'b' })];
  const { active, removed, removedCount } = splitByEnabled(entries);
  assert.equal(active.length, 2);
  assert.deepEqual(removed, []);
  assert.equal(removedCount, 0);
});

test('splitByEnabled 全部 disabled → 主列表为空（走空态文案），N 等于总数', () => {
  const entries = [
    explicit({ id: 'a', enabled: false }),
    explicit({ id: 'b', enabled: false }),
    explicit({ id: 'c', enabled: false }),
  ];
  const { active, removed, removedCount } = splitByEnabled(entries);
  assert.deepEqual(active, []);
  assert.equal(removed.length, 3);
  assert.equal(removedCount, 3);
});

test('splitByEnabled 不改动入参数组', () => {
  const entries = [explicit({ id: 'a', enabled: false }), explicit({ id: 'b' })];
  const snapshot = entries.map((entry) => entry.id);
  splitByEnabled(entries);
  assert.deepEqual(entries.map((entry) => entry.id), snapshot, '原数组顺序不该被洗牌');
});

// ── findAdoptedInferredIds ──────────────────────────────────────────────────

test('findAdoptedInferredIds 收集所有被采纳过的 inferred id', () => {
  const entries = [
    explicit({
      id: 'e1',
      source_relation: { type: 'adopted_from_inferred', inferred_id: 'habit_i1' },
    }),
    explicit({ id: 'e2' }),
    explicit({
      id: 'e3',
      source_relation: { type: 'adopted_from_inferred', inferred_id: 'habit_i2' },
    }),
  ];

  const adopted = findAdoptedInferredIds(entries);

  assert.ok(adopted.has('habit_i1'), '已采纳的推断，采纳按钮要置灰');
  assert.ok(adopted.has('habit_i2'));
  assert.equal(adopted.size, 2);
});

test('findAdoptedInferredIds 已被移除（enabled:false）的采纳结果仍然算采纳过', () => {
  // 这条 explicit 是软移除的，但采纳这个动作确实发生过——服务端的
  // findExistingAdoption 不看 enabled，前端的置灰判断必须与它一致，
  // 否则按钮可点、请求却命中幂等，用户看到的是「点了没反应」。
  const adopted = findAdoptedInferredIds([
    explicit({
      id: 'e1',
      enabled: false,
      source_relation: { type: 'adopted_from_inferred', inferred_id: 'habit_i1' },
    }),
  ]);
  assert.ok(adopted.has('habit_i1'));
});

test('findAdoptedInferredIds 同一条推断被重复采纳过 → 去重成一个 id', () => {
  const adopted = findAdoptedInferredIds([
    explicit({
      id: 'e1',
      source_relation: { type: 'adopted_from_inferred', inferred_id: 'habit_i1' },
    }),
    explicit({
      id: 'e2',
      source_relation: { type: 'adopted_from_inferred', inferred_id: 'habit_i1' },
    }),
  ]);
  assert.deepEqual([...adopted], ['habit_i1'], '历史重复数据不该让 Set 变长');
});

test('findAdoptedInferredIds 面对手改的脏 source_relation 一律跳过而不抛', () => {
  // habits/*.json 是本机文件，用户随手编辑过是常态。
  const entries = [
    explicit({ id: 'n1', source_relation: null }),
    explicit({ id: 'n2', source_relation: undefined }),
    explicit({ id: 'n3', source_relation: 'adopted_from_inferred' }),
    explicit({ id: 'n4', source_relation: 42 }),
    explicit({ id: 'n5', source_relation: [] }),
    explicit({ id: 'n6', source_relation: {} }),
    explicit({ id: 'n7', source_relation: { type: 'something_else', inferred_id: 'habit_i9' } }),
    explicit({ id: 'n8', source_relation: { type: 'adopted_from_inferred' } }),
    explicit({ id: 'n9', source_relation: { type: 'adopted_from_inferred', inferred_id: 7 } }),
    explicit({ id: 'n10', source_relation: { type: 'adopted_from_inferred', inferred_id: '' } }),
    explicit({
      id: 'n11',
      source_relation: { type: 'adopted_from_inferred', inferred_id: null },
    }),
  ];

  const adopted = findAdoptedInferredIds(entries);

  assert.equal(adopted.size, 0, '只有 type 与 inferred_id 都是合法字符串才算采纳');
});

test('findAdoptedInferredIds 空列表给空 Set', () => {
  assert.equal(findAdoptedInferredIds([]).size, 0);
});

// ── adoptToastMessage ───────────────────────────────────────────────────────

test('adoptToastMessage 首次采纳说「已采纳」，幂等命中说「已采纳过」', () => {
  // 服务端命中幂等时什么都不写并返回 already:true。此时说「已采纳为明确习惯」
  // 是在撒谎——用户会以为刚刚新建了一条。
  assert.equal(adoptToastMessage({ already: true }), '该推断已采纳过');
  assert.equal(adoptToastMessage({ already: false }), '已采纳为明确习惯');
  assert.equal(adoptToastMessage({}), '已采纳为明确习惯', '首次采纳的返回体不带这个字段');
});

test('adoptToastMessage 对空返回体不抛', () => {
  // `request` 在 200 且 body 为空时回 null（settings-client.ts）。算文案时抛错会把
  // 一次已经成功的写搞成「失败」提示 + 不刷新，比少一句准确文案糟得多。
  assert.equal(adoptToastMessage(null), '已采纳为明确习惯');
  assert.equal(adoptToastMessage(undefined), '已采纳为明确习惯');
});

// ── isWeightsDirty ──────────────────────────────────────────────────────────

test('isWeightsDirty 草稿为 null 时不算 dirty', () => {
  assert.equal(isWeightsDirty(SAVED, null), false, '还没动过，不该挂「未保存」徽标');
});

test('isWeightsDirty 草稿与快照逐项相同 → 不 dirty', () => {
  assert.equal(isWeightsDirty(SAVED, cleanDraft()), false);
});

test('isWeightsDirty 六项权重任一不同都算 dirty', () => {
  const keys: (keyof SettingsWeights)[] = [
    'deadline',
    'manual_priority',
    'dependency',
    'effort',
    'habit_alignment',
    'context_switch',
  ];
  for (const key of keys) {
    const draft = cleanDraft();
    draft.weights[key] = 2;
    assert.equal(isWeightsDirty(SAVED, draft), true, `${key} 改了就该是 dirty`);
  }
});

test('isWeightsDirty 高峰时段增删改都算 dirty', () => {
  const added = cleanDraft();
  added.peak_hours = [...SAVED.peak_hours, 15];
  assert.equal(isWeightsDirty(SAVED, added), true, '多选一个小时');

  const removed = cleanDraft();
  removed.peak_hours = [9, 10];
  assert.equal(isWeightsDirty(SAVED, removed), true, '少选一个小时');

  const cleared = cleanDraft();
  cleared.peak_hours = [];
  assert.equal(isWeightsDirty(SAVED, cleared), true, '「清空高峰时段」之后必须提示未保存');

  const swapped = cleanDraft();
  swapped.peak_hours = [9, 10, 15];
  assert.equal(isWeightsDirty(SAVED, swapped), true, '条数一样但值不同');
});

test('isWeightsDirty 偏好任务类型增删改都算 dirty', () => {
  const added = cleanDraft();
  added.preferred_task_types = [...SAVED.preferred_task_types, 'admin'];
  assert.equal(isWeightsDirty(SAVED, added), true);

  const cleared = cleanDraft();
  cleared.preferred_task_types = [];
  assert.equal(isWeightsDirty(SAVED, cleared), true, '「清空偏好类型」之后必须提示未保存');

  const swapped = cleanDraft();
  swapped.preferred_task_types = ['deep_work', 'admin'];
  assert.equal(isWeightsDirty(SAVED, swapped), true, '条数一样但值不同');
});

test('isWeightsDirty 逐项比较，不受数组顺序外的引用差异影响', () => {
  // 页面层的 draft 是浅拷出来的新对象，引用必然不同——dirty 只能看值。
  const draft = cleanDraft();
  assert.notEqual(draft.weights, SAVED.weights);
  assert.equal(isWeightsDirty(SAVED, draft), false);
});

test('isWeightsDirty 对非整数的已存权重也认得出改动', () => {
  // 写入 schema 只要求 0..2，刻意不要求整数（server/http/schemas.ts），所以
  // Skill 客户端或手改文件都能留下 1.5。界面把 1.5 显示成「优先」档（clamp 后
  // 是 2），用户点「优先」把草稿变成真正的 2——两边都 clamp 的话这一步会被看成
  // 「没改」，徽标不出现，用户关掉页面就把改动丢了，而排序仍在用 1.5。
  const stored: WeightsPayload = {
    ...SAVED,
    weights: { ...SAVED.weights, deadline: 1.5 },
  };
  const draft: WeightsDraft = {
    weights: { ...stored.weights, deadline: 2 },
    preferred_task_types: [...SAVED.preferred_task_types],
    peak_hours: [...SAVED.peak_hours],
  };

  assert.equal(isWeightsDirty(stored, draft), true, '1.5 → 2 是真实改动');
});

test('isWeightsDirty 顺序不同但集合相同的数组不算 dirty', () => {
  // 已存文件里的顺序不由界面决定：saveSettingsWeights 原样落盘、schema 也不排序，
  // 所以 habits/weights.json 里可能是 [14, 9, 10]。界面的 toggle 永远按升序重建，
  // 于是「点开一个小时再点掉」会把草稿写成 [9, 10, 14]——集合完全一样。若按下标
  // 比较，徽标就再也消不掉了。
  const stored: WeightsPayload = {
    ...SAVED,
    peak_hours: [14, 9, 10],
    preferred_task_types: ['communication', 'deep_work'],
  };
  const draft: WeightsDraft = {
    weights: { ...SAVED.weights },
    peak_hours: [9, 10, 14],
    preferred_task_types: ['deep_work', 'communication'],
  };

  assert.equal(isWeightsDirty(stored, draft), false, '集合相同就不是改动');
});

test('isWeightsDirty 顺序无关也不能漏掉真实的增删', () => {
  const stored: WeightsPayload = { ...SAVED, peak_hours: [14, 9, 10] };
  const draft: WeightsDraft = {
    weights: { ...SAVED.weights },
    preferred_task_types: [...SAVED.preferred_task_types],
    peak_hours: [9, 10, 15],
  };
  assert.equal(isWeightsDirty(stored, draft), true, '把 14 换成 15 是真实改动');
});

test('isWeightsDirty 草稿省略两个数组字段时按空数组比较', () => {
  // WeightsDraft 里 preferred_task_types / peak_hours 都是可选的。
  const partial: WeightsDraft = { weights: { ...SAVED.weights } };
  assert.equal(isWeightsDirty(SAVED, partial), true, '快照里有选项、草稿里没有 → dirty');

  const emptySaved: WeightsPayload = {
    weights: { ...DEFAULT_BALANCED_WEIGHTS },
    preferred_task_types: [],
    peak_hours: [],
  };
  assert.equal(isWeightsDirty(emptySaved, partial), false, '两边都空 → 不 dirty');
});

// ── DEFAULT_BALANCED_WEIGHTS ────────────────────────────────────────────────

test('DEFAULT_BALANCED_WEIGHTS 六项全是 1', () => {
  assert.deepEqual(DEFAULT_BALANCED_WEIGHTS, {
    deadline: 1,
    manual_priority: 1,
    dependency: 1,
    effort: 1,
    habit_alignment: 1,
    context_switch: 1,
  });
});

test('「恢复默认权重」只动六项权重，不碰工作偏好', () => {
  // 这是按钮文案承诺的事：高峰时段与偏好类型各有独立的「清空」入口。
  const draft: WeightsDraft = {
    weights: { ...SAVED.weights, deadline: 2, effort: 0 },
    preferred_task_types: ['deep_work'],
    peak_hours: [9, 22],
  };

  const restored: WeightsDraft = { ...draft, weights: { ...DEFAULT_BALANCED_WEIGHTS } };

  assert.deepEqual(restored.weights, DEFAULT_BALANCED_WEIGHTS);
  assert.deepEqual(restored.preferred_task_types, ['deep_work'], '偏好类型原样保留');
  assert.deepEqual(restored.peak_hours, [9, 22], '高峰时段原样保留');
  // 恢复默认之后相对已存快照仍是 dirty——要靠「保存」才生效。
  assert.equal(isWeightsDirty(SAVED, restored), true);
});
