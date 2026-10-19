import { useEffect, useRef } from 'react';

/**
 * The running transcript under the HUD bar: what has been heard so far while
 * recording, then the final words (or what happened to them) for a moment
 * after. Kept to a few lines and scrolled to the newest words.
 */
export function HudTranscript({ text, notice, hint }: { text: string; notice: string | null; hint: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, notice]);
  return (
    <div ref={box} className="ctl-transcript" aria-live="polite">
      {notice && <p className="ctl-transcript-notice">{notice}</p>}
      {text ? <p>{text}</p> : hint && <p className="ctl-transcript-hint">{hint}</p>}
    </div>
  );
}
