# scripts

Repository-level entry points. Run them from the repository root unless a
section says otherwise.

## `cf`

Runs one command with the Eavesy Cloudflare credentials, so Wrangler never
falls back to your saved login or another account.

It needs:

- `CLOUDFLARE_ACCOUNT_ID` set to your Cloudflare account ID
  ([SELF_HOSTING.md](../docs/SELF_HOSTING.md)). The script exits if it is
  missing.
- On macOS, the API token stored in the Keychain as a generic password with
  service `eavesy-cloudflare` under your user name. The script reads it with
  `security find-generic-password` and does not work without that Keychain
  entry or without Keychain access; allow access when macOS prompts. Setup is
  in [DEPLOY.md](../docs/DEPLOY.md#account-and-authentication).
- On other systems (CI), `CLOUDFLARE_API_TOKEN` in the environment.

It exits if the token is empty, unsets other Cloudflare credential variables
(`CLOUDFLARE_API_KEY`, `CLOUDFLARE_EMAIL`, `CF_API_KEY`, `CF_EMAIL`,
`CF_API_TOKEN`, `CF_ACCOUNT_ID`), exports `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` for the child command only, then runs it in place.
Your shell and Wrangler login are left untouched.

```bash
cd web
../scripts/cf bunx wrangler d1 migrations list eavesy --remote
```

## `release-gate.sh`

Runs the full pre-release checks and stops at the first failure:

1. `web/`: lint, typecheck, tests, production build, and the Playwright UX
   suite (`bun run test:ux`).
2. `workers/processing` and `workers/mcp`: `tsc --noEmit` and
   `wrangler deploy --dry-run` into a temporary directory that is deleted on
   exit.
3. `desktop/`: `scripts/prebuild.sh` (launcher UI and Swift capture sidecar).
4. `desktop/src-tauri`: `cargo check --locked --all-targets` and
   `cargo test --locked`.
5. A Tauri debug build with no bundle.
6. `git diff --check` for whitespace errors.

It needs Bun, Rust (`cargo` on `PATH` or in `~/.cargo/bin`), and the macOS
toolchain the desktop build uses. The script does not read a Cloudflare token
or Keychain entry.

It makes no production changes: the Workers are only dry-run, nothing is
deployed or published, and no production data is touched.

```bash
scripts/release-gate.sh
```
