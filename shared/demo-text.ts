/**
 * 示例数据的只读中文展示映射。
 *
 * 放在 shared/ 是为了让界面（展示）与服务端（搜索）用同一张表：界面按它渲染
 * 中文别名，`listOperations` 按它把中文搜索词回解析成英文原值。
 */

/**
 * `is_demo = true` 的目标/任务标题与描述的中文展示。
 *
 * 只读映射：数据库里的英文原值不变，仅在界面上替换。非示例数据永不查表。
 */
export const DEMO_TEXT: Record<string, string> = {
  'Demo: deep work happens in the morning, before meetings start': '示例：上午会议开始前安排深度工作',
  'Demo: batch review and communication work into one afternoon block': '示例：下午集中处理评审与沟通',
  'Demo: tasks estimated over two hours usually slip by a day': '示例：预计超过两小时的任务往往延后一天',
  'Demo: no scheduled work after 20:00': '示例：20:00 后不安排工作',
  // 目标
  'Demo goal: Ship the billing rewrite': '示例目标：上线计费系统重写',
  'Replace the legacy invoicing path. Demo data — delete it once you add your own work.':
    '替换旧的开票链路。这是示例数据，录入自己的工作后可以删除。',
  'Demo goal: Learn SQLite internals': '示例目标：学习 SQLite 内部原理',
  'Understand WAL, indexes and query planning well enough to debug slow reads.':
    '把 WAL、索引和查询计划理解到能排查慢查询的程度。',
  'Demo goal: Sustainable work rhythm': '示例目标：可持续的工作节奏',
  'Protect mornings for deep work and stop finishing the day depleted.':
    '把上午留给深度工作，避免每天结束时精力耗尽。',

  // 任务
  'Demo: Fix the production invoice rounding incident': '示例：修复线上发票金额舍入故障',
  'Customers report cent-level mismatches on invoices. Urgent, customer-facing revenue impact.':
    '客户反馈发票出现分位差异。紧急，直接影响客户与收入。',
  'Demo: Design the new invoice schema': '示例：设计新的发票表结构',
  'Decide the table layout and migration path before writing the migration.':
    '在写迁移脚本之前先定好表结构与迁移路径。',
  'Demo: Write the invoice migration script': '示例：编写发票数据迁移脚本',
  'Backfill historical invoices once the schema is agreed.': '表结构确定后回填历史发票数据。',
  'Demo: Read the SQLite WAL design doc and take notes': '示例：阅读 SQLite WAL 设计文档并做笔记',
  'One authoritative source, skimmed then studied. No deadline pressure.':
    '一份权威资料，先通读再精读。没有截止压力。',
  'Demo: Reply to the vendor renewal email today': '示例：今天回复供应商续约邮件',
  'They are waiting on a yes/no. Quick, but someone is blocked on me.':
    '对方在等一个明确答复。事情很小，但有人被我卡住。',
  'Demo: Block mornings for deep work in the calendar': '示例：在日历中锁定上午的深度工作时间',
  'Make the habit structural rather than aspirational.': '把这个习惯变成制度，而不是口号。',
  'Waiting for next quarter calendar to open': '等待下个季度的日历开放',
};

/**
 * 示例内容的中文展示文案。
 *
 * `isDemo` 为假时直接返回原文——这是不翻译用户内容的那道闸门。
 */
export function displayDemoText(text: string | null | undefined, isDemo: boolean): string {
  if (!text) return '';
  if (!isDemo) return text;
  return DEMO_TEXT[text.trim()] ?? text;
}
