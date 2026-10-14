import fs from 'node:fs';
import {readRuntimeConfig,type AgentRuntimeConfig} from './runtime-config.ts';
import {connectionFor} from './provider-connections.ts';
export function inferenceConnection(cfg?:AgentRuntimeConfig) {
  try {
    cfg??=readRuntimeConfig();
    if(!cfg.enabled)return {connected:false,reason:'not_enabled'};
    if(!cfg.cli_path||!fs.statSync(cfg.cli_path).isFile())return {connected:false,reason:'cli_unavailable'};
    fs.accessSync(cfg.cli_path,fs.constants.X_OK);
    if(connectionFor(cfg)?.ok!==true)return {connected:false,reason:'connection_not_verified'};
    return {connected:true,reason:null};
  }catch{return {connected:false,reason:'runtime_unavailable'};}
}
export function inferenceTimezone():string {
  const zone=process.env.PWQ_TIME_ZONE??Intl.DateTimeFormat().resolvedOptions().timeZone;
  try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();return zone;}catch{return 'Asia/Shanghai';}
}
export function localObservationTime(at:string|Date) {
  const date=new Date(at),timeZone=inferenceTimezone();
  return {date:new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date),
    hour:Number(new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',hourCycle:'h23'}).format(date))};
}
