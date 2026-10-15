import {Loader2} from 'lucide-react';

/** Small vector portraits stay clear in both the docked and task conversations. */
export function ConversationAvatar({role,busy=false}:{role:'user'|'assistant';busy?:boolean}) {
  const user=role==='user';
  return <div aria-hidden="true" data-conversation-avatar={user?'dog':'robot'} className={`relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border ${user?'border-amber-200 bg-amber-50':'border-blue-200 bg-blue-50'}`}>
    <svg viewBox="0 0 32 32" fill="none" className="size-7">
      {user?<>
        <path d="M10 8C5 5 1 10 3 17C3.8 20 6 20 8 17L11 12ZM22 8C27 5 31 10 29 17C28.2 20 26 20 24 17L21 12Z" fill="#B87847"/>
        <path d="M6 17C6 10 10 7 16 7S26 10 26 17C26 24 22 28 16 28S6 24 6 17Z" fill="#F3D5A4"/>
        <path d="M13 8C14 7 18 7 19 8L18 18H14Z" fill="#FFF5E3"/>
        <ellipse cx="16" cy="22" rx="6" ry="4.5" fill="#FFF8EC"/>
        <ellipse cx="11.5" cy="16.5" rx="1.6" ry="2" fill="#473126"/><ellipse cx="20.5" cy="16.5" rx="1.6" ry="2" fill="#473126"/>
        <circle cx="12" cy="15.9" r=".5" fill="white"/><circle cx="21" cy="15.9" r=".5" fill="white"/>
        <ellipse cx="9" cy="20" rx="2" ry="1.2" fill="#EBA6A0"/><ellipse cx="23" cy="20" rx="2" ry="1.2" fill="#EBA6A0"/>
        <path d="M13.5 20.5C13.5 19 18.5 19 18.5 20.5C18.5 21.5 17 22.5 16 22.5S13.5 21.5 13.5 20.5Z" fill="#473126"/>
        <path d="M14.4 24H17.6V25.2C17.6 27.5 14.4 27.5 14.4 25.2Z" fill="#E88999"/>
        <path d="M16 22V23C15 24.5 13.5 24 13 23.5M16 23C17 24.5 18.5 24 19 23.5" stroke="#473126" strokeWidth="1.1" strokeLinecap="round"/>
      </>:<>
        <path d="M16 6V10" stroke="#5082CF" strokeWidth="2" strokeLinecap="round"/><circle cx="16" cy="5" r="2" fill="#75A4ED"/>
        <rect x="2" y="15" width="4" height="7" rx="2" fill="#75A4ED"/><rect x="26" y="15" width="4" height="7" rx="2" fill="#75A4ED"/>
        <rect x="5.5" y="9.5" width="21" height="18" rx="6" fill="#DCEBFF" stroke="#5082CF" strokeWidth="1.5"/>
        <rect x="8.5" y="13" width="15" height="10" rx="4" fill="#F8FBFF"/>
        <rect x="11" y="16" width="3" height="4" rx="1.5" fill="#365D96"/><rect x="18" y="16" width="3" height="4" rx="1.5" fill="#365D96"/>
        <path d="M13 23.5C14.5 25 17.5 25 19 23.5" stroke="#5082CF" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="9" cy="22" r="1" fill="#9EC4F4"/><circle cx="23" cy="22" r="1" fill="#9EC4F4"/>
      </>}
    </svg>
    {busy&&!user?<span className="absolute -right-0.5 -bottom-0.5 rounded-full bg-card p-0.5 text-primary"><Loader2 className="size-2.5 animate-spin"/></span>:null}
  </div>;
}
