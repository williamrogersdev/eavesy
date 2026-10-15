import { useMemo } from 'react';
import { score } from '@/lib/launcher/filter';
import type { Recording } from '@/lib/launcher/types';
import { type Command, type Item, type RecordingRow } from './types';

export function useLauncherItems(commands: Command[], recordings: Recording[], query: string) {
  return useMemo(() => {
    const q = query.trim();
    const cmds = (q ? commands : [])
      .map((c) => ({ c, s: score(q, c.title, c.keywords) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c as Item);

    const recs = recordings
      .map((rec) => ({
        rec,
        s: score(q, rec.title, `${rec.summary ?? ''} ${rec.transcript ?? ''}`),
      }))
      .filter((x) => x.s >= 0)
      .sort((a, b) =>
        b.s === a.s ? b.rec.startedAt - a.rec.startedAt : b.s - a.s,
      )
      .map((x): RecordingRow => ({ kind: 'recording', id: x.rec.id, rec: x.rec }));

    return { items: [...cmds, ...recs], commandCount: cmds.length };
  }, [commands, recordings, query]);
}
