import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayLabel, CHINESE_CALENDAR_LABELS } from '../src/lib/calendar-labels.ts';
import { renderOperationSummaryZh } from '../shared/activity-summary.ts';
test('日期可访问名称包含中文今天/已选择，月份导航也中文',()=>{
  const date=new Date(2026,9,14);
  const label=calendarDayLabel(date,{today:true,selected:true});
  assert.match(label,/今天.*已选择.*2026.*10.*14/);
  assert.doesNotMatch(label,/Today|Selected|Go to/);
  assert.equal(CHINESE_CALENDAR_LABELS.labelNext!(date),'下个月');
  assert.equal(CHINESE_CALENDAR_LABELS.labelPrevious!(date),'上个月');
});
test('习惯历史已知种子中文展示，任意用户标题和描述原样保留',()=>{
  assert.equal(renderOperationSummaryZh({summary:'启用明确习惯「Demo: tasks estimated over two hours usually slip by a day」'}),'启用明确习惯「示例：预计超过两小时的任务往往延后一天」');
  assert.equal(renderOperationSummaryZh({summary:'启用明确习惯「Demo: my own habit」'}),'启用明确习惯「Demo: my own habit」');
});
