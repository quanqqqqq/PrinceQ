/** Replace this single hook with token / scope checks when authentication is introduced. */
import type {RequestContext} from '../http/router.ts';
import {DEFAULT_ACTOR_ID} from '../config.ts';
export type PrinceQPermission = 'read' | 'preview' | 'confirm' | 'cancel';
export interface PrinceQPrincipal {actorId:string; authenticated:boolean; callerLabel:string; permission:PrinceQPermission}
export function authorizePrinceQRequest(ctx:RequestContext,permission:PrinceQPermission):PrinceQPrincipal {
  // Phase 1 deliberately accepts local agents without credentials. The caller label is metadata, not identity.
  const raw=ctx.req.headers['x-princeq-agent'];
  return {actorId:DEFAULT_ACTOR_ID,authenticated:false,callerLabel:(typeof raw==='string'?raw:'external-agent').slice(0,120),permission};
}
