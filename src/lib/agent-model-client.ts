import type {AgentRuntimeProvider} from '@shared/types';
import {ApiRequestError} from './api';
export interface ModelChoice {id:string;label:string;description:string;source:string;is_default:boolean}
export interface ModelCatalog {provider:AgentRuntimeProvider;cli_path:string|null;supports_model_flag:boolean;models:ModelChoice[];source:string;checked_at:string;access_verified:false;note:string}
export async function getAgentModels(provider:AgentRuntimeProvider,refresh=false):Promise<ModelCatalog> {
  const response=await fetch('/api/agent/models?provider='+provider+(refresh?'&refresh=1':''));
  const body=await response.json();
  if(!response.ok)throw new ApiRequestError(response.status,body.error?.code??'model_catalog_error',body.error?.message??'读取模型选项失败');
  return body;
}
