import type {TaskAssistanceMessage} from '../../shared/task-assistance.ts';
export type TaskChatMessage=TaskAssistanceMessage & {delivery?:'sending'|'failed'};
/** Keep local user messages visible until authoritative history has their request key. */
export function mergeTaskAssistanceMessages(saved:TaskAssistanceMessage[],local:TaskChatMessage[]):TaskChatMessage[] {
  const same=(a:TaskChatMessage,b:TaskChatMessage)=>a.id===b.id||!!(a.role==='user'&&b.role==='user'&&a.request_key&&a.request_key===b.request_key);
  const merged:TaskChatMessage[]=saved.map(message=>{
    const pending=local.find(item=>same(message,item)&&item.delivery);
    return pending?{...message,delivery:pending.delivery}:message;
  });
  for(const message of local)if(!merged.some(item=>same(item,message)))merged.push(message);
  return merged;
}
export function shouldSendTaskMessage(event:{key:string;shiftKey:boolean;isComposing:boolean;keyCode?:number}):boolean {
  return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229;
}

/** Keep a resolved local preview while resource invalidation is fetching its new history. */
export function mergeTaskSkillPreviews(saved:import('../../shared/task-assistance.ts').TaskSkillPreview[],local:import('../../shared/task-assistance.ts').TaskSkillPreview[]):import('../../shared/task-assistance.ts').TaskSkillPreview[] {
  const result=new Map(saved.map(preview=>[preview.token,preview]));
  for(const preview of local){const old=result.get(preview.token);if(!old||((preview.resolved_at??'')>(old.resolved_at??'')))result.set(preview.token,preview);}
  return [...result.values()];
}
