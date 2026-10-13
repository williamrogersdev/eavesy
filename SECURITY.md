# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
[Report a vulnerability](https://github.com/williamrogersdev/eavesy/security/advisories/new).
Don't open a public issue or pull request for them.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get an acknowledgement within a few days, and a fix or a plan
once it has been triaged. If you'd like to be credited in the advisory, say so.

## Scope

In scope:

- The web app and API (`web/`), the processing and MCP workers (`workers/`).
- The macOS app (`desktop/`), including device pairing and the update channel.
- The hosted service at eavesy.com.

Please don't run automated scanners against eavesy.com, access other users'
data, or degrade the service while testing. A local or self-hosted deployment
is the right place for anything intrusive.

## Supported versions

Fixes go into `main` and the latest macOS release. Older desktop builds pick
them up through the in-app updater.
