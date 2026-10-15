import { useEffect, useState } from 'react';

/** Reveal both streamed chunks and complete summaries one character at a time. */
export function AgentSummary({ text, generating = false }: { text: string; generating?: boolean }) {
  const [visible, setVisible] = useState('');

  useEffect(() => {
    if (visible === text) return;
    const timer = window.setTimeout(() => {
      setVisible(previous => {
        const prefix = text.startsWith(previous) ? previous : '';
        const nextCharacter = Array.from(text.slice(prefix.length))[0] ?? '';
        return prefix + nextCharacter;
      });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [text, visible]);

  const loading = generating || visible !== text;
  return (
    <p aria-label={text} aria-busy={loading} className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
      {visible}
      {loading ? <span aria-hidden="true" className="agent-loading-dots ml-1 text-muted-foreground">...</span> : null}
    </p>
  );
}
