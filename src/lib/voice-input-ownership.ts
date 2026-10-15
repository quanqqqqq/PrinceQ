/** One active microphone/ASR owner across global Agent and task conversations. */
let owner:{id:symbol;cancel:()=>void}|null=null;
const starts=new Set<()=>void>();
export function claimVoiceInput(id:symbol,cancel:()=>void):void {
  if(owner&&owner.id!==id)owner.cancel();
  for(const listener of starts)listener();
  owner={id,cancel};
}
export function releaseVoiceInput(id:symbol):void {if(owner?.id===id)owner=null;}
export function onVoiceInputStart(listener:()=>void):()=>void {starts.add(listener);return()=>{starts.delete(listener);};}
