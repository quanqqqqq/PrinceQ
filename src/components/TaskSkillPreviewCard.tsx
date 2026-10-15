import {Check, X, Pencil, ListChecks, Loader2, CircleAlert} from 'lucide-react';
import type {TaskSkillPreview} from '@shared/task-assistance';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {recurrenceUnitLabels} from '@shared/recurrence';
export function TaskSkillPreviewCard({preview,busy,processing,onConfirm,onCancel,onEdit,onOpenTask}:{preview:TaskSkillPreview;busy:boolean;processing?:string|null;onConfirm:()=>void;onCancel:()=>void;onEdit:()=>void;onOpenTask:(id:string)=>void}) {
  const pending=preview.status==='pending';
  return <section data-preview-token={preview.token} tabIndex={-1} className="mt-3 space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-3 text-xs leading-5">
    <div className="flex flex-wrap items-center gap-2"><ListChecks className="size-4 text-primary"/><h4 className="text-sm font-semibold">修改预览</h4><Badge variant="outline">{preview.status==='confirmed'?'已执行':preview.status==='cancelled'?(preview.replaced_by?'已被新预览替换':'已取消'):preview.stale_reason?'需要重新生成':'待你确认'}</Badge></div>
    <p>{pending?'以下变更尚未执行。请核对后确认，或继续对话调整草稿。':preview.status==='confirmed'?'已执行并读回以下结果。':'这份预览没有执行任务修改。'}</p>
    {preview.changes.map((change,index)=><details key={index} open={pending} className="rounded-md border border-border bg-card p-2">
      <summary className="cursor-pointer font-medium">{index+1}. {change.title} · {change.operation==='task.create'?'新建任务':change.operation==='task.recurrence.update'?'调整循环计划':change.operation==='task.update'?'修改任务':'变更详情'}</summary>
      <div className="mt-2 overflow-auto"><table className="w-full table-fixed text-left text-xs"><thead><tr className="border-b"><th className="w-1/5 p-1">字段</th><th className="w-2/5 p-1">修改前</th><th className="w-2/5 p-1">确认后</th></tr></thead><tbody>{change.fields.map((field,i)=><tr key={i} className="border-b last:border-0"><th className="p-1 align-top font-normal text-muted-foreground">{field.label}</th><td className="whitespace-pre-wrap break-words p-1 align-top text-muted-foreground">{field.before}</td><td className="whitespace-pre-wrap break-words p-1 align-top">{field.after}</td></tr>)}</tbody></table></div>
    </details>)}
    {preview.stale_reason&&pending?<p role="alert" className="flex items-start gap-1 rounded-md bg-amber-50 p-2 text-amber-800"><CircleAlert className="mt-0.5 size-3 shrink-0"/>数据已改变，旧预览不能执行。请取消后根据最新数据重新生成。</p>:null}
    {pending?<div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy||!!preview.stale_reason} onClick={onConfirm}>{processing==='confirm'?<Loader2 className="animate-spin"/>:<Check/>}{processing==='confirm'?'正在执行…':`确认并执行（${preview.changes.length}项）`}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}><Pencil/>调整建议</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{processing==='cancel'?<Loader2 className="animate-spin"/>:<X/>}取消预览</Button>
    </div>:null}
    {preview.result?<div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/60 p-2">
      <p className="font-medium text-emerald-800">执行成功</p>
      {preview.result.tasks.map(task=><div key={task.id} className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1"><p className="break-words font-medium">{task.title}</p>{task.recurrence?<p className="text-muted-foreground">当前每 {task.recurrence.interval} {recurrenceUnitLabels[task.recurrence.unit]} · 计划共 {task.recurrence.total} 次{task.recurrence.plan_changes?.length?` · 已登记 ${task.recurrence.plan_changes.length} 次计划调整`:''}</p>:<p className="text-muted-foreground">{task.estimated_minutes==null?'未估时':`每次预计 ${task.estimated_minutes} 分钟`}</p>}{task.recurrence&&task.estimated_minutes!=null?<p className="text-muted-foreground">每次预计 {task.estimated_minutes} 分钟</p>:null}{task.recurrence?.plan_changes?.at(-1)?<p className="text-primary">{task.recurrence.plan_changes.at(-1)!.effective_from.replace('T',' ')} 起改为每 {task.recurrence.plan_changes.at(-1)!.interval} {recurrenceUnitLabels[task.recurrence.plan_changes.at(-1)!.unit]}</p>:null}</div><Button size="sm" variant="ghost" onClick={()=>onOpenTask(task.id)}>查看任务</Button></div>)}
      {preview.result.notes.length?<details><summary className="cursor-pointer text-muted-foreground">查看执行明细</summary><ul className="list-disc pl-4">{preview.result.notes.map((note,i)=><li key={i} className="whitespace-pre-wrap break-words">{note}</li>)}</ul></details>:null}
    </div>:null}
  </section>;
}
