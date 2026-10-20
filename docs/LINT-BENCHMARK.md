# Oxlint migration and benchmark

Measured October 20, 2026 on macOS arm64 against main c336719, using Oxlint
1.89.0, oxlint-tsgolint 7.0.2004, and ESLint 9.39.5.

| Complete command | Median | Range |
| --- | ---: | ---: |
| Full ESLint | 5.887 s | 5.559–6.122 s |
| Oxlint + residual ESLint | 1.489 s | 1.468–1.535 s |

The combined command is 3.95× faster. All runs passed. Five alternating timed
runs follow warm-ups, without caches. Timing includes the residual ESLint pass.

## Preserved checks

`web/eslint.config.mjs` remains the reference and full fallback. The native
config explicitly translates effective rule options/severities, including core
rules disabled by TypeScript. Production type-aware rules are disabled again
for test files and testing helpers, preserving the original scope. The automatic
migrator alone did not preserve these details and was corrected.

Oxlint handles supported rules, including Hooks and type-aware rules. The
pinned official compatibility plugin disables only native rules in the residual
ESLint config, retaining unsupported no-octal, no-dupe-args and JS no-undef.
The residual parser does not build TypeScript programs. The combined command
fails on warnings. Oxlint checks native suppression comments; files with bare
or ESLint-only suppression directives, or inline rule/global/environment
configuration comments, are delegated entirely to the original
ESLint configuration, preserving valid and unused directive behavior. Parser
comment tokens (not text matching) determine delegation, including multiline
directives.

`lint:parity` checks every reference ESLint file is selected by Oxlint and every
enabled reference rule retains identical options in either pass. It checks
intentional Hooks errors, floating promises, unsafe assignments, explicit any,
unused variables, underscore exceptions, test-file scope, valid/unused
suppressions, inline typed-rule options and globals, and JS undeclared identifiers.
Temporary fixtures are cleaned up.
CI runs this separately from the fast lint command. The script reports the current file count.

These checks establish configuration coverage and representative diagnostics,
not equivalence for every possible program. Keep the reference configuration
and parity check when upgrading pins.

The only source adjustment removes a redundant outer return assertion from the
router compatibility shim. Its required argument assertion and generic return
type remain; this has no runtime effect.

Fatal parser errors follow the original ESLint contract: the file fails before
rule execution. Recovered semantic diagnostics on that invalid AST are omitted
until syntax is fixed. A probe combining invalid syntax and an explicit-any
violation verifies that this cannot be mistaken for an unused suppression.

```sh
bun run lint             # root: combined command
bun run lint:bench       # root: parity/probes then five timed comparisons
cd web
bun run lint:eslint      # full fallback
bun run lint:parity      # rule, file-scope and diagnostic checks
```
