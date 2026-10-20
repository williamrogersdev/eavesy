import { createFileRoute } from '@tanstack/react-router';
import JSZip from 'jszip';
import { getDb } from '@/db/client';
import * as dictionaryRepo from '@/db/repo/dictionary';
import * as capturesRepo from '@/db/repo/captures';
import * as dictationsRepo from '@/db/repo/dictations';
import * as meetingsRepo from '@/db/repo/meetings';
import * as templatesRepo from '@/db/repo/templates';
import * as usersRepo from '@/db/repo/users';
import { addMeetingFolder, zipInputFor } from '@/lib/export/zip';
import { resolveActor } from '@/server/auth';
import { guardUserQuota } from '@/server/rate-limit';

const README = `Your Eavesy export

meetings/        One folder per recording: summary, transcript, your notes, and
                 meeting.json with everything structured.
dictations.json  Your dictations and their text.
captures.json    Screenshots and videos you captured, with their transcripts.
templates.json   Your brief templates.
dictionary.json  Your learned speech corrections.
account.json     Your profile.

Audio and video files are not in this zip. Download them from each recording
in Eavesy (Export → zip), or find them in your Eavesy folder on your Mac.
`;

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const Route = createFileRoute('/api/account/export')({
  server: {
    handlers: {
      GET: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const overQuota = await guardUserQuota(actor.userId, 'export');
        if (overQuota) return overQuota;

        const db = getDb();
        const user = await usersRepo.getById(db, actor.userId);
        if (!user) return Response.json({ error: 'not_found' }, { status: 404 });

        const zip = new JSZip();
        zip.file('README.txt', README);
        zip.file('dictionary.json', json(await dictionaryRepo.list(db, actor.userId)));

        const meetings = await meetingsRepo.listForUser(db, { userId: actor.userId, limit: 10_000 });
        for (const meeting of meetings) {
          const full = await meetingsRepo.getFull(db, { meetingId: meeting.id, userId: actor.userId });
          if (full) addMeetingFolder(zip, zipInputFor(full), 'meetings/');
        }

        const dictations = await dictationsRepo.listForUser(db, { userId: actor.userId, limit: 10_000 });
        zip.file('dictations.json', json(dictations.map((d) => ({
          id: d.id,
          title: d.title,
          createdAt: new Date(d.createdAt).toISOString(),
          durationSec: d.durationSec,
          targetApp: d.targetApp,
          transcript: d.transcript,
          cleanedText: d.cleanedText,
        }))));

        const captures = await capturesRepo.listForUser(db, { userId: actor.userId, limit: 10_000 });
        zip.file('captures.json', json(captures.map((c) => ({
          id: c.id,
          title: c.title,
          kind: c.kind,
          createdAt: new Date(c.createdAt).toISOString(),
          durationSec: c.durationSec,
          transcript: c.transcript,
        }))));

        const templates = await templatesRepo.listForUser(db, actor.userId);
        zip.file('templates.json', json(templates.map((t) => ({
          name: t.name,
          appliesTo: t.appliesTo,
          systemPrompt: t.systemPrompt,
        }))));

        zip.file('account.json', json({
          email: user.email,
          name: user.displayName,
          company: user.companyName,
          role: user.role,
          phone: user.phoneNumber,
          language: user.defaultLanguage,
          createdAt: new Date(user.createdAt).toISOString(),
        }));

        const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        const day = new Date().toISOString().slice(0, 10);
        return new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="eavesy-export-${day}.zip"`,
            'cache-control': 'no-store',
          },
        });
      },
    },
  },
});
