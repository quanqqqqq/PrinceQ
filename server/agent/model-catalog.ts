/** Read CLI model metadata only; never starts a thread, turn, login or inference. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveCliLaunch, terminateProcessTree, trackRuntimeProcess} from '../lib/process-launch.ts';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {runCli,buildCliEnv} from './cli-exec.ts';
import {detectCli} from './detect.ts';
import type {AgentRuntimeConfig,AgentRuntimeProvider} from '../../shared/types.ts';
export interface ModelChoice {id:string;label:string;description:string;source:'cli_rpc'|'cli_help'|'cli_cache'|'configured'|'environment';is_default:boolean}
export interface ModelCatalog {provider:AgentRuntimeProvider;cli_path:string|null;supports_model_flag:boolean;models:ModelChoice[];source:string;checked_at:string;access_verified:false;note:string}
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,119}$/;
const validId=(id:unknown):id is string=>typeof id==='string'&&idPattern.test(id)&&!id.startsWith('sk-');
export function parseClaudeModelHelp(help:string):ModelChoice[] {
  const block=help.match(/--model\s+<[^>]+>([\s\S]*?)(?=\n\s{2}--|\n\s{2}-[a-z]|$)/)?.[1]??'';
  const labels:Record<string,string>={fable:'Fable',opus:'Opus',sonnet:'Sonnet',haiku:'Haiku',best:'Best',opusplan:'Opus Plan','sonnet[1m]':'Sonnet (1M)','opus[1m]':'Opus (1M)'};
  return [...new Set([...block.matchAll(/['"]([^'"]+)['"]/g)].map(match=>match[1]))].filter(id=>id in labels).map(id=>({id,label:labels[id],description:'CLI 支持的模型别名，具体版本由本机配置映射',source:'cli_help',is_default:false}));
}
export function normalizeCodexModels(items:unknown,source:'cli_rpc'|'cli_cache'='cli_rpc'):ModelChoice[] {
  if(!Array.isArray(items))return [];
  return items.flatMap(item=>{
    if(!item||typeof item!=='object')return [];
    const id=item.model??item.slug??item.id;
    if(!validId(id)||item.hidden===true||(typeof item.visibility==='string'&&item.visibility!=='list'))return [];
    return [{id,label:String(item.displayName??item.display_name??id).slice(0,160),description:String(item.description??'').slice(0,300),source,is_default:item.isDefault===true||item.is_default===true}];
  }).filter((item,index,all)=>all.findIndex(other=>other.id===item.id)===index);
}
/** Config flags used by inference also apply to metadata; fixed isolation options win last. */
function configArgs(args:string[]):string[] {
  const result:string[]=[];
  for(let i=0;i<args.length;i++) {
    if((args[i]==='--config'||args[i]==='-c')&&args[i+1]) {result.push('--config',args[++i]);}
    else if(args[i].startsWith('--config='))result.push('--config',args[i].slice(9));
  }
  return result;
}
export function readCodexModelRpc(cfg:AgentRuntimeConfig):Promise<ModelChoice[]> {
  return new Promise((resolve,reject)=>{
    let launch;
    try {launch=resolveCliLaunch(cfg.cli_path,['app-server','--listen','stdio://',...configArgs(cfg.args),'--config','features.apps=false','--config','mcp_servers={}','--config','plugins={}']);}
    catch(error){reject(error);return;}
    const child=trackRuntimeProcess(spawn(launch.executable,launch.args,{detached:process.platform!=='win32',windowsHide:true,shell:false,cwd:cfg.working_directory,env:buildCliEnv(cfg.allowed_env_names,'codex'),stdio:['pipe','pipe','ignore']}));
    const decoder=new StringDecoder('utf8');
    let finished=false,buffer='',bytes=0,id=2,pages=0;const entries:unknown[]=[];
    const timer=setTimeout(()=>finish(new Error('model_catalog_timeout')),12000);
    let killer:NodeJS.Timeout|undefined;
    function finish(error?:Error) {
      if(finished)return;finished=true;clearTimeout(timer);
      child.stdin.end();terminateProcessTree(child,'SIGTERM');killer=setTimeout(()=>terminateProcessTree(child,'SIGKILL'),1500);killer.unref();
      if(error)reject(error);else resolve(normalizeCodexModels(entries));
    }
    const send=(message:unknown)=>{if(!finished)child.stdin.write(JSON.stringify(message)+'\n');};
    child.stdin.on('error',()=>finish(new Error('model_catalog_pipe_failed')));
    child.on('error',()=>finish(new Error('model_catalog_spawn_failed')));
    child.on('close',()=>{if(killer)clearTimeout(killer);if(!finished)finish(new Error('model_catalog_closed'));});
    child.stdout.on('data',(chunk:Buffer)=>{
      bytes+=chunk.length;if(bytes>2*1024*1024)return finish(new Error('model_catalog_too_large'));
      buffer+=decoder.write(chunk);
      let newline:number;
      while(!finished&&(newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let message:any;try{message=JSON.parse(line);}catch{continue;}
        if(message.id===1) {
          if(message.error)return finish(new Error('model_catalog_initialization_failed'));
          send({method:'initialized',params:{}});send({id,method:'model/list',params:{limit:100,includeHidden:false}});
        } else if(message.id===id) {
          if(message.error)return finish(new Error('model_catalog_rpc_failed'));
          const result=message.result??{};if(Array.isArray(result.data))entries.push(...result.data);
          if(result.nextCursor && ++pages<10){id++;send({id,method:'model/list',params:{limit:100,includeHidden:false,cursor:result.nextCursor}});}
          else finish();
        }
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'princeq',title:'PrinceQ',version:'0.1.0'}}});
  });
}
const cache=new Map<string,{until:number;value:ModelCatalog}>();
export async function discoverRuntimeModels(original:AgentRuntimeConfig,provider=original.provider,force=false):Promise<ModelCatalog> {
  let cfg={...original,provider};
  if(provider!==original.provider||!cfg.cli_path) {
    const detected=await detectCli({provider});
    const candidate=detected.candidates.find(item=>item.provider===provider&&item.exists&&item.exit_code===0);
    cfg={...cfg,cli_path:candidate?.path??'',model:null,args:[]};
  }
  const key=JSON.stringify({provider,path:cfg.cli_path,args:cfg.args,env:cfg.allowed_env_names,model:cfg.model});
  const old=cache.get(key);if(!force&&old&&old.until>Date.now())return old.value;
  const value:ModelCatalog={provider,cli_path:cfg.cli_path||null,supports_model_flag:false,models:[],source:'unavailable',checked_at:new Date().toISOString(),access_verified:false,note:'选择 CLI 后可读取模型选项。'};
  if(!cfg.cli_path)return value;
  const help=await runCli({executable:cfg.cli_path,args:['--help'],cwd:cfg.working_directory,envNames:cfg.allowed_env_names,timeoutMs:5000,maxOutputBytes:128*1024,provider});
  value.supports_model_flag=help.exitCode===0&&/--model\b/.test(help.stdout);
  if(value.supports_model_flag) {
    if(provider==='codex') {
      try {value.models=await readCodexModelRpc(cfg);value.source='cli_rpc';}
      catch {
        try {const file=path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'models_cache.json');if(fs.statSync(file).size<4*1024*1024)value.models=normalizeCodexModels(JSON.parse(fs.readFileSync(file,'utf8')).models,'cli_cache');value.source=value.models.length?'cli_cache':'unavailable';}catch{/* no cached catalog */}
      }
      value.note=value.source==='cli_rpc'?'来自当前 Codex CLI 的模型目录；实际账号是否可用以连接测试为准。':value.source==='cli_cache'?'当前使用本机缓存目录，可刷新；实际可用性以连接测试为准。':'CLI 没有返回模型清单，可保留默认或填写自定义模型。';
    } else {
      value.models=parseClaudeModelHelp(help.stdout);value.source='cli_help';
      for(const name of ['ANTHROPIC_MODEL','ANTHROPIC_CUSTOM_MODEL_OPTION','ANTHROPIC_DEFAULT_FABLE_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
        const id=process.env[name];if(cfg.allowed_env_names.includes(name)&&validId(id)&&!value.models.some(item=>item.id===id))value.models.push({id,label:id,description:'当前 CLI 继承的模型配置',source:'environment',is_default:false});
      }
      value.note='这些是本机 CLI 公布的模型别名，具体版本与访问权限由本机配置及账号决定；自定义部署可填写模型标识。';
    }
    if(validId(cfg.model)&&!value.models.some(item=>item.id===cfg.model))value.models.unshift({id:cfg.model,label:cfg.model,description:'当前 PrinceQ 配置，尚未验证本次模型访问权限',source:'configured',is_default:false});
  } else value.note='该 CLI 未在帮助中声明 --model，继续使用 CLI 默认模型。';
  cache.set(key,{until:Date.now()+60000,value});if(cache.size>12)cache.delete(cache.keys().next().value!);return value;
}
