import {useEffect,useRef} from 'react';
import {useResource,useWorkspace} from './use-resource';
import {getInferenceStatus} from '@/lib/settings-client';
import {RUNTIME_CONFIG_CHANGED_EVENT} from '@/lib/agent-runtime-client';
export function useHabitInference(onSaved:()=>void) {
  const status=useResource(['habits'],getInferenceStatus);
  const {invalidate}=useWorkspace();
  const lastSaved=useRef<string|null|undefined>(undefined);
  useEffect(()=>{
    const timer=window.setInterval(status.refetch,60000);
    window.addEventListener(RUNTIME_CONFIG_CHANGED_EVENT,status.refetch);
    return ()=>{window.clearInterval(timer);window.removeEventListener(RUNTIME_CONFIG_CHANGED_EVENT,status.refetch);};
  },[status.refetch]);
  useEffect(()=>{
    const stamp=status.data?.last_saved_at;
    if(stamp===undefined)return;
    if(lastSaved.current!==undefined&&stamp&&stamp!==lastSaved.current) {
      invalidate(['habits','queue','tasks']);onSaved();
    }
    lastSaved.current=stamp;
  },[status.data?.last_saved_at,invalidate,onSaved]);
  return status;
}
