/** Calendar recurrence. Keys are dates, or local date-times for hourly schedules. */
export type RecurrenceUnit='hour'|'day'|'week'|'month';
export interface RecurrenceInput {
  start_date:string;
  start_time?:string;
  interval:number;
  unit:RecurrenceUnit;
  timezone:string;
  end_mode:'goal'|'date';
  end_date?:string|null;
}
export interface TaskOccurrence {
  date:string;
  out_of_schedule?:boolean;
  status:'pending'|'in_progress'|'completed'|'skipped'|'missed'|'scheduled'|'paused';
  opened_at:string|null;
  completed_at:string|null;
  note:string;
  version:number;
}
export interface TaskRecurrence extends RecurrenceInput {
  status:'active'|'paused'|'ended';
  series_start_date?:string;
  plan_changes?:Array<RecurrenceInput & {effective_from:string}>;
  effective_end_date:string|null;
  today:string;
  today_occurrence:TaskOccurrence|null;
  next_date:string|null;
  total:number;paused:number;completed:number;skipped:number;missed:number;opened:number;opened_days:number;
  occurrences:TaskOccurrence[];
  version:number;
}
export const recurrenceUnitLabels:Record<RecurrenceUnit,string>={hour:'小时',day:'天',week:'周',month:'月'};
export const calendarDate=(instant:string|Date,timezone:string):string=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(instant));
export function localMinute(instant:string|Date,timezone:string):string {
  const date=new Date(instant);
  const time=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date);
  return calendarDate(date,timezone)+'T'+time;
}
export const dayNumber=(date:string):number=>Date.parse(date+'T00:00:00Z')/86400000;
export const addDays=(date:string,days:number):string=>new Date((dayNumber(date)+days)*86400000).toISOString().slice(0,10);
/** Monthly dates always derive from the original anchor (Jan 31 -> Feb 28 -> Mar 31). */
export function recurrenceKey(input:RecurrenceInput,index:number):string {
  const offset=input.interval*index;
  if(input.unit==='hour')return new Date(Date.parse(input.start_date+'T'+(input.start_time??'09:00')+':00Z')+offset*3600000).toISOString().slice(0,16);
  if(input.unit==='month') {
    const anchor=new Date(input.start_date+'T00:00:00Z');
    const first=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth()+offset,1));
    const lastDay=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
    first.setUTCDate(Math.min(anchor.getUTCDate(),lastDay));
    return first.toISOString().slice(0,10);
  }
  return addDays(input.start_date,offset*(input.unit==='week'?7:1));
}
export const occurrenceLabels:Record<TaskOccurrence['status'],string>={pending:'待打开',in_progress:'进行中',completed:'已完成',skipped:'已跳过',missed:'未完成',scheduled:'未到时间',paused:'循环暂停'};
export function recurrenceDue(recurrence?:TaskRecurrence|null):boolean {
  return !recurrence||(recurrence.status==='active'&&!!recurrence.today_occurrence&&['pending','in_progress'].includes(recurrence.today_occurrence.status));
}
