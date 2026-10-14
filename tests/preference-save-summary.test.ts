import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BALANCED_WEIGHTS, summarizeSortingPreferences } from '../src/components/settings/settings-contract.ts';
test('保存确认包含实际通用、类型时段和偏好类型，空时段明确展示',()=>{
  const shown=summarizeSortingPreferences({weights:{...DEFAULT_BALANCED_WEIGHTS},peak_hours:[9,10,11],preferred_task_types:['deep_work'],task_type_peak_hours:{deep_work:[9,10],communication:[14,15],admin:[]}});
  assert.match(shown,/通用时段：9:00、10:00、11:00/);
  assert.match(shown,/偏好类型：深度工作/);
  assert.match(shown,/深度工作独立时段：9:00、10:00/);
  assert.match(shown,/沟通独立时段：14:00、15:00/);
  assert.match(shown,/事务独立时段：不设高峰时段/);
});
