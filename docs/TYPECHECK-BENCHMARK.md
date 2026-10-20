# Type checker comparison

Measured October 20, 2026 on macOS arm64 against main `f5619e9`, using
TypeScript 5.9.3 and pinned `tsrs@0.18.0-ts7.1.0-dev.20260929`
(TypeScript 7.1 development semantics).

## Decision

Use `tsrs` for web, both Workers, and the Worker test suite. CI, deployment,
and macOS release checks call the package's `typecheck` command so they use
that same default. Keep TypeScript installed for ESLint and other tools using
its API, and provide `typecheck:tsc` as a fallback. The root commands retain
their existing web-only scope.

## Results

| Configuration | tsc median (range) | tsrs median (range) | Speedup |
| --- | ---: | ---: | ---: |
| Web | 3.255 s (3.043–3.627) | 0.170 s (0.158–0.181) | 19.13× |
| Processing Worker | 0.873 s (0.820–0.974) | 0.102 s (0.095–0.117) | 8.57× |
| MCP Worker | 0.668 s (0.586–0.716) | 0.088 s (0.085–0.100) | 7.60× |
| Worker tests | 3.461 s (3.229–3.905) | 0.177 s (0.169–0.207) | 19.52× |

All timed runs passed without diagnostics. Ratios use unrounded measurements.
These are local results, not Linux CI speed measurements.

## Compatibility

Removed `baseUrl: "."` from both Worker configurations, since TypeScript 7
removed this option. Existing `paths` entries are already relative to their
configuration files and resolve successfully with both compilers. Main already
has compatible R2 stream assertions; no application code changes are needed.
Strict checking remains enabled.

Both compilers were compared for the repository source files they check, and
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
range, versions, exit codes, and diagnostics, cleans its caches, and exits
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
