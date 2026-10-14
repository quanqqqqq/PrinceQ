import {useEffect,useState} from 'react';
import {Loader2,RefreshCw} from 'lucide-react';
import type {AgentRuntimeProvider} from '@shared/types';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {getAgentModels,type ModelCatalog} from '@/lib/agent-model-client';
const DEFAULT='__cli_default__',CUSTOM='__custom__';
export function AgentModelSelector({provider,cliPath,model,refreshKey,onChange}:{provider:AgentRuntimeProvider;cliPath:string;model:string|null|undefined;refreshKey:string;onChange:(model:string|null)=>void}) {
  const [revision,setRevision]=useState(0);
  const requestKey=JSON.stringify([provider,cliPath,refreshKey,revision]);
  const [result,setResult]=useState<{key:string;catalog:ModelCatalog|null;error:string|null}>({key:'',catalog:null,error:null});
  const loading=result.key!==requestKey;
  const catalog=result.catalog?.provider===provider && result.catalog.cli_path===cliPath ? result.catalog : null;
  const error=loading?null:result.error;
  const [custom,setCustom]=useState(false);
  useEffect(()=>{
    let cancelled=false;
    getAgentModels(provider,revision>0).then(value=>{if(!cancelled)setResult({key:requestKey,catalog:value,error:null});}).catch(cause=>{if(!cancelled)setResult({key:requestKey,catalog:null,error:cause instanceof Error?cause.message:'读取模型选项失败'});});
    return()=>{cancelled=true;};
  },[provider,requestKey,revision]);
  const choices=catalog?.cli_path===cliPath?catalog.models:[];
  const listed=Boolean(model&&choices.some(choice=>choice.id===model));
  const manual=custom||Boolean(model&&!listed&&!loading);
  return <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
    <div className="flex items-center justify-between gap-2"><Label htmlFor="agent-model-select">助手模型</Label><Button type="button" variant="ghost" size="sm" disabled={loading} onClick={()=>setRevision(value=>value+1)}>{loading?<Loader2 className="animate-spin"/>:<RefreshCw/>}刷新选项</Button></div>
    <Select value={custom?CUSTOM:!model?DEFAULT:listed?model:CUSTOM} onValueChange={value=>{
      if(value===CUSTOM){setCustom(true);return;}setCustom(false);onChange(value===DEFAULT?null:value);
    }} disabled={!cliPath||loading||catalog?.supports_model_flag===false}>
      <SelectTrigger id="agent-model-select" className="w-full bg-card!"><SelectValue placeholder="读取模型选项…">{loading&&!listed&&model?model:undefined}</SelectValue></SelectTrigger>
      <SelectContent><SelectItem value={DEFAULT}>使用 CLI 默认模型</SelectItem>{choices.map(choice=><SelectItem key={choice.id} value={choice.id}>{choice.label}{choice.is_default?' · CLI 推荐默认':''}</SelectItem>)}<SelectItem value={CUSTOM}>自定义模型标识…</SelectItem></SelectContent>
    </Select>
    {manual?<div className="space-y-1"><Label htmlFor="agent-model">自定义模型标识</Label><Input id="agent-model" value={model??''} onChange={event=>onChange(event.target.value||null)} placeholder="填写当前 CLI 支持的完整模型或部署标识" autoComplete="off" spellCheck={false}/></div>:null}
    <p className="text-xs text-muted-foreground">{error??catalog?.note??'读取模型选项只查询 CLI 元数据，不发起模型对话。'} 选择后自动保存；可用下方「测试连接」验证。</p>
  </div>;
}
