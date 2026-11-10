import { describe, expect, test } from 'bun:test';
import { parseCalendarStatus, syncFailingLine } from './calendar';

describe('calendar status', () => {
  test('reads whether the last sync failed', () => {
    const connection = { id: 'c1', provider: 'google', accountEmail: 'robin@example.com', lastSyncAt: 5, upcoming: 2 };
    const status = parseCalendarStatus({ available: { google: true }, connections: [{ ...connection, syncFailing: true }, { ...connection, id: 'c2' }] });
    expect(status?.connections.map((c) => c.syncFailing)).toEqual([true, false]);
  });

  test('says since when the meetings may be out of date', () => {
    const now = 100 * 86_400_000;
    expect(syncFailingLine(null, now)).toBe('Couldn’t sync this calendar yet. Eavesy keeps trying.');
    expect(syncFailingLine(now - 12 * 60_000, now)).toContain('for 12 min,');
    expect(syncFailingLine(now - 5 * 3_600_000, now)).toContain('for 5 h,');
    expect(syncFailingLine(now - 3 * 86_400_000, now)).toContain('for 3 days,');
  });
});
