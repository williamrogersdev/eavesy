# Rolldown build migration

Measured October 20, 2026 on macOS arm64, comparing locked Vite 6 builds at
main c336719 with Vite 8.3.4 and @vitejs/plugin-react 6.1.2 in both frontends.
One warm-up followed by three full builds using warm filesystem caches.

| Project | Vite 6 median (range) | Vite 8 median (range) | Speedup |
| --- | ---: | ---: | ---: |
| Web | 6.043 s (5.981–6.245) | 2.438 s (2.409–2.526) | 2.48× |
| Launcher | 0.961 s (0.952–1.019) | 0.215 s (0.211–0.216) | 4.47× |

Both frontends now use stable Vite 8's Rolldown/Oxc pipeline. The launcher uses
rolldownOptions for both HTML inputs. Explicit targets retain Vite 6's browser
floor (ES2020, Edge 88, Firefox 78, Chrome 87, Safari 14). Web targets are set
on the client environment so Cloudflare retains control of its Worker target;
a root target produced a duplicate-target initialization error.

Validation: both production builds, TypeScript, strict ESLint, unit and Worker
tests, and local Chrome checks of public pages, MDX docs, and the authenticated
local-test library and search. The seeded test library intentionally references
a missing media fixture (HTTP 400); no JavaScript exception was observed.
Existing chunk/dynamic-import warnings remain. Vite also reports a CSS-plugin
sourcemap warning, so CSS sourcemap fidelity is not claimed. JavaScript maps
are emitted.

After installing each package's locked dependencies and setting the documented
placeholder build env, run the script from either checkout's repository root:

```sh
bun /path/to/this/branch/scripts/benchmark-builds.ts
```

The runner uses the caller's checkout, reports its installed Vite version, and
fails on unsuccessful builds. This measures build latency, not runtime speed.
