import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The sheet that opens from the HUD bar: what is being heard while recording,
 * then the words or the screenshot that were just captured, with what to do
 * next. It reports the height it needs so the window can make room for it.
 */
export function HudSheet({ onHeight, follow, children, footer }: {
  onHeight: (height: number) => void;
  /** Keeps the newest words in view as they arrive. */
  follow?: unknown;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;

  useLayoutEffect(() => {
    const sheet = content.current;
    if (!sheet) return;
    const measure = () => report.current(Math.ceil(sheet.getBoundingClientRect().height) + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && follow !== undefined) el.scrollTop = el.scrollHeight;
  }, [follow]);

  return (
    <div ref={scroller} className="ctl-sheet" aria-live="polite">
      <div ref={content} className="ctl-sheet-content">
        {children}
        {footer && <div className="ctl-sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
