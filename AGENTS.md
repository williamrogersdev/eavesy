# Eavesy — instructions for coding agents

Monorepo: `web/` (TanStack Start on Cloudflare Workers — read `web/AGENTS.md`
before touching it), `workers/processing`, `workers/mcp`, `desktop/` (Tauri +
Swift). Setup and the exact CI commands are in `CONTRIBUTING.md`.

## Definition of done: the PR is merged

A task that changes code is **not finished when the PR is opened**. It is
finished when the PR is merged into `main` (or when you hit one of the stop
conditions below and have told the user exactly why). Don't end your turn on
"PR created" or "draft ready for review". Keep going.

The loop, every time:

1. **Branch.** Work on a non-`main` branch (worktree branches like `claude/*`
   are fine). Never commit to `main` directly.
2. **Verify locally** before pushing. Run the CI commands for the areas you
   touched (`CONTRIBUTING.md` → "Running the tests"). At minimum for `web/`:
   `bun run build`, `bunx tsc --noEmit`, `bunx eslint .`, `bun test src`.
3. **Commit** with a conventional-commit subject (`feat(mcp): …`, `fix(web): …`,
   `chore: …`) and `git commit -s` (DCO sign-off is required).
4. **Open the PR ready for review, not as a draft.** `gh pr create --fill` or
   with a real title and body. Only use `--draft` if the user asked for it.
5. **Turn on auto-merge right away:** `gh pr merge <n> --auto --squash
   --delete-branch`. GitHub holds the merge until the required checks
   (`Web + Workers`, `Desktop (Rust + Swift)`) pass and every review
   conversation is resolved, so this is safe to do at creation time.
6. **Drive it to green.** Watch checks (`gh pr checks <n> --watch`, or the
   desktop app's CI monitor/Auto-fix if it's on). When something fails:
   read the log (`gh run view <id> --log-failed`), fix it, push, repeat.
   Don't stop on the first failure.
7. **Keep it up to date.** `main` requires branches to be current. If the PR
   is `BEHIND`, update it (`gh pr update-branch <n>`, or sync with the base
   branch and push). If it's `DIRTY`, resolve the conflicts yourself, re-run
   the local checks, and push.
8. **Address review comments.** Fix them, or reply with why not, then resolve
   the thread. Unresolved conversations block the merge.
9. **Confirm the merge.** `gh pr view <n> --json state,mergedAt`. Once merged,
   check that the production deploy (`deploy.yml`) started and didn't fail:
   `gh run list --workflow deploy.yml --limit 1`. Report the merged PR link
   and the deploy result.

If you're picking up a session and find your own open PR from earlier, start
at step 5 for that PR before doing anything else.

## Stop and ask instead of merging when

Every merge to `main` deploys straight to production (eavesy.com). Turn off
auto-merge (`gh pr merge <n> --disable-auto`) and ask the user before merging
if the PR:

- adds a D1 migration in `web/drizzle/` that is **not purely additive**
  (drops/renames a column or table, rewrites data, changes a constraint);
- changes `.github/workflows/deploy.yml`, `macos-release.yml`, wrangler
  bindings/routes, secrets handling, or auth (`web/src/start.ts`, Clerk config,
  MCP OAuth/token scopes);
- needs `--admin` or any bypass of branch protection to merge — never use it;
- is still red after three real fix attempts on the same failure.

When you stop, say which condition hit, what's left, and the PR link.

## Desktop releases

Agents may cut Mac app releases when the user asks, following
`docs/RELEASING.md`: `gh workflow run release-desktop.yml -f bump=patch` (or
`minor`) opens the version-bump PR with auto-merge, and the tag is pushed
automatically when it lands. Drive that PR to merged like any other, then see
the macOS release run through: the publish approval and the Homebrew cask PR.
If you ever tag by hand, push only that tag (`git push origin
desktop-vX.Y.Z`, never `--tags`).

## Hard rules

- Never force-push to `main`, never push to `main` directly, never merge with
  `--admin`.
- Never commit secrets, account IDs or `.env` files. Wrangler configs keep
  placeholder IDs; run `bun run cf:restore` if you rendered them locally.
- Don't merge other people's or Dependabot PRs unless the user asks.
