import {useCallback,useMemo,useState,type ReactNode} from 'react';
import {TaskExecutionContext} from '@/hooks/task-execution-context';
import {TaskExecutionDialog} from '@/components/TaskExecutionLauncher';
/** Keep the conversation alive when task lists refresh, reorder, or filter after a confirmed mutation. */
export function TaskExecutionProvider({children}:{children:ReactNode}) {
  const [selection,setSelection]=useState<{id:string;mode:'assistant'|'recurrence'}|null>(null);
  const openTask=useCallback((id:string,mode:'assistant'|'recurrence'='assistant')=>setSelection({id,mode}),[]);
  const value=useMemo(()=>({openTask}),[openTask]);
  return <TaskExecutionContext.Provider value={value}>{children}<TaskExecutionDialog key={selection?selection.id+':'+selection.mode:'closed'} taskId={selection?.id??null} mode={selection?.mode??'assistant'} onClose={()=>setSelection(null)}/></TaskExecutionContext.Provider>;
}
