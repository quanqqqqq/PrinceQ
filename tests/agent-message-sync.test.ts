import test from 'node:test';
import assert from 'node:assert/strict';
import {syncAgentMessages, type ChatMessage} from '../src/lib/agent-message-state.ts';

function message(id: string, delivery?: ChatMessage['delivery']): ChatMessage {
  return {id, session_id: 'session', role: 'user', content: id, result: null, created_at: '2026-10-15T00:00:00Z', ...(delivery ? {delivery} : {})};
}
test('补齐其他页面生成的中间预览，按服务端历史顺序显示', () => {
  const previous = [message('old'), message('confirm'), message('reminder')];
  const server = [message('old'), {...message('preview'), role: 'agent' as const, content: '目标与任务待确认预览'}, message('confirm'), message('reminder')];
  assert.deepEqual(syncAgentMessages(previous, server), server);
  assert.deepEqual(syncAgentMessages(previous, server).map(item => item.id), ['old', 'preview', 'confirm', 'reminder']);
});
test('同步保留未保存的本地消息，并以服务端最新内容覆盖已保存消息', () => {
  const previous = [message('saved'), message('failed', 'failed'), message('cancelled', 'cancelled')];
  const server = [{...message('saved'), content: '服务端最新预览状态'}];
  assert.deepEqual(syncAgentMessages(previous, server), [...server, previous[1], previous[2]]);
  assert.deepEqual(syncAgentMessages([message('saved', 'sending')], server), server);
});
