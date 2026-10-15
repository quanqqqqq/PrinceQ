/** Only exposes the explicitly user-facing SUMMARY preamble, never provider reasoning events. */
export class SummaryPrefixStream {
  private buffered = '';
  private started = false;
  private finished = false;
  private emittedText = false;
  private readonly emit: (delta: string) => void;

  constructor(emit: (delta: string) => void) {
    this.emit = emit;
  }

  push(chunk: string): void {
    if (this.finished || !chunk) return;
    this.buffered += chunk;
    if (!this.started) {
      const marker = /(?:^|\n)SUMMARY:\s*/i.exec(this.buffered);
      if (!marker) {
        if (this.buffered.length > 128) this.buffered = this.buffered.slice(-32);
        return;
      }
      this.buffered = this.buffered.slice((marker.index ?? 0) + marker[0].length);
      this.started = true;
    }

    const boundary = this.buffered.search(/[\r\n{]/);
    const text = boundary < 0 ? this.buffered : this.buffered.slice(0, boundary);
    const delta = this.emittedText ? text : text.replace(/^\s+/, '');
    if (delta) {
      this.emit(delta);
      this.emittedText = true;
    }
    this.buffered = boundary < 0 ? '' : '';
    if (boundary >= 0) this.finished = true;
  }

  finish(): void {
    if (!this.finished && this.started && this.buffered) {
      const delta = this.emittedText ? this.buffered : this.buffered.replace(/^\s+/, '');
      if (delta) this.emit(delta);
    }
    this.buffered = '';
    this.finished = true;
  }
}


/** Decode only public assistant text; ignore provider reasoning and tool events. */
export function createPublicSummaryDecoder(provider:'claude'|'codex',emit:(delta:string)=>void) {
  const summary=new SummaryPrefixStream(emit);
  let pending='';
  const seen=new Map<string,string>();
  const process=(line:string)=>{
    try {
      const outer=JSON.parse(line);
      if(provider==='claude') {
        const event=outer.type==='stream_event'?outer.event:outer;
        if(event?.type==='content_block_delta'&&event.delta?.type==='text_delta'&&typeof event.delta.text==='string')summary.push(event.delta.text);
      } else {
        const item=outer.item;
        if(item?.type!=='agent_message'||typeof item.text!=='string')return;
        const id=String(item.id??'assistant'),previous=seen.get(id)??'';seen.set(id,item.text);
        if(item.text.startsWith(previous))summary.push(item.text.slice(previous.length));
      }
    } catch {/* Transport diagnostics are not public summaries. */}
  };
  return {push(text:string){pending+=text;let end=pending.indexOf('\n');while(end>=0){process(pending.slice(0,end));pending=pending.slice(end+1);end=pending.indexOf('\n');}},finish(){if(pending.trim())process(pending);pending='';summary.finish();}};
}
