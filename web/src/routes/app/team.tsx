import { createFileRoute } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { AppAlert, AppEmptyState, AppPage, AppPageHeader, AppSection, appButton, appInput } from '@/components/ui/app-page';

export const Route = createFileRoute('/app/team')({ component: TeamPage });

const roleSchema = z.enum(['owner', 'admin', 'member']);
type Role = z.infer<typeof roleSchema>;

const teamSchema = z.union([
  z.object({
    team: z.null(),
    invitations: z.array(z.object({ id: z.string(), teamName: z.string(), role: z.enum(['admin', 'member']) })),
  }),
  z.object({
    team: z.object({ id: z.string(), name: z.string(), role: roleSchema }),
    me: z.string(),
    members: z.array(z.object({ userId: z.string(), name: z.string().nullable(), email: z.string().nullable(), role: roleSchema })),
    invites: z.array(z.object({ id: z.string(), email: z.string(), role: z.enum(['admin', 'member']) })),
  }),
]);
type TeamState = z.infer<typeof teamSchema>;
type InTeam = Extract<TeamState, { me: string }>;

const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const failureSchema = z.object({ message: z.string().optional() });

/** Calls the team API; throws the server's own sentence when it sends one. */
async function call(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return;
  const failure = failureSchema.safeParse(await response.json().catch(() => null));
  throw new Error((failure.success && failure.data.message) || 'That didn’t work. Try again.');
}

function TeamPage() {
  const [state, setState] = useState<TeamState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/team');
    if (!response.ok) throw new Error('Could not load your team.');
    setState(teamSchema.parse(await response.json()));
  }, []);

  useEffect(() => {
    void load().catch(() => setError('Could not load your team. Refresh to retry.'));
  }, [load]);

  /** Runs one change, then reloads; a failure shows the reason and leaves the page as it was. */
  const change = useCallback(async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That didn’t work. Try again.');
      setBusy(false);
      return false;
    }
    await load().catch(() => setError('Saved, but this page could not refresh. Reload to see it.'));
    setBusy(false);
    return true;
  }, [load]);

  return (
    <AppPage width="reading">
      <AppPageHeader title="Team" description={state?.team ? undefined : 'One account for your company or team.'} />
      {error ? <AppAlert>{error}</AppAlert> : null}
      {!state ? (
        error ? null : <p role="status" className="text-sm text-ev-ink-2">Loading…</p>
      ) : state.team ? (
        <Team state={state} busy={busy} change={change} />
      ) : (
        <NoTeam invitations={state.invitations} busy={busy} change={change} />
      )}
    </AppPage>
  );
}

type Change = (run: () => Promise<void>) => Promise<boolean>;

function NoTeam({ invitations, busy, change }: { invitations: Extract<TeamState, { team: null }>['invitations']; busy: boolean; change: Change }) {
  const [name, setName] = useState('');
  const create = (event: FormEvent) => {
    event.preventDefault();
    void change(() => call('POST', '/api/team', { name }));
  };
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      {invitations.length > 0 ? (
        <AppSection title="Invitations">
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="flex items-center justify-between gap-3 rounded-[var(--ev-r-panel)] bg-ev-well px-4 py-3">
                <p className="min-w-0 truncate text-sm text-ev-ink">
                  Join <span className="font-round font-bold">{invitation.teamName}</span> as {invitation.role === 'admin' ? 'an admin' : 'a member'}
                </p>
                <span className="flex shrink-0 gap-2">
                  <button type="button" disabled={busy} onClick={() => void change(() => call('POST', '/api/team/invites/answer', { id: invitation.id, accept: false }))} className={appButton('ghost', 'sm')}>
                    Decline
                  </button>
                  <button type="button" disabled={busy} onClick={() => void change(() => call('POST', '/api/team/invites/answer', { id: invitation.id, accept: true }))} className={appButton('primary', 'sm')}>
                    Join
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </AppSection>
      ) : null}
      <AppSection title="Start a team">
        <form onSubmit={create} className="flex gap-2">
          <input
            aria-label="Team name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Company or team name"
            className={appInput}
          />
          <button type="submit" disabled={busy || !name.trim()} className={appButton('primary')}>Create team</button>
        </form>
      </AppSection>
      {invitations.length === 0 ? (
        <AppEmptyState
          icon={<Users />}
          title="Joining someone else’s team?"
          description="Ask them to invite the email address you sign in with. The invitation shows up here."
        />
      ) : null}
    </div>
  );
}

function Team({ state, busy, change }: { state: InTeam; busy: boolean; change: Change }) {
  const { team, me, members, invites } = state;
  const manages = team.role !== 'member';
  const [name, setName] = useState(team.name);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [confirming, setConfirming] = useState<'leave' | 'delete' | null>(null);
  useEffect(() => setName(team.name), [team.name]);

  const invite = (event: FormEvent) => {
    event.preventDefault();
    void change(() => call('POST', '/api/team/invites', { email, role })).then((done) => {
      if (done) setEmail('');
    });
  };
  /** Whether the caller may change or remove this member: owners anyone, admins only members. */
  const manageable = (target: Role) => team.role === 'owner' || (team.role === 'admin' && target === 'member');

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <AppSection title="Name">
        {manages ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void change(() => call('PATCH', '/api/team', { name }));
            }}
          >
            <input aria-label="Team name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className={appInput} />
            {name.trim() && name.trim() !== team.name ? (
              <button type="submit" disabled={busy} className={appButton('primary')}>Save</button>
            ) : null}
          </form>
        ) : (
          <p className="text-sm text-ev-ink">{team.name}</p>
        )}
      </AppSection>

      <AppSection title={`People · ${members.length}`}>
        <ul className="divide-y divide-ev-line rounded-[var(--ev-r-panel)] bg-ev-raised shadow-[0_0_0_0.5px_var(--ev-line-strong)]">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate font-round text-sm font-bold text-ev-ink">
                  {member.name || member.email || 'Someone'}
                  {member.userId === me ? <span className="ml-1.5 font-sans text-xs font-normal text-ev-ink-2">you</span> : null}
                </p>
                {member.name && member.email ? <p className="truncate text-[13px] text-ev-ink-2">{member.email}</p> : null}
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {team.role === 'owner' && member.userId !== me ? (
                  <select
                    aria-label={`Role of ${member.name || member.email || 'this person'}`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => {
                      const next = roleSchema.safeParse(event.target.value);
                      if (next.success) void change(() => call('PATCH', '/api/team/members', { userId: member.userId, role: next.data }));
                    }}
                    className={`${appInput} h-8 w-28`}
                  >
                    {roleSchema.options.map((option) => <option key={option} value={option}>{ROLE[option]}</option>)}
                  </select>
                ) : (
                  <span className="text-[13px] text-ev-ink-2">{ROLE[member.role]}</span>
                )}
                {member.userId !== me && manageable(member.role) ? (
                  <button type="button" disabled={busy} onClick={() => void change(() => call('DELETE', '/api/team/members', { userId: member.userId }))} className={appButton('ghost', 'sm')}>
                    Remove
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </AppSection>

      {manages ? (
        <AppSection title="Invite someone" description="They join by signing in to Eavesy with this email address. No email is sent yet, so let them know.">
          <form onSubmit={invite} className="flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              required
              aria-label="Email address to invite"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              className={appInput}
            />
            {team.role === 'owner' ? (
              <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value === 'admin' ? 'admin' : 'member')} className={`${appInput} sm:w-32`}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            ) : null}
            <button type="submit" disabled={busy || !email.trim()} className={appButton('primary')}>Invite</button>
          </form>
          {invites.length > 0 ? (
            <ul className="divide-y divide-ev-line rounded-[var(--ev-r-ctl)] border border-ev-line">
              {invites.map((pending) => (
                <li key={pending.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    {pending.email}
                    <span className="ml-2 text-xs text-ev-ink-2">invited as {ROLE[pending.role].toLowerCase()}</span>
                  </span>
                  <button type="button" disabled={busy} onClick={() => void change(() => call('DELETE', '/api/team/invites', { id: pending.id }))} className={appButton('ghost', 'sm')}>
                    Take back
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </AppSection>
      ) : null}

      <AppSection title="Leave">
        {confirming ? (
          <div className="flex flex-col gap-2 rounded-[var(--ev-r-panel)] bg-ev-warn-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ev-warn-ink">
              {confirming === 'delete'
                ? `Delete ${team.name} for all ${members.length}? This can’t be undone.`
                : members.length === 1
                  ? `You’re the only one here, so leaving deletes ${team.name}.`
                  : `Leave ${team.name}? You’d need a new invitation to come back.`}
            </p>
            <span className="flex shrink-0 gap-2">
              <button type="button" onClick={() => setConfirming(null)} className={appButton('ghost', 'sm')}>Cancel</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void change(() => call('DELETE', confirming === 'delete' ? '/api/team?everyone=1' : '/api/team')).then(() => setConfirming(null))}
                className={appButton('danger', 'sm')}
              >
                {confirming === 'delete' ? 'Delete team' : 'Leave team'}
              </button>
            </span>
          </div>
        ) : (
          <div className="flex gap-2">
            <button type="button" onClick={() => setConfirming('leave')} className={appButton('secondary', 'sm')}>Leave team</button>
            {team.role === 'owner' && members.length > 1 ? (
              <button type="button" onClick={() => setConfirming('delete')} className={appButton('ghost', 'sm')}>Delete team for everyone</button>
            ) : null}
          </div>
        )}
      </AppSection>
    </div>
  );
}
