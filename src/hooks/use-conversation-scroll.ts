import {useLayoutEffect,useRef,type RefObject} from 'react';
/** Follow content growth until the user deliberately scrolls upward. */
export function useConversationScroll(contentRef:RefObject<HTMLElement|null>,endRef:RefObject<HTMLElement|null>,active:boolean,conversation:string,lastMessage:string|undefined,sending:boolean) {
  const following=useRef(true),previousSending=useRef(false),scrollCurrent=useRef<()=>void>(()=>{});
  useLayoutEffect(()=>{
    if(!active)return;
    const content=contentRef.current,viewport=endRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if(!content||!viewport)return;
    following.current=true;
    let dragging=false,touchY:number|null=null;
    const atBottom=()=>viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<=4;
    const scroll=()=>{if(following.current&&viewport.clientHeight>0)viewport.scrollTop=viewport.scrollHeight;};
    // Layout changes and browser scroll anchoring also emit scroll events.
    // Only an actual navigation gesture may turn following off.
    const onScroll=()=>{if(atBottom())following.current=true;else if(dragging)following.current=false;};
    const onWheel=(event:WheelEvent)=>{if(event.deltaY<0)following.current=false;};
    const onKey=(event:KeyboardEvent)=>{if(['ArrowUp','PageUp','Home'].includes(event.key))following.current=false;};
    const onTouchStart=(event:TouchEvent)=>{touchY=event.touches[0]?.clientY??null;};
    const onTouchMove=(event:TouchEvent)=>{const y=event.touches[0]?.clientY;if(touchY!==null&&y!==undefined&&y>touchY)following.current=false;touchY=y??null;};
    const root=viewport.closest<HTMLElement>('[data-slot="scroll-area"]');
    const onPointer=(event:PointerEvent)=>{if((event.target as Element).closest('[data-slot="scroll-area-scrollbar"]')){dragging=true;following.current=false;}};
    const onPointerUp=()=>{if(dragging){dragging=false;following.current=atBottom();}};
    scrollCurrent.current=scroll;
    scroll();const frame=requestAnimationFrame(scroll),observer=new ResizeObserver(scroll);
    observer.observe(content);observer.observe(viewport);
    viewport.addEventListener('scroll',onScroll,{passive:true});viewport.addEventListener('wheel',onWheel,{passive:true});viewport.addEventListener('keydown',onKey);
    viewport.addEventListener('touchstart',onTouchStart,{passive:true});viewport.addEventListener('touchmove',onTouchMove,{passive:true});root?.addEventListener('pointerdown',onPointer);window.addEventListener('pointerup',onPointerUp);
    return()=>{scrollCurrent.current=()=>{};cancelAnimationFrame(frame);observer.disconnect();viewport.removeEventListener('scroll',onScroll);viewport.removeEventListener('wheel',onWheel);viewport.removeEventListener('keydown',onKey);viewport.removeEventListener('touchstart',onTouchStart);viewport.removeEventListener('touchmove',onTouchMove);root?.removeEventListener('pointerdown',onPointer);window.removeEventListener('pointerup',onPointerUp);};
  },[contentRef,endRef,active,conversation]);
  useLayoutEffect(()=>{
    if(sending&&!previousSending.current)following.current=true;
    previousSending.current=sending;
    if(active)scrollCurrent.current();
  },[active,conversation,lastMessage,sending]);
  return ()=>{following.current=false;};
}
