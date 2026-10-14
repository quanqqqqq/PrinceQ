/**
 * 目标拆解模板 / 查重 / 紧急判定的语义测试（UX-22）。
 *
 * 全程跑在一次性内存库上——绝不碰 data/work-queue.db；habits 指向临时目录，
 * 磁盘上的 habits/ 不受影响。
 *
 * 覆盖：
 *   - 中文模板：标题前缀用全角冒号，后缀与描述均为中文
 *   - 针对性模板：发布上线与学习掌握命中不同阶段
 *   - 已完成不重做：命中已完成任务的阶段整条消失，notes 交代原因
 *   - 未完成重复：仍出草稿，但带 duplicate 标记供前端默认取消勾选
 *   - 无截止不判紧急：没有 target_date 时不出 q1/q3，signals 说明原因
 *   - acceptedDrafts 仍按下标生效（与 UX-09 一致）
 *   - defaultDraftSelection：两处前端共用的默认勾选规则（纯函数，不碰库）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, withTempHabits } from './helpers.ts';
import { createGoal, previewDecomposition, confirmDecomposition } from '../server/repo/goal-service.ts';
import { createTask } from '../server/repo/task-service.ts';
import { run } from '../server/db/connection.ts';
import {
  matchPhaseToExisting,
  normalizeTitleBody,
  normalizeTitleKey,
} from '../server/domain/decomposition.ts';
import { defaultDraftSelection } from '../shared/decomposition.ts';
import type { DecompositionDraft } from '../shared/types.ts';

withTempHabits();

/** 全角冒号：草稿标题是 `目标标题：阶段后缀`。 */
const SEP = '：';

const hasChinese = (text: string): boolean => /[一-鿿]/.test(text);
/** 中文模板里不该再出现成句的英文动作短语。 */
const hasAsciiWords = (text: string): boolean => /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(text);

// ── 1) 中文模板 ─────────────────────────────────────────────────────────────

test('UX-22: 学习类目标的草稿标题以「目标：」开头，后缀与描述均为中文', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  const preview = previewDecomposition(db, goal.id);
  assert.ok(preview.drafts.length >= 3, '学习模板应有多个阶段');

  for (const draft of preview.drafts) {
    assert.ok(
      draft.title.startsWith(`学习 Rust${SEP}`),
      `标题应以「学习 Rust${SEP}」开头，实际：${draft.title}`,
    );

    const suffix = draft.title.slice(`学习 Rust${SEP}`.length);
    assert.ok(hasChinese(suffix), `后缀应为中文动作短语：${suffix}`);
    assert.ok(!hasAsciiWords(suffix), `后缀不应是英文短语：${suffix}`);

    assert.ok(hasChinese(draft.description), `描述应为中文：${draft.description}`);
    assert.ok(!hasAsciiWords(draft.description), `描述不应是英文句子：${draft.description}`);
  }

  // notes 也必须是中文，且点明命中的模板是「学习掌握」。
  assert.ok(
    preview.notes.some((n) => n.includes('学习掌握')),
    `notes 应说明命中学习掌握模板：${JSON.stringify(preview.notes)}`,
  );
  for (const note of preview.notes) {
    assert.ok(hasChinese(note), `notes 应全中文：${note}`);
  }
});

// ── 2) 针对性模板 ───────────────────────────────────────────────────────────

test('UX-22: 发布上线类目标命中发布模板，与学习模板的阶段不同', () => {
  const db = freshDb();
  const delivery = createGoal(db, { title: '上线计费系统重写' });
  const learning = createGoal(db, { title: '学习 SQLite 内部原理' });

  const deliveryPreview = previewDecomposition(db, delivery.id);
  const learningPreview = previewDecomposition(db, learning.id);

  const deliverySuffixes = deliveryPreview.drafts.map((d) => d.title.split(SEP)[1]);
  const learningSuffixes = learningPreview.drafts.map((d) => d.title.split(SEP)[1]);

  // 发布模板有「发布并同步」这种交付动作。
  assert.ok(
    deliverySuffixes.some((s) => s.includes('发布并同步')),
    `发布模板应含发布动作：${JSON.stringify(deliverySuffixes)}`,
  );
  assert.ok(
    deliveryPreview.notes.some((n) => n.includes('发布上线')),
    `notes 应说明命中发布上线模板：${JSON.stringify(deliveryPreview.notes)}`,
  );

  // 两套模板的阶段集合必须真的不一样，不是同一份兜底。
  assert.notDeepEqual(deliverySuffixes, learningSuffixes, '不同类型目标应命中不同模板');
  assert.ok(
    learningSuffixes.some((s) => s.includes('精读')),
    `学习模板应含精读动作：${JSON.stringify(learningSuffixes)}`,
  );
});

test('UX-22: 评审与文档类目标各自命中新增模板', () => {
  const db = freshDb();
  const reviewGoal = createGoal(db, { title: '完成季度代码评审' });
  const writingGoal = createGoal(db, { title: '写一份架构文档' });

  const reviewPreview = previewDecomposition(db, reviewGoal.id);
  const writingPreview = previewDecomposition(db, writingGoal.id);

  assert.ok(
    reviewPreview.notes.some((n) => n.includes('评审复核')),
    JSON.stringify(reviewPreview.notes),
  );
  assert.ok(
    writingPreview.notes.some((n) => n.includes('文档写作')),
    JSON.stringify(writingPreview.notes),
  );
});

test('UX-22: 未命中任何模板时走中文兜底，notes 说明是「通用」', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '搬一次家' });

  const preview = previewDecomposition(db, goal.id);
  assert.ok(
    preview.notes.some((n) => n.includes('通用')),
    JSON.stringify(preview.notes),
  );
  for (const draft of preview.drafts) {
    const suffix = draft.title.slice(`搬一次家${SEP}`.length);
    assert.ok(hasChinese(suffix), suffix);
    assert.ok(hasChinese(draft.description), draft.description);
  }
});

// ── 3) 已完成不重做 ─────────────────────────────────────────────────────────

test('UX-22: 命中已完成任务的阶段不再出草稿，notes 说明不再重复建议', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  // 先看一眼原始阶段，挑第二个阶段的主体来造一个「已完成」的同名任务。
  const before = previewDecomposition(db, goal.id);
  const targetTitle = before.drafts[1].title;
  const targetSuffix = targetTitle.slice(`学习 Rust${SEP}`.length);

  createTask(db, { title: targetTitle, goal_id: goal.id });
  run(db, "UPDATE tasks SET status = 'completed' WHERE title = ?", [targetTitle]);

  const after = previewDecomposition(db, goal.id);

  // 这个阶段整条消失，其余阶段仍在。
  assert.ok(
    !after.drafts.some((d) => d.title === targetTitle),
    `已完成的阶段不该再出草稿：${JSON.stringify(after.drafts.map((d) => d.title))}`,
  );
  assert.equal(after.drafts.length, before.drafts.length - 1, '只少掉命中的那一条');

  // notes 要讲清为什么少了一条。
  assert.ok(
    after.notes.some((n) => n.includes('不再重复建议') && n.includes(targetSuffix)),
    `notes 应说明跳过原因：${JSON.stringify(after.notes)}`,
  );
  // 已完成的任务不会被当成「待确认的重复」。
  assert.ok(
    after.drafts.every((d) => d.duplicate?.existing_status !== 'completed'),
    '已完成任务不应出现在 duplicate 提示里',
  );
});

// ── 4) 未完成重复默认标记 ───────────────────────────────────────────────────

test('UX-22: 命中未完成任务的阶段仍出草稿，但带 duplicate 指向该任务', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  const before = previewDecomposition(db, goal.id);
  const targetTitle = before.drafts[0].title;
  // 默认状态就是 inbox（未完成）。
  createTask(db, { title: targetTitle, goal_id: goal.id });

  const after = previewDecomposition(db, goal.id);

  // 阶段仍在——未完成的事情还是该建议做。
  assert.equal(after.drafts.length, before.drafts.length, '未完成的重复不跳过');

  const flagged = after.drafts.find((d) => d.title === targetTitle);
  assert.ok(flagged, '对应阶段仍应出现在草稿里');
  assert.ok(flagged.duplicate, '应带重复标记');
  assert.equal(flagged.duplicate.existing_title, targetTitle);
  assert.equal(flagged.duplicate.existing_status, 'inbox');
  assert.ok(hasChinese(flagged.duplicate.reason), flagged.duplicate.reason);
  assert.ok(
    flagged.duplicate.reason.includes('默认未勾选'),
    `理由应说明默认不勾选：${flagged.duplicate.reason}`,
  );

  // 其它阶段不受牵连。
  for (const draft of after.drafts) {
    if (draft.title !== targetTitle) {
      assert.ok(!draft.duplicate, `无关阶段不应被标重复：${draft.title}`);
    }
  }
});

test('UX-22: 没有任何已有任务时所有草稿都不带 duplicate', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  const preview = previewDecomposition(db, goal.id);
  for (const draft of preview.drafts) {
    assert.ok(!draft.duplicate, `空目标的草稿不该有重复标记：${draft.title}`);
  }
  assert.ok(
    preview.notes.some((n) => n.includes('本目标已有 0 个任务')),
    JSON.stringify(preview.notes),
  );
});

// ── 5) 无截止依据不擅自判紧急 ───────────────────────────────────────────────

test('UX-22: 目标无 target_date 时草稿不进紧急象限，signals 说明原因', () => {
  const db = freshDb();
  // 发布类目标在有死线时本会落到 q1，正好用来验证降档确实生效。
  const goal = createGoal(db, { title: '上线计费系统重写', description: '发布给客户' });

  const preview = previewDecomposition(db, goal.id);
  assert.ok(preview.drafts.length > 0);

  for (const draft of preview.drafts) {
    assert.equal(draft.deadline, null, '无目标日期时草稿不该带死线');
    assert.ok(
      draft.suggestion.quadrant !== 'q1' && draft.suggestion.quadrant !== 'q3',
      `无截止依据不该判紧急，实际 ${draft.title} → ${draft.suggestion.quadrant}`,
    );
  }

  // 至少有一条确实被降档了，并留下中文信号。
  const remapped = preview.drafts.filter((d) =>
    d.suggestion.signals.some((s) => s.includes('未按紧急')),
  );
  assert.ok(remapped.length > 0, '应有草稿被降档并记录信号');
  for (const draft of remapped) {
    assert.ok(draft.suggestion.urgency_score < 50, `降档后紧急分应低于 50：${draft.suggestion.urgency_score}`);
  }

  assert.ok(
    preview.notes.some((n) => n.includes('目标没有截止日期') && n.includes('不按紧急象限')),
    `notes 应说明不判紧急：${JSON.stringify(preview.notes)}`,
  );
});

test('UX-22: 目标有 target_date 时草稿照常带死线，紧急判定不被改写', () => {
  const db = freshDb();
  const target = new Date(Date.now() + 36e5 * 24 * 3).toISOString();
  const goal = createGoal(db, { title: '上线计费系统重写', target_date: target });

  const preview = previewDecomposition(db, goal.id);
  for (const draft of preview.drafts) {
    assert.ok(draft.deadline, '有目标日期时应铺死线');
    assert.ok(
      !draft.suggestion.signals.some((s) => s.includes('未按紧急')),
      '有死线依据时不该追加降档信号',
    );
  }
  assert.ok(
    preview.notes.some((n) => n.includes('均匀分布')),
    JSON.stringify(preview.notes),
  );
});

test('UX-22: 确认后落库的象限与预览展示的一致（降档不能在确认时被重算掉）', () => {
  const db = freshDb();
  // 无 target_date 的发布类目标：若确认时重跑推断，这几条会退回 q1/q3。
  const goal = createGoal(db, { title: '上线计费系统重写', description: '发布给客户' });

  const preview = previewDecomposition(db, goal.id);
  const { tasks } = confirmDecomposition(db, preview.preview_token);
  assert.equal(tasks.length, preview.drafts.length);

  preview.drafts.forEach((draft, index) => {
    assert.equal(
      tasks[index].quadrant,
      draft.suggestion.quadrant,
      `第 ${index} 条：预览说 ${draft.suggestion.quadrant}，落库却是 ${tasks[index].quadrant}`,
    );
    // 降档过的草稿落库后同样不该是紧急象限。
    assert.ok(
      tasks[index].quadrant !== 'q1' && tasks[index].quadrant !== 'q3',
      `无截止依据的任务不该落在紧急象限：${tasks[index].title} → ${tasks[index].quadrant}`,
    );
  });

  // 仍然是本地规则给的未确认建议，provenance 没被偷换成 agent/user。
  for (const task of tasks) {
    assert.equal(task.quadrant_source, 'rule');
    assert.equal(task.quadrant_confirmed, false);
  }
});

test('UX-22: 降档后的 reason 与 urgency 跟象限自洽，不留「重要且紧急」的旧话', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '上线计费系统重写', description: '发布给客户' });

  const preview = previewDecomposition(db, goal.id);
  const demoted = preview.drafts.filter((d) =>
    d.suggestion.signals.some((s) => s.includes('未按紧急')),
  );
  assert.ok(demoted.length > 0, '应有草稿被降档');

  for (const draft of demoted) {
    // reason 的开头不能还写着降档前的紧急结论。
    assert.ok(
      !/Important & urgent|Urgent, not important/.test(draft.suggestion.reason),
      `降档后的理由不该再说紧急：${draft.suggestion.reason}`,
    );
    // 1..5 的 urgency 与 0..100 的 urgency_score 必须同向。
    assert.ok(draft.suggestion.urgency_score < 50, String(draft.suggestion.urgency_score));
    assert.ok(
      draft.suggestion.urgency < 3.5,
      `urgency 轴应同步降档，实际 ${draft.suggestion.urgency}/5`,
    );
  }
});

// ── 6) acceptedDrafts 复用（与 UX-09 一致）──────────────────────────────────

test('UX-22: acceptedDrafts 按下标只创建被勾选的草稿，标题描述 verbatim 落地', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  // 造一个重复项，让第 0 条草稿默认被取消勾选。
  const first = previewDecomposition(db, goal.id).drafts[0];
  createTask(db, { title: first.title, goal_id: goal.id });

  const preview = previewDecomposition(db, goal.id);
  const duplicateIndexes = preview.drafts
    .map((d, i) => (d.duplicate ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(duplicateIndexes.length > 0, '应至少有一条被标为重复');

  // 前端默认勾选 = 非重复项。这里只提交其中两条，并改写文本。
  const keep = preview.drafts
    .map((_, i) => i)
    .filter((i) => !duplicateIndexes.includes(i))
    .slice(0, 2);
  assert.equal(keep.length, 2, '去掉重复项后仍有至少两条可选');

  const overrides = keep.map((index, n) => ({
    index,
    title: `【我改的】第 ${n + 1} 步`,
    description: `自定义描述 ${n + 1}`,
  }));
  const { tasks } = confirmDecomposition(db, preview.preview_token, { acceptedDrafts: overrides });

  assert.equal(tasks.length, 2, '只创建被勾选的草稿');
  assert.equal(tasks[0].title, '【我改的】第 1 步');
  assert.equal(tasks[0].description, '自定义描述 1');
  assert.equal(tasks[1].title, '【我改的】第 2 步');
  assert.equal(tasks[1].description, '自定义描述 2');

  // 被默认取消的重复项没有被创建。
  assert.ok(
    !tasks.some((t) => t.title === first.title),
    '默认未勾选的重复项不应落地',
  );
});

// ── 纯函数：归一化与匹配 ────────────────────────────────────────────────────

test('UX-22: normalizeTitleKey 去标点、去空白、统一大小写', () => {
  assert.equal(normalizeTitleKey('Learn Rust：精读！'), 'learnrust精读');
  assert.equal(normalizeTitleKey('  A - B  '), 'ab');
  assert.equal(normalizeTitleKey(''), '');
});

test('UX-22: normalizeTitleBody 剥掉「目标标题：」前缀后再比主体', () => {
  const body = normalizeTitleBody('学习 Rust：精读核心部分并做笔记', '学习 Rust');
  assert.equal(body, normalizeTitleKey('精读核心部分并做笔记'));
  // 换一种分隔符写法也该剥掉。
  assert.equal(normalizeTitleBody('学习 Rust - 精读核心部分并做笔记', '学习 Rust'), body);
  // 没带前缀时原样归一化。
  assert.equal(normalizeTitleBody('精读核心部分并做笔记', '学习 Rust'), body);
});

test('UX-22: matchPhaseToExisting 主体相等或互相包含才算重复', () => {
  const goalTitle = '学习 Rust';
  const existing = [{ title: '学习 Rust：精读核心部分并做笔记', status: 'inbox' }];

  // 主体相同 → 命中。
  const hit = matchPhaseToExisting('精读核心部分并做笔记', goalTitle, existing);
  assert.ok(hit, '主体相同应命中');
  assert.equal(hit.task.status, 'inbox');
  assert.ok(hasChinese(hit.reason), hit.reason);

  // 主体是前者的子串 → 命中（包含关系）。
  assert.ok(matchPhaseToExisting('精读核心部分', goalTitle, existing), '包含关系应命中');

  // 完全无关 → 不命中。
  assert.equal(matchPhaseToExisting('写出可复习的小结', goalTitle, existing), null);
  // 空后缀不该匹配任何东西。
  assert.equal(matchPhaseToExisting('', goalTitle, existing), null);
});

test('UX-22: 已完成的精确命中优先于更早插入的未完成模糊命中', () => {
  const goalTitle = '学习 Rust';
  // 措辞更松的未完成任务排在前面，精确命中的已完成任务排在后面。
  const existing = [
    { title: '学习 Rust：精读核心部分', status: 'inbox' },
    { title: '学习 Rust：精读核心部分并做笔记', status: 'completed' },
  ];

  const hit = matchPhaseToExisting('精读核心部分并做笔记', goalTitle, existing);
  assert.ok(hit, '应命中');
  assert.equal(
    hit.task.status,
    'completed',
    '必须返回已完成的那条——否则「已完成不重做」会被未完成的同类任务挡掉',
  );
});

test('UX-22: 已完成任务被更松的未完成任务「挡住」时，阶段仍然整条跳过', () => {
  const db = freshDb();
  const goal = createGoal(db, { title: '学习 Rust' });

  const before = previewDecomposition(db, goal.id);
  const exact = before.drafts.find((d) => d.title.includes('精读核心部分并做笔记'));
  assert.ok(exact, '学习模板应含精读阶段');

  // 先插入措辞更松的未完成任务，再插入精确命中的已完成任务。
  createTask(db, { title: '学习 Rust：精读核心部分', goal_id: goal.id });
  createTask(db, { title: exact.title, goal_id: goal.id });
  run(db, "UPDATE tasks SET status = 'completed' WHERE title = ?", [exact.title]);

  const after = previewDecomposition(db, goal.id);
  assert.ok(
    !after.drafts.some((d) => d.title === exact.title),
    `已完成的阶段仍应跳过：${JSON.stringify(after.drafts.map((d) => d.title))}`,
  );
  assert.ok(
    after.notes.some((n) => n.includes('不再重复建议')),
    `notes 应说明跳过：${JSON.stringify(after.notes)}`,
  );
});

// ── 纯函数：预览默认勾选规则（两处前端共用）────────────────────────────────

/** 造一条最小形状的草稿；只有 title 与 duplicate 影响默认勾选。 */
const draftOf = (
  title: string,
  duplicate?: DecompositionDraft['duplicate'],
): DecompositionDraft => ({
  title,
  description: `${title} 的描述`,
  estimated_minutes: 30,
  task_type: 'deep_work',
  cognitive_load: 'medium',
  deadline: null,
  suggestion: {
    quadrant: 'q2',
    importance: 4,
    urgency: 2,
    importance_score: 70,
    urgency_score: 30,
    confidence: 0.6,
    reason: '重要不紧急',
    signals: [],
  },
  duplicate: duplicate ?? null,
});

test('UX-22: defaultDraftSelection 对无重复的草稿默认全勾', () => {
  const selection = defaultDraftSelection([draftOf('第一步'), draftOf('第二步'), draftOf('第三步')]);
  assert.deepEqual(selection, [true, true, true]);
});

test('UX-22: defaultDraftSelection 把疑似重复的那条默认取消勾选', () => {
  const selection = defaultDraftSelection([
    draftOf('第一步'),
    draftOf('第二步', {
      existing_title: '学习 Rust：第二步',
      existing_status: 'inbox',
      reason: '与已有未完成任务疑似重复，默认未勾选',
    }),
    draftOf('第三步'),
  ]);
  assert.deepEqual(selection, [true, false, true]);
});

test('UX-22: defaultDraftSelection 对空草稿列表返回空数组', () => {
  assert.deepEqual(defaultDraftSelection([]), []);
});

test('UX-22: defaultDraftSelection 对已完成的重复项同样默认不勾（遵后端不建议）', () => {
  const selection = defaultDraftSelection([
    draftOf('第一步', {
      existing_title: '学习 Rust：第一步',
      existing_status: 'completed',
      reason: '已有同名任务已完成，默认未勾选',
    }),
    draftOf('第二步'),
  ]);
  assert.deepEqual(selection, [false, true]);
});
