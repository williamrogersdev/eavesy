# Type checker comparison

Measured October 20, 2026 on macOS arm64 against main `f5619e9`, using
TypeScript 5.9.3 and pinned `tsrs@0.18.0-ts7.1.0-dev.20260929`
(TypeScript 7.1 development semantics).

## Decision

Use `tsrs` for web, both Workers, and the Worker test suite. CI, deployment,
and macOS release checks call the package's `typecheck` command so they use
that same default. Keep TypeScript installed for ESLint and other tools using
its API, and provide `typecheck:tsc` as a fallback. The root commands retain
their existing web-only scope. CI also runs an advisory (non-gating) upstream
TypeScript check across all four configurations while tsrs is experimental.
Upgrade the exact pin only after repeating successful checks, source-file parity,
intentional-error probes, benchmarks, and Linux CI. Remove the advisory check
only after evaluating a stable tsrs release.

## Results

| Configuration | tsc median (range) | tsrs median (range) | Speedup |
| --- | ---: | ---: | ---: |
| Web | 3.055 s (2.937–3.070) | 0.165 s (0.160–0.177) | 18.50× |
| Processing Worker | 0.876 s (0.851–0.898) | 0.099 s (0.093–0.102) | 8.85× |
| MCP Worker | 0.569 s (0.546–0.578) | 0.081 s (0.079–0.083) | 7.03× |
| Worker tests | 3.264 s (3.086–3.881) | 0.174 s (0.170–0.216) | 18.81× |

All timed runs passed without diagnostics. Ratios use unrounded measurements.
These are local results, not Linux CI speed measurements.

## Compatibility

Removed `baseUrl: "."` from both Worker configurations, since TypeScript 7
removed this option. Existing `paths` entries are already relative to their
configuration files and resolve successfully with both compilers. Main already
has compatible R2 stream assertions; no application code changes are needed.
Strict checking remains enabled.

Both compilers check the same repository source files: 335 in web, 45 in
processing, 12 in MCP, and 345 in Worker tests. They were also compared
with temporary intentional errors in each of the four configurations: invalid
assignment, invalid argument, nonexistent property, and a forbidden null value.
The expected diagnostics are TS2322 twice, TS2345, and TS2339. Temporary probe
files and caches are removed after validation. These checks do not establish
equivalence for every TypeScript program.

The original evaluation used an older checkout. These measurements replace
those earlier results and include the Worker test configuration added on main.

## Reproduce

Install dependencies in web and both Workers with `bun install --frozen-lockfile`.
Run `bun run build` from the root to generate the route tree, then:

```sh
bun run typecheck:bench
```

The benchmark runs package-local compilers with identical flags and separate,
empty temporary incremental caches. It performs one warm-up then five timed
runs per compiler/configuration, alternating compiler order. It reports median,
range, versions, exit codes, and diagnostics, verifies repository source-file parity,
includes warm-up failures in its gate, cleans its caches, and exits
nonzero if any invocation fails. Timings include process startup and use warm
filesystem caches; they do not measure incremental edits or watch mode.

Fallback commands:

```sh
bun run typecheck:tsc                    # root: web only
cd web
bun run typecheck:tsc --project test/tsconfig.json
# Both Worker packages also expose typecheck:tsc.
```

The pinned release ships macOS arm64 and Linux arm64/x64 binaries (GNU/musl),
including Ubuntu CI. Other platforms can use the TypeScript fallback.
