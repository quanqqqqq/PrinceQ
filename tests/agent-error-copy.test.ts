import test from 'node:test';
import assert from 'node:assert/strict';
import { translateSystemText } from '../shared/system-text.ts';
test('生命周期拒绝与模型预览动词中文显示，用户标题原样保留',()=>{
  assert.equal(translateSystemText('Cannot claim a task in status "in_progress" — allowed from: inbox.'),'当前任务为「进行中」，不能领取；允许的起始状态：待处理。');
  assert.equal(translateSystemText('claim：My user title <img src=x>'),'领取：My user title <img src=x>');
});
