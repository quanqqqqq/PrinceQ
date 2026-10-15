import {createContext,useContext} from 'react';
export interface TaskExecutionControls {openTask:(id:string,mode?:'assistant'|'recurrence')=>void}
export const TaskExecutionContext=createContext<TaskExecutionControls|null>(null);
export function useTaskExecution():TaskExecutionControls {
  const context=useContext(TaskExecutionContext);if(!context)throw new Error('Task execution requires TaskExecutionProvider');return context;
}
