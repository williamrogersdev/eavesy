@AGENTS.md

## Claude Code specifics

- The PR loop in `AGENTS.md` is a standing instruction from the repo owner:
  open PRs ready for review, enable auto-merge (`gh pr merge --auto --squash
  --delete-branch`, or the desktop app's auto-merge toggle), and keep working
  until the PR is merged. You never need to ask before enabling auto-merge.
- In the desktop app, after opening a PR, bind it and turn on Auto-fix so CI
  failures, conflicts and review comments wake the session back up.
- Run long waits (`gh pr checks --watch`, full builds) in the background
  rather than blocking the turn.
- At the end of a task, report: PR link, merged yes/no, deploy status. "PR
  created" alone is an incomplete report.
