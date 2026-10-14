import type {HabitInferenceStatus} from '@shared/habit-inference';
const failures:Record<string,string>={
  invalid_reply:'Agent 返回格式无效，未保存',agent_unavailable:'Agent 暂不可用，未保存',
  settings_changed:'分析期间设置发生变化，未保存',runtime_changed:'Agent 配置发生变化，未保存',
  context_too_large:'观察上下文过大，未发送',inference_failed:'本次分析未完成，未保存',canceled:'已停止本次分析',
};
export function HabitInferenceNotice({status,error}:{status:HabitInferenceStatus|null;error:string|null}) {
  const next=status?.next_run_at?new Date(status.next_run_at).toLocaleString('zh-CN'):null;
  return <div className="rounded-md bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
    {!status?(error?'暂时无法读取观察状态，推断是否生效以服务端为准。':'正在读取 Agent 观察状态…'):
      !status.connected?'自动观察已暂停：请先连接并启用助手 Agent。推断习惯暂不用于安排或排序。':
      status.running?'Agent 正在分析新的真实执行记录…':
      <><span>Agent 已连接；每小时检查新执行动作，有充分证据才自动保存。</span>{next?<span> 下次检查：{next}。</span>:null}</>}
    {status?.connected&&status.last_result==='insufficient'?<p>上次没有新动作，或样本不足；没有调用模型。</p>:null}
    {status?.connected&&status.last_result==='no_valid_observation'?<p>上次没有发现足够可靠的新规律；没有保存习惯。</p>:null}
    {status?.last_error?<p>{failures[status.last_error]??'上次分析未完成，未保存'}。</p>:null}
    <p>至少 3 个不同任务、跨 2 天的记录才进入分析；保存的是观察建议，采纳后才成为明确偏好。</p>
  </div>;
}
