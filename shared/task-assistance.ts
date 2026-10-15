export interface TaskAssistanceMessage {id:string;role:'user'|'assistant';content:string;preview_token?:string|null;operation_result?:boolean;request_key?:string;summary?:string[];created_at:string}
export interface TaskAssistanceSession {
  id:string;task_id:string;artifact:string;revision:number;accepted_at:string|null;
  artifact_task_version:number|null;artifact_date:string|null;ready:boolean;
  created_at:string;updated_at:string;
}
export interface TaskAssistanceDetail {session:TaskAssistanceSession|null;messages:TaskAssistanceMessage[];busy:boolean;progress?:import('./types.ts').AgentProgressView|null;previews?:TaskSkillPreview[];skill?:{name:string;version:number}}
export interface TaskSkillChange {operation:string;title:string;description:string;fields:{label:string;before:string;after:string}[]}
export interface TaskSkillPreview {
  token:string;status:'pending'|'confirmed'|'cancelled';summary:string;created_at:string;resolved_at:string|null;
  changes:TaskSkillChange[];stale_reason?:string;replaced_by?:string|null;
  result:{summary:string;notes:string[];createdTaskIds:string[];tasks:{id:string;title:string;status:string;description:string|null;estimated_minutes:number|null;recurrence?:import('./recurrence.ts').TaskRecurrence|null}[]}|null;
}
