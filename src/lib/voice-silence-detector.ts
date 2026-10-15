/** Detect one second of quiet after sustained sound, using microphone PCM. */
export class VoiceSilenceDetector {
  private heardSound=false;
  private soundMs=0;
  private silentMs=0;
  private finished=false;

  process(samples:Float32Array,sampleRate:number):boolean {
    if(this.finished || samples.length===0 || sampleRate<=0)return false;
    // Short windows keep a brief click from marking a whole audio buffer as
    // speech, and avoid counting quiet portions of a buffer as ongoing sound.
    const frameSize=Math.max(1,Math.round(sampleRate*0.02));
    for(let offset=0;offset<samples.length;offset+=frameSize){
      const end=Math.min(samples.length,offset+frameSize);
      let energy=0;
      for(let index=offset;index<end;index++)energy+=samples[index]*samples[index];
      const durationMs=(end-offset)*1000/sampleRate;
      const rms=Math.sqrt(energy/(end-offset));
      if(rms>=0.01){
        this.silentMs=0;
        this.soundMs+=durationMs;
        if(this.soundMs>=80-1e-7)this.heardSound=true;
      }else{
        this.soundMs=0;
        if(!this.heardSound)continue;
        this.silentMs+=durationMs;
        if(this.silentMs>=1000-1e-7){
          this.finished=true;
          return true;
        }
      }
    }
    return false;
  }
}
