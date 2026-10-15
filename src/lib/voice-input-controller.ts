import {VoiceSilenceDetector} from './voice-silence-detector.ts';
import {captureToWav,microphoneErrorMessage,releaseVoiceCapture,type VoiceCapture} from './voice-capture.ts';
import {claimVoiceInput,releaseVoiceInput} from './voice-input-ownership.ts';
export interface VoiceInputState {phase:'idle'|'starting'|'recording'|'recognizing'|'refining';status:string}
interface Dependencies {
  scope?:string;
  prepare?:(signal:AbortSignal)=>Promise<void>;
  getMedia:()=>Promise<MediaStream>;
  createContext:()=>AudioContext;
  transcribe:(wav:Blob,signal:AbortSignal)=>Promise<string>;
  onTranscript:(text:string)=>void;
}
/** Each instance belongs to one conversation; cancellation invalidates all late callbacks. */
export class VoiceInputController {
  private state:VoiceInputState={phase:'idle',status:''};
  private listeners=new Set<()=>void>();
  private generation=0;
  private capture:VoiceCapture|null=null;
  private controller:AbortController|null=null;
  private owner=Symbol('task-voice');
  private readonly deps:Dependencies;
  constructor(deps:Dependencies){this.deps=deps;this.owner=Symbol(deps.scope??'task-voice');}
  getSnapshot=():VoiceInputState=>this.state;
  subscribe=(listener:()=>void):(()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private update(phase:VoiceInputState['phase'],status:string){this.state={phase,status};for(const listener of this.listeners)listener();}
  cancel=(status=''):void=>{
    this.generation++;this.controller?.abort();this.controller=null;
    const capture=this.capture;this.capture=null;if(capture)releaseVoiceCapture(capture);
    releaseVoiceInput(this.owner);this.update('idle',status);
  };
  async toggle():Promise<void> {
    if(this.state.phase==='recording'){await this.finish();return;}
    if(this.state.phase!=='idle'){this.cancel('已断开本次识别，文字已保留，可以重新录音。');return;}
    claimVoiceInput(this.owner,()=>this.cancel('已切换到另一处语音输入，当前识别已取消。'));
    const generation=++this.generation,controller=new AbortController();this.controller=controller;
    const current=()=>generation===this.generation&&!controller.signal.aborted;
    this.update('starting','正在检查语音环境并准备麦克风，再次点击可取消。');
    let stream:MediaStream|undefined,context:AudioContext|undefined;
    try {
      await this.deps.prepare?.(controller.signal);
      if(!current())return;
      stream=await this.deps.getMedia();
      if(!current()){stream.getTracks().forEach(track=>track.stop());return;}
      context=this.deps.createContext();
      const source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),sink=context.createGain();sink.gain.value=0;
      const capture:VoiceCapture={controller,stream,context,source,processor,sink,sampleRate:context.sampleRate,chunks:[],partialBusy:false,partialTimer:null,partialRequest:null,partialSampleCount:0,lastTranscript:'',silenceDetector:new VoiceSilenceDetector()};
      this.capture=capture;
      processor.onaudioprocess=event=>{
        if(!current()||this.capture!==capture)return;
        const samples=new Float32Array(event.inputBuffer.getChannelData(0));capture.chunks.push(samples);
        if(capture.chunks.length*capture.chunks[0].length/capture.sampleRate>=120){void this.finish();return;}
        if(capture.silenceDetector.process(samples,capture.sampleRate))void this.finish(true);
      };
      source.connect(processor);processor.connect(sink);sink.connect(context.destination);await context.resume();
      if(!current()||this.capture!==capture)return;
      capture.partialTimer=window.setInterval(()=>{
        if(!current()||this.capture!==capture||capture.partialBusy||!capture.chunks.length)return;
        capture.partialBusy=true;capture.partialSampleCount=capture.chunks.reduce((sum,chunk)=>sum+chunk.length,0);
        capture.partialRequest=this.deps.transcribe(captureToWav(capture),controller.signal);
        void capture.partialRequest.then(text=>{
          if(!current()||this.capture!==capture)return;
          if(text.trim()){capture.lastTranscript=text.trim();this.deps.onTranscript(text.trim());this.update('recording','正在录音，识别文字已更新；说话后静音 1 秒自动结束。');}
        }).catch(()=>{if(current()&&this.capture===capture)this.update('recording','本段暂未识别，可继续说话或手动结束。');}).finally(()=>{capture.partialBusy=false;});
      },1800);
      this.update('recording','正在录音；说话后静音 1 秒自动关麦，文字需检查后手动发送。');
    } catch(error) {
      const wasCurrent=current();
      const capture=this.capture;if(capture?.controller===controller){this.capture=null;releaseVoiceCapture(capture);}
      stream?.getTracks().forEach(track=>track.stop());if(context)void context.close().catch(()=>{});
      if(wasCurrent){this.controller=null;releaseVoiceInput(this.owner);this.update('idle','语音输入无法启动：'+microphoneErrorMessage(error));}
    }
  }
  async finish(automatic=false):Promise<void> {
    const capture=this.capture;if(!capture)return;
    this.capture=null;releaseVoiceCapture(capture,false);
    const generation=this.generation,controller=capture.controller;
    const current=()=>generation===this.generation&&!controller.signal.aborted;
    let preview=capture.lastTranscript;
    const prefix=automatic?'连续静音 1 秒，麦克风已自动关闭。':'录音已结束。';
    const show=(text:string)=>{if(!current())return;preview=text;this.deps.onTranscript(text);this.update('refining',prefix+'文字可编辑并手动发送；正在后台补全。');};
    if(preview)show(preview);else this.update('recognizing',prefix+'正在识别，再次点击可断开。');
    let timer:ReturnType<typeof setTimeout>;
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new DOMException('识别等待超时','TimeoutError')),preview?15000:90000);};arm();
    try {
      let text='';if(capture.partialRequest){try{text=(await capture.partialRequest).trim();}catch{controller.signal.throwIfAborted();}if(!current())return;}
      const count=capture.chunks.reduce((sum,chunk)=>sum+chunk.length,0);
      if(!text||capture.partialSampleCount!==count){if(text){show(text);arm();}text=(await this.deps.transcribe(captureToWav(capture),controller.signal)).trim();}
      if(!current())return;if(!text)throw new Error('没有识别到语音，请再试一次。');
      this.deps.onTranscript(text);this.update('idle',prefix+'语音已识别，文本可编辑；检查后手动发送。');
    } catch(error) {
      if(generation===this.generation){const message=controller.signal.reason?.name==='TimeoutError'?'识别等待超时':error instanceof Error?error.message:'识别失败';this.update('idle',message+(preview?'；已保留实时识别文字，可手动发送。':'；可以重新录音。'));}
    } finally {clearTimeout(timer!);if(this.controller===controller){this.controller=null;releaseVoiceInput(this.owner);}}
  }
}
