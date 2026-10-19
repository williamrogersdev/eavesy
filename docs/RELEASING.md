# Releasing the Mac app

A release is one button and one approval:

1. **Actions → Release desktop → Run workflow**, pick `patch` or `minor`.
2. When the draft GitHub Release appears, test its DMG, then approve the
   `publish` job.

Everything between those two steps is automatic. Three workflows do it:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`release-desktop.yml`](../.github/workflows/release-desktop.yml) | Manual (`patch`, `minor`, `major` or an exact `X.Y.Z`) | Runs `scripts/bump-desktop.mjs`: bumps `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, and moves `[Unreleased]` in `CHANGELOG.md` under `## [X.Y.Z] - date - desktop`. If `[Unreleased]` is empty, the section is written from the titles of PRs that touched `desktop/` since the last `desktop-v` tag (`feat` → Added, `fix` → Fixed, the rest → Changed; `chore`, `ci`, `docs`, `test` are left out). Opens `chore(release): desktop X.Y.Z` with auto-merge on. |
| [`tag-desktop-release.yml`](../.github/workflows/tag-desktop-release.yml) | A push to `main` that changes `tauri.conf.json` | If `desktop-vX.Y.Z` doesn't exist yet, checks `Cargo.toml` and the CHANGELOG section, then pushes the annotated tag. |
| [`macos-release.yml`](../.github/workflows/macos-release.yml) | Tag push `desktop-vX.Y.Z` | Build, sign, notarize, draft release, **publish (approval)**, Homebrew cask PR. Details below. |

To reword the release notes, edit `CHANGELOG.md` on the `release/desktop-vX.Y.Z`
branch before the PR merges (or write them under `[Unreleased]` before you
run the workflow; those are used as they are). The version-bump PR only
touches `desktop/` and `CHANGELOG.md`, so it doesn't redeploy eavesy.com.

The same bump works locally: `node scripts/bump-desktop.mjs minor --dry-run`
prints the next version and CHANGELOG section without changing anything.

The local scripts (`desktop/scripts/build-macos-release.sh` and
`release-macos.sh`) are what the workflow runs, so a laptop release still works
as a fallback (see [desktop/BUILD.md](../desktop/BUILD.md)).

## What the workflow does

| Trigger | Jobs |
| --- | --- |
| Push tag `desktop-vX.Y.Z` | prepare → build → draft GitHub Release → **publish (approval)** → Homebrew cask PR |
| Manual run (Actions → macOS release → Run workflow) | prepare → build only. Leaves a notarized release candidate as a CI artifact and publishes nothing. |

1. **prepare** fails fast, before the 90-minute build, if the tag isn't
   `desktop-v` + the `version` in `desktop/src-tauri/tauri.conf.json`, if
   `desktop/src-tauri/Cargo.toml` disagrees with it, or if `CHANGELOG.md` has
   no `## [X.Y.Z]` section. That section becomes the release notes.
2. **build** (environment `macos-signing`, `macos-15` arm64) runs the web,
   Worker and Rust checks, imports the Developer ID certificate into a
   temporary keychain, runs `build-macos-release.sh`, then
   `release-macos.sh` to notarize, staple and Gatekeeper-check the exact DMG.
3. **github-release** creates a **draft** release `desktop-vX.Y.Z` with
   `Eavesy_X.Y.Z_aarch64.dmg`, `Eavesy_X.Y.Z_aarch64.app.tar.gz`, its `.sig`
   and `SHA256SUMS`. Download the DMG from the draft and acceptance-test it
   before you approve the next job.
4. **publish** (environment `macos-release`, required reviewer) runs
   `release-macos.sh --publish`. The DMG is already stapled, so the script
   skips signing and goes straight to validation, the R2 upload of
   `eavesy-latest.dmg`, the byte check against
   `https://eavesy.com/api/downloads/mac/latest`, the updater archive, and
   `latest.json` (written last). It then confirms that
   `/api/updates/darwin/aarch64/0.0.0` offers the new version. Once that
   passes, the draft GitHub Release is published and marked latest.
5. **homebrew-cask** opens a PR on `williamrogersdev/homebrew-eavesy` that
   rewrites the `version` and `sha256` lines of `Casks/eavesy.rb`. It uses the
   same DMG bytes, so the hash matches both R2 and the GitHub Release.

Only Apple Silicon (`aarch64`) is built, which matches the local scripts.

## Cutting a release

1. Run **Actions → Release desktop** from `main` with `patch` or `minor`
   (`gh workflow run release-desktop.yml -f bump=minor`). It opens the
   version-bump PR with auto-merge on; CI must pass as for any PR.
2. When it merges, the tag is pushed and the macOS release run starts on its
   own.
3. Wait for the draft release. Install its DMG on a clean Mac account and test
   recording, pairing and the update check.
4. Approve the `publish` job (Actions run → Review deployments → `macos-release`).
5. Merge the cask PR in `homebrew-eavesy`. The workflow has already checked
   that the cask URL serves the published DMG with the same sha256.

Without `RELEASE_TOKEN` the first two steps are manual: run
`node scripts/bump-desktop.mjs minor`, open the PR, and after it merges push
the tag yourself (`git tag desktop-vX.Y.Z origin/main`, then
`git push origin desktop-vX.Y.Z`).

To retry, use "Re-run failed jobs". Publishing is idempotent: it re-uploads
the same bytes. If the build itself was wrong, delete the draft release and
the tag, fix the problem, and tag again.

## One-time setup

### 1. Environments

**Settings → Environments.** The build and publish secrets go in separate
environments. That way the build runs without waiting, and only publishing
needs approval.

- **`macos-signing`** (new). No reviewers. Deployment branches and tags:
  selected → branch `main` and tag pattern `desktop-v*`. This allows manual
  candidate runs from `main` and tagged releases, and nothing else.
- **`macos-release`** (exists, currently has no protection rules). Add
  yourself under **Required reviewers**, and set Deployment branches and
  tags to the tag pattern `desktop-v*` only.

Also add a tag ruleset (**Settings → Rules → New tag ruleset**, target
`desktop-v*`, restrict creations/updates/deletions to admins). Without it,
anyone with write access can trigger a signed build.

### 2. `macos-signing` secrets

Run these from your Mac in your own terminal. `gh secret set` reads the value
from stdin or a prompt, so nothing ends up in shell history. Never paste
these values into chat.

| Secret | What it is | How to get it on your Mac |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Base64 `.p12` of the **Developer ID Application** certificate **and its private key** | Keychain Access → login → My Certificates → right-click "Developer ID Application: … (TEAMID)" → Export → `devid.p12`, set a password. Then `base64 -i devid.p12 \| gh secret set APPLE_CERTIFICATE --env macos-signing`, and delete `devid.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | The password you just set on the `.p12` | `gh secret set APPLE_CERTIFICATE_PASSWORD --env macos-signing` (prompts) |
| `KEYCHAIN_PASSWORD` | Any random string; it locks the throwaway CI keychain | `openssl rand -base64 32 \| gh secret set KEYCHAIN_PASSWORD --env macos-signing` |
| `APPLE_ID` | Apple ID email of the developer account | `gh secret set APPLE_ID --env macos-signing` |
| `APPLE_PASSWORD` | An **app-specific password** (not your Apple ID password). The one inside the local `eavesy-notary` profile can't be read back out. | account.apple.com → Sign-In and Security → App-Specific Passwords → "+" → name it `eavesy-ci`. Then `gh secret set APPLE_PASSWORD --env macos-signing`. |
| `APPLE_TEAM_ID` | 10-character team ID | `security find-identity -v -p codesigning` shows it in parentheses after the identity name. Then `gh secret set APPLE_TEAM_ID --env macos-signing`. |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater Minisign private key. **Use the existing key.** A new key orphans every installed copy. | `gh secret set TAURI_SIGNING_PRIVATE_KEY --env macos-signing < ~/.tauri/eavesy-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password | Only if the key has one; the local scripts use an empty password. GitHub can't store an empty secret, and an unset secret is passed as an empty string, so skip it in that case. |

**Instead of the Apple ID set** you can use an App Store Connect API key. It
doesn't expire with your password and isn't tied to your 2FA. Create it at
App Store Connect → Users and Access → Integrations → Team Keys with the
Developer role. Leave `APPLE_ID` unset, because the workflow uses the Apple ID
set whenever `APPLE_ID` is present.

| Secret | Value |
| --- | --- |
| `APPLE_API_ISSUER` | Issuer ID shown above the keys table |
| `APPLE_API_KEY` | Key ID (e.g. `ABC123DEFG`) |
| `APPLE_API_PRIVATE_KEY` | Contents of `AuthKey_<id>.p8`: `gh secret set APPLE_API_PRIVATE_KEY --env macos-signing < AuthKey_ABC123DEFG.p8` (it can be downloaded only once) |

### 3. `macos-release` secrets and variables

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | A **new, narrow** token, `eavesy-release-r2`: account permission *Workers R2 Storage Edit* (add *Account Settings Read* if Wrangler asks), this account only. Don't reuse the broad deploy token from [DEPLOY.md](DEPLOY.md). `gh secret set CLOUDFLARE_API_TOKEN --env macos-release` |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Same account ID as production: `gh variable set CLOUDFLARE_ACCOUNT_ID --env macos-release` |

### 4. Error reporting (repository variables, optional)

The app reports errors and crashes to PostHog error tracking when a project
key is compiled in. The project API key (`phc_…`) is public by design, so it
is a variable, not a secret. Without it the build still succeeds and the app
reports nothing.

| Name | Value |
| --- | --- |
| `DESKTOP_POSTHOG_KEY` | PostHog → Project settings → Project API key. `gh variable set DESKTOP_POSTHOG_KEY` |
| `DESKTOP_POSTHOG_HOST` | Only for the EU cloud or self-hosting, e.g. `https://eu.i.posthog.com`. Defaults to `https://us.i.posthog.com`. |

### 5. Release token (repository secret)

| Name | Value |
| --- | --- |
| `RELEASE_TOKEN` | Fine-grained PAT of a repository **admin**, repository access **only** `williamrogersdev/eavesy`, permissions *Contents: read and write* and *Pull requests: read and write*. `gh secret set RELEASE_TOKEN --repo williamrogersdev/eavesy` |

`release-desktop.yml` and `tag-desktop-release.yml` use it instead of the
default `GITHUB_TOKEN` for three reasons: PRs, merges and tags made with
`GITHUB_TOKEN` start no workflows (so neither CI nor the release run would
start), this repository doesn't let Actions open PRs, and the
`desktop-v*` tag ruleset only lets admins create tags. Give it an expiry and
put a reminder in your calendar; when it lapses, both workflows fail with a
message pointing here.

### 6. Homebrew tap token (repository secret)

| Name | Value |
| --- | --- |
| `HOMEBREW_TAP_TOKEN` | Fine-grained PAT, repository access **only** `williamrogersdev/homebrew-eavesy`, permissions *Contents: read and write* and *Pull requests: read and write*. `gh secret set HOMEBREW_TAP_TOKEN --repo williamrogersdev/eavesy` |

This is a repository secret, not an environment secret, so the cask job
doesn't need a second approval. The tap must exist, with `Casks/eavesy.rb`
containing exactly one `version "…"` line and one `sha256 "…"` line, and a
versioned `url`, for example
`https://github.com/williamrogersdev/eavesy/releases/download/desktop-v#{version}/Eavesy_#{version}_aarch64.dmg`.

### 7. Dry run

Run the workflow manually from `main` (Actions → macOS release → Run
workflow). It exercises every signing and notarization secret and publishes
nothing. Download the `eavesy-macos-X.Y.Z` artifact and open the DMG. When
that's green, push the first tag.
