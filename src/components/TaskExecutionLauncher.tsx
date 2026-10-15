import {lazy,Suspense} from 'react';
const ExecutionDialog=lazy(()=>import('@/components/TaskExecutionDialog').then(module=>({default:module.TaskExecutionDialog})));
/** Load the conversation renderer only when a task's collaboration panel is opened. */
export function TaskExecutionDialog(props:{taskId:string|null;mode:'assistant'|'recurrence';onClose:()=>void}) {
  if(!props.taskId)return null;
  return <Suspense fallback={<span role="status" className="text-xs text-muted-foreground">正在打开任务协作…</span>}><ExecutionDialog {...props}/></Suspense>;
}
