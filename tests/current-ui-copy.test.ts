import test from 'node:test';
import assert from 'node:assert/strict';
import { demoTitle, agentFactLabel, agentFactValue } from '../src/lib/i18n.ts';
import { translateSystemText } from '../shared/system-text.ts';
test('已知系统示例与旧回复中文显示，用户原文保留', () => {
  assert.equal(demoTitle('Demo: deep work happens in the morning, before meetings start'), '示例：上午会议开始前安排深度工作');
  assert.equal(demoTitle('Demo: my own English habit'), 'Demo: my own English habit');
  assert.equal(agentFactLabel('#1 Demo: Design the new invoice schema'), '#1 示例：设计新的发票表结构');
  assert.equal(agentFactLabel('show queue'), '查看队列排名');
  assert.equal(agentFactValue('show queue','show queue top 5'), '看看队列前5个任务');
  assert.equal(agentFactValue('Your input','show queue top 5'), 'show queue top 5');
  const shown=agentFactValue('#1 Demo: Design the new invoice schema','score 72.5 · inbox · goal: Demo goal: Ship the billing rewrite');
  assert.equal(shown,'评分 72.5 · 待处理 · 目标：示例目标：上线计费系统重写');
  assert.doesNotMatch(translateSystemText('Ranked by snapshot snap_123 (pwq-queue-1.0.0).'),/snap_|pwq-queue/);
});
