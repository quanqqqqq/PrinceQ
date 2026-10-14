import type {TaskType} from './types.ts';
export type ObservationPattern='start_hour'|'task_type_choice'|'blocking_pattern'|'completion_cluster';
export interface HabitObservationEvidence {
  type:'agent_inference';schema_version:1;signature:string;provider:'claude'|'codex';model:string|null;
  prompt_version:string;analyzed_at:string;timezone:string;rationale:string;
  window_from:string;window_to:string;sample_tasks:number;sample_days:number;
  pattern:ObservationPattern;task_types:TaskType[];preferred_hours:number[];
  evidence:{operation_id:string;task_id:string;action:string;at:string;local_date:string}[];
  counter_evidence_ids:string[];
}
export function observationEvidence(value:unknown):HabitObservationEvidence|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const e=value as HabitObservationEvidence;
  if(e.type!=='agent_inference'||e.schema_version!==1||typeof e.signature!=='string'||
    !['start_hour','task_type_choice','blocking_pattern','completion_cluster'].includes(e.pattern)||
    !Number.isFinite(Date.parse(e.analyzed_at))||!Array.isArray(e.evidence)||e.evidence.length<3||
    !e.evidence.every(v=>v&&typeof v.operation_id==='string'&&typeof v.task_id==='string'&&typeof v.at==='string')||
    e.sample_tasks<3||e.sample_days<2||!Array.isArray(e.task_types)||!Array.isArray(e.preferred_hours)||
    !e.preferred_hours.every(h=>Number.isInteger(h)&&h>=0&&h<=23))return null;
  return e;
}
export function usableObservation(entry:{source:string;source_relation?:unknown;statement:string;confidence?:number|null},at=Date.now()) {
  const e=observationEvidence(entry.source_relation);
  return entry.source==='agent_inference'&&!/^\s*(demo\b|示例[：:])/i.test(entry.statement)&&
    typeof entry.confidence==='number'&&entry.confidence>=0.75&&!!e&&e.pattern!=='task_type_choice'&&
    at>=Date.parse(e.analyzed_at)&&at-Date.parse(e.analyzed_at)<30*86400000;
}
export interface HabitInferenceStatus {
  connected:boolean;paused_reason:string|null;interval_minutes:number;next_run_at:string|null;
  last_attempt_at:string|null;last_saved_at:string|null;last_result:string;saved_count:number;
  last_error:string|null;running:boolean;
}
