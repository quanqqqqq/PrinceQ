import type {AgentProgressPhase,AgentProgressView} from '../../shared/types.ts';
const entries=new Map<string,AgentProgressView>();
const labels:Record<AgentProgressPhase,string>={checking:'正在检查任务 Agent 连接',context:'正在整理当前任务、已采纳产出和本会话资料',calling:'正在调用任务 Agent',response:'Agent 已开始返回公开处理摘要',validation:'正在校验回复与协助产出',complete:'本轮协助完成，产出等待你验收',failed:'本轮协助未完成，可以重试'};
const keyFor=(task:string,key:string)=>JSON.stringify([task,key]);
export function taskProgress(task:string,key:string,phase:AgentProgressPhase):void {
  const id=keyFor(task,key),old=entries.get(id),now=new Date().toISOString();
  entries.set(id,{request_id:key,phase,message:labels[phase],started_at:old?.started_at??now,updated_at:now,summary_text:old?.summary_text});
  if(phase==='complete'||phase==='failed'){const value=entries.get(id);const timer=setTimeout(()=>{if(entries.get(id)===value)entries.delete(id);},120000);timer.unref?.();}
}
export function appendTaskSummary(task:string,key:string,text:string):void {
  const id=keyFor(task,key),old=entries.get(id);if(!old)return;
  entries.set(id,{...old,summary_text:((old.summary_text??'')+text).slice(0,1200),updated_at:new Date().toISOString()});
}
export const readTaskProgress=(task:string,key:string):AgentProgressView|null=>entries.get(keyFor(task,key))??null;
