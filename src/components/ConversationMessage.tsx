import type {ReactNode,Ref} from 'react';
import {Info} from 'lucide-react';
import {ConversationAvatar} from '@/components/ConversationAvatar';

/** Shared message presentation for the workspace assistant and task assistance. */
export function ConversationMessage({role,name,status,metadata,busy=false,articleRef,children}:{
  role:'user'|'assistant';
  name:string;
  status?:ReactNode;
  metadata?:ReactNode;
  busy?:boolean;
  articleRef?:Ref<HTMLElement>;
  children:ReactNode;
}) {
  const user=role==='user';
  return <article ref={articleRef} aria-label={user?'你发送的消息':`${name}的回复`} data-message-role={role} className={`flex items-start gap-2 ${user?'flex-row-reverse':'flex-row'}`}>
    <ConversationAvatar role={role} busy={busy}/>
    <div className={`min-w-0 ${user?'max-w-[85%]':'flex-1'}`}>
      <div className={`mb-1.5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground ${user?'justify-end':''}`}><span>{name}</span>{metadata}{status}</div>
      <div className={`rounded-2xl px-3 py-2.5 text-sm leading-6 shadow-sm ${user?'rounded-tr-sm bg-primary text-primary-foreground':'rounded-tl-sm border bg-card'}`}>{children}</div>
    </div>
  </article>;
}

export function ConversationSystemNotice({children}:{children:ReactNode}) {
  return <article aria-label="系统通知" data-message-role="system" className="mx-auto flex w-fit max-w-full items-start gap-2 rounded-lg border border-dashed bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
    <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0"/>
    <div className="min-w-0"><p className="font-medium">系统通知</p>{children}</div>
  </article>;
}
