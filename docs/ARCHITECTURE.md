# Architecture

This document describes the architecture that exists in the repository. File
paths are relative to the repo root; `Symbol` names refer to exports or
functions in those files. Where something could not be determined from the
repository, it says so.

## 1. Overview

```
                          ┌──────────────────────── Local companion (real use) ───────────────────────┐
 Browser (React SPA) ───▶ │ server/main.ts  (node:http, port 3000)                                     │
  app/page.tsx            │   ├─ /api/tunarr/*  → server/nodeAdapter.ts → server/tunarrProxy.ts ──────┼──▶ Tunarr (TUNARR_URL)
  lib/tunarrClient.ts     │   ├─ /healthz                                                              │     /api/channels
  (same-origin fetch)     │   └─ static files from dist-local/ (Vite build of local/ + app/page.tsx)   │     /api/channels/:id/programming
                          └────────────────────────────────────────────────────────────────────────────┘     /api/channels/:id/lineup

                          ┌──────────────── Hosted preview (OpenAI Sites, demo-only) ─────────────────┐
 Browser ───────────────▶ │ Vinext app router: app/layout.tsx + app/page.tsx                           │
                          │ No /api/tunarr routes, so /api/tunarr/health → 404 HTML → "unavailable"     │
                          └────────────────────────────────────────────────────────────────────────────┘
```

One UI component (`app/page.tsx`, default export `Home`) is shared by both
targets. All Tunarr I/O in the browser goes through `lib/tunarrClient.ts` to
same-origin `/api/tunarr/*` paths. Only the companion server implements those
paths.

## 2. Repository layout

| Path | Role |
| --- | --- |
| `app/page.tsx` | The entire UI: state, data loading, rendering, dialogs. `'use client'` component `Home`. |
| `app/layout.tsx` | Hosted-only root layout: Geist fonts (`next/font/google`), metadata, OpenGraph. Not used by the companion build. |
| `app/globals.css` | All styling (Mac OS 9 theme, responsive rules, rem-based scaling). Imports Tailwind. |
| `lib/lineup.ts` | Pure domain types and lineup math (projection, guide mapping, reorder, save payload). |
| `lib/tunarrClient.ts` | Browser client for `/api/tunarr/*`: `checkHealth`, `tunarrApi`, `TunarrApiError`, `ConnectionState`. |
| `lib/demoData.ts` | Demo channels and lineup (`demoChannels`, `demoProgramming()`, `demoDate`). |
| `local/index.html`, `local/main.tsx` | Companion SPA entry: renders `<Home />` into `#root` under `StrictMode` and imports `app/globals.css`. |
| `server/tunarrProxy.ts` | Framework-free proxy and validation logic: `handleTunarrApi`, `createProxyConfig`, `parseTunarrUrl`, validators. |
| `server/nodeAdapter.ts` | Adapts Node `IncomingMessage`/`ServerResponse` to `handleTunarrApi` (`handleNodeApiRequest`, `isTunarrApiPath`). |
| `server/main.ts` | Production HTTP server: API dispatch, `/healthz`, static files, SPA fallback, security headers. |
| `server/tsconfig.json` | Compiles `server/*.ts` (excluding tests) to `dist-server/` (NodeNext ESM). |
| `vite.config.ts` | Hosted build/dev: `vinext()`, `sites()` (OpenAI Sites), `cloudflare()` plugins. |
| `vite.local.config.ts` | Companion build/dev: React plugin, Tailwind PostCSS, dev middleware for `/api/tunarr`. |
| `vitest.config.ts` | Test runner config (`tests/**/*.test.{ts,tsx}`, default env `node`). |
| `tests/` | `tunarrProxy.test.ts`, `lineup.test.ts`, `page.test.tsx`, shared `fixtures.ts`. |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml` | Companion container and an example stack alongside Tunarr. |
| `.openai/hosting.json` | OpenAI Sites project metadata (`project_id`; `d1` and `r2` both `null`). |
| `public/` | `favicon.svg`, `og.png`. Served by both targets (`publicDir: '../public'` locally). |
| `next.config.ts` | Empty `NextConfig`. |
| Generated (do not edit) | `dist/`, `dist-local/`, `dist-server/`, `.next/types/`, `.vinext/`, `.wrangler/`, `next-env.d.ts`. |

## 3. Frameworks and major dependencies

From `package.json` (Node `>=22.13.0`, `"type": "module"`):

- **React 19** (`react`, `react-dom`), the only UI library. No state library, no router library.
- **Next 16 / Vinext 1.0.0-beta.3**: hosted target only. Vinext runs the Next App Router on Vite. `next` is a runtime dependency for the hosted build; the companion bundle does not use Next APIs.
- **Vite 8**: both builds. **`@vitejs/plugin-react`**: companion build and tests.
- **`@cloudflare/vite-plugin`, `wrangler`, `@cloudflare/workers-types`**: the hosted build targets a Workers-style runtime (`nodejs_compat`, `main: 'vinext/server/app-router-entry'`). Local `vinext dev` runs through Miniflare/workerd.
- **`@openai/sites-vite-plugin`** (`sites()`): copies `.openai/hosting.json` into `dist/.openai/` for OpenAI Sites deployment. Its dev-mode "Sign in with ChatGPT" simulation is not used by this app.
- **Tailwind CSS 4** via `@tailwindcss/postcss`: `app/globals.css` starts with `@import 'tailwindcss'`. The only utility class in markup is `antialiased` on `<body>`. All other styling is custom CSS.
- **Testing**: `vitest` 4, `jsdom`, `@testing-library/react`, `@testing-library/dom`.
- **Lint**: `eslint` 9 with `eslint-config-next` (`core-web-vitals`, `typescript`).
- **The companion server has no runtime dependencies**: only `node:http`, `node:fs`, `node:path`, `node:url` and global `fetch`.

## 4. Entry points

| Target | Command | Entry |
| --- | --- | --- |
| Companion dev | `npm run dev:local` | `vite.local.config.ts` (root `local/`), with plugin `tunarrApi()` mounting the proxy as Vite middleware |
| Companion build | `npm run build:local` | `vite build --config vite.local.config.ts` → `dist-local/`; `tsc -p server/tsconfig.json` → `dist-server/` |
| Companion run | `npm run start:local` / Docker `CMD` | `node dist-server/main.js` |
| Hosted dev/build/start | `npm run dev` / `build` / `start` | `vinext dev` / `vinext build` (→ `dist/client`, `dist/server`, `dist/.openai`) / `vinext start` |
| Tests | `npm test` | `vitest run` |

## 5. Routing

**Client:** there is no client-side routing. `Home` is a single screen. Its
dialogs (connection, confirm, move/swap) are conditional overlays driven by
state.

**Hosted (Vinext):** the only app route is `/` (`app/page.tsx` under
`app/layout.tsx`). There are no route handlers. A request to
`/api/tunarr/health` returns a 404 HTML page (verified with `vinext dev`;
production behaviour on OpenAI Sites was not verified).

**Companion server** (`server/main.ts`, request handler in `http.createServer`), evaluated in order:

1. `isTunarrApiPath(req.url)` (`/api/tunarr` or `/api/tunarr/...`) → `handleNodeApiRequest`.
2. `/healthz` → `200 {"status":"ok"}`. This is app liveness only and does not check Tunarr. Used by the Docker `HEALTHCHECK`.
3. Methods other than GET/HEAD → `405`.
4. An existing file under the static root (`resolveStatic` rejects path traversal outside `staticRoot`) → served. `/assets/*` gets `immutable` caching; everything else gets `no-cache`.
5. A missing path with a file extension → `404`.
6. Anything else → `index.html` (SPA fallback). If the UI isn't built, the response is a 500 text message.

Static responses carry `securityHeaders`: a CSP with `default-src 'self'`,
`connect-src 'self'`, `img-src 'self' data:`, `style-src 'self' 'unsafe-inline'`
and `frame-ancestors 'none'`, plus `x-content-type-options: nosniff` and
`referrer-policy: no-referrer`. API responses carry
`cache-control: no-store` and `nosniff`.

## 6. The Tunarr proxy (`server/tunarrProxy.ts`)

### Configuration

`createProxyConfig(env)` builds a `ProxyConfig`:

- **`TUNARR_URL`** is parsed by `parseTunarrUrl` into a `TunarrTarget` (`origin`, `basePath`, `host`, optional `authorization`).
  - It must be `http:` or `https:` with no query or fragment.
  - Userinfo is converted to a `Basic` `authorization` header and never appears in `host` or `origin`.
  - A path prefix is kept as `basePath`.
- **Missing `TUNARR_URL`** → `target: null`. **Invalid** → `configError`, a fixed message that never echoes the value.
- **`TUNARR_TIMEOUT_MS`** (default `DEFAULT_TIMEOUT_MS` = 10000) and **`TUNARR_SAVE_TIMEOUT_MS`** (default `DEFAULT_SAVE_TIMEOUT_MS` = 30000).
- **`fetchImpl`** is optional, for tests.

The server builds the config once at startup (`server/main.ts`). The dev
middleware builds it once from `loadEnv(mode, cwd, '')` merged with
`process.env`.

### Allowed routes (`matchRoute`)

| Route | Methods | Upstream |
| --- | --- | --- |
| `/api/tunarr/health` | GET | `GET /api/channels`. Responds `{status:'connected', tunarrHost, channelCount}` |
| `/api/tunarr/channels` | GET | `GET /api/channels` (must be an array) |
| `/api/tunarr/channels/:id/programming` | GET, POST | `GET`/`POST /api/channels/:id/programming` |
| `/api/tunarr/channels/:id/lineup` | GET | `GET /api/channels/:id/lineup?from=&to=` |

### Request pipeline (`handleTunarrApi`)

Each step is checked in this order before any upstream call:

1. The path is parsed with `new URL(request.url, 'http://companion.invalid')`, which normalizes `..` segments. No route match → `404 route_not_allowed`.
2. The raw `:id` segment fails `CHANNEL_ID` (`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`) → `400 invalid_channel_id`.
3. Method not allowed → `405 method_not_allowed` with an `allow` header.
4. `isCrossOrigin`: an `Origin` header whose host matches neither `Host` nor `X-Forwarded-Host` → `403 cross_origin_blocked`.
5. Query validation:
   - `lineup` requires exactly one `from` and one `to`, both matching `ISO_DATETIME`, with `to > from` and a span of at most `MAX_LINEUP_RANGE_MS` (14 days). They're re-serialized with `toISOString()`. See `validateLineupRange`.
   - Every other route rejects any query string.
   - Failures → `400 invalid_query`.
6. POST body checks:
   - Content type must be `application/json` (else `415`).
   - The body must parse as JSON (else `400 invalid_json`).
   - `validateManualProgramming` requires `type: 'manual'`, `append` absent or `false`, and a `lineup` array of at most `MAX_LINEUP_ITEMS` entries. Each entry needs a known `type` (`LINEUP_ITEM_TYPES`) and a finite positive `duration`. `content`, `custom` and `filler` need a string `id`; `redirect` needs a string `channel`.
   - The upstream body is rebuilt as `{type:'manual', lineup, append:false}`. Lineup items themselves are forwarded unchanged.
7. No target → `503`:
   - Health returns `{status:'not_configured', error:{code:'not_configured' | 'invalid_config', message}}`.
   - Other routes return a normal error with that code.
8. `callTunarr` performs the upstream request (below).

### Upstream call (`callTunarr`)

- **URL:** `${origin}${basePath}${path}`.
- **Headers:** only `accept: application/json`, `content-type` for POST, and the configured `authorization`. Browser headers are never forwarded; `nodeAdapter` passes only `host`, `origin`, `x-forwarded-host` and `content-type` into the handler, and those are used for checks only.
- **Request options:** `redirect: 'manual'` and `AbortSignal.timeout(ms)`. The timeout covers the response body too.

Error mapping (`UpstreamError`):

| Condition | Status | Code |
| --- | --- | --- |
| Timeout / abort | 504 | `tunarr_timeout` |
| Network failure | 502 | `tunarr_unreachable` (message includes host and, if available, a `cause.code` like `ECONNREFUSED`) |
| 3xx | 502 | `tunarr_redirect` |
| 404 | 404 | `not_found` |
| 400 | 400 | `tunarr_rejected` (upstream message, single-line, at most 300 chars, via `upstreamMessage`) |
| 401/403 | 502 | `tunarr_auth` |
| Other non-2xx | 502 | `tunarr_error` |
| 2xx with non-JSON body | 502 | `tunarr_invalid_response` |
| Unexpected exception | 500 | `internal_error` (logged server-side; generic message) |

Error body shape: `{ "error": { "code", "message", "tunarrHost"? } }`. Health
failures use `{ "status": "unreachable", "tunarrHost", "error": {...} }`.
Successful responses are parsed and re-serialized as JSON.

### Node adapter (`server/nodeAdapter.ts`)

`handleNodeApiRequest` reads POST bodies up to `MAX_BODY_BYTES` (20 MiB). A
larger body gets `413 payload_too_large`. The same adapter serves the
production server and the Vite dev middleware.

## 7. Client data flow (`app/page.tsx`)

### State

All state is local React state in `Home` (`useState`). There is no context,
store or persistence.

- **Mode and connection:** `mode` (`'live' | 'demo'`, initial `'live'`); `connection` (`ConnectionState`, initial `checking`).
- **Data:** `channels`, `activeChannelId`, `programming`, `originalLineup` (the baseline for dirty checks), `guide` (`{channelId, date, programs}`).
- **Loading and errors:** `channelsLoading`, `channelsError`, `loading`, `programmingError`, `guideLoading`, `guideError`, `saving`.
- **UI:** `selectedIndex`, `selectedDate` (`YYYY-MM-DD`, initial `demoDate`), `search`, `connectionOpen`, `arrangeOpen`, `arrangeSearch`, `confirmDialog`, `message` (toast), `draggedIndex`.
- **Stale-response guards:** `programmingRequest` and `guideRequest` refs hold incrementing counters, and responses from superseded requests are discarded.

Derived values:

- `dirty = !sameLineup(programming.lineup, originalLineup)`, a JSON string comparison.
- `guideIsCurrent`: live, not dirty, and the guide matches the active channel and date.
- `daySchedule = scheduleForDay(guideIsCurrent ? guide.programs : null, lineup, activeChannel.startTime, selectedDate)`, which yields `rows`, `guideWindow` and `guideStale`.
- `visibleInstances`: `rows` filtered by search.
- `sourceNote` and the empty-state text, computed from the states above.

### Startup

1. On mount, the effect calls `checkHealth()`, which does `GET /api/tunarr/health`:
   - A JSON body with `status` maps to `connected`, `not_configured` or `unreachable`.
   - A non-JSON body or a missing `status` maps to `unavailable`, which is the hosted-preview case.
   - A network failure maps to `unreachable`.
2. If not connected, `connectionOpen` is set to true and the user picks **Check again** (`goLive`) or **Use demo data** (`switchToDemo`). Nothing loads automatically.
3. If connected:
   - `selectedDate` becomes today.
   - `loadChannels(today)` → `tunarrApi.channels()`, sorted by `number`.
   - `loadProgramming(first.id, today)`, which sets `programming` and `originalLineup` (via `structuredClone`) and then calls `loadGuide(channelId, date)`.
   - `loadGuide` → `tunarrApi.lineup(id, from, to)`, using the local-midnight-to-midnight range from `dayRange`.

### Day schedule computation (`lib/lineup.ts`)

- **`instancesForDay(lineup, startTime, date)`:** walks the repeating cycle (sum of durations) from the channel's `startTime` and emits rows overlapping the local day. Tunarr's returned `startTimeOffsets` are typed but not used.
- **`instancesFromGuide(guide, lineup, startTime, date)`:** maps each guide entry back to a lineup index.
  - **Primary:** `lineupIndexAt(start + 1ms)` plus `sameProgram`, matching by `id`, or by `type` for id-less items.
  - **Fallback:** `nearestById`, the closest occurrence of the same `id` in cyclic index distance.
  - **Unmatched entries** get `lineupIndex: -1` and the guide's title. They render disabled.
- **`scheduleForDay`:**
  - **No guide rows** → projection only.
  - **Matched guide rows cover less than half the guide's time span** → `guideStale: true`, projection only.
  - **Otherwise** → projected rows before the guide window, then guide rows, then projected rows after it.

### Editing

- **`reorderLineup(lineup, from, to, swap)`** returns a new array, or `null` for no-op or out-of-range moves. It only moves or swaps existing entries.
- **Triggers:** `nudge(±1)` (swap with a neighbour), the arrange dialog's **Move before** / **Swap**, and drag and drop (`onDrop` → move before).
- **`undo`** restores `structuredClone(originalLineup)`.
- **`guardUnsaved(action)`** wraps channel switches, `switchToDemo` and **Check again** with a confirm dialog when `dirty`.
- A `beforeunload` listener is active while live and dirty.

### Saving

1. **`save()`:**
   - In demo mode it resets the baseline only.
   - In live mode with `hasGeneratedSchedule(programming)` (any non-null `schedule`), it opens a confirm dialog first.
2. **`performSave()`:**
   - `buildManualSave(lineup)` builds `{type:'manual', lineup, append:false}`, dropping items whose `duration` is not positive.
   - `tunarrApi.saveProgramming(id, request)` sends a POST.
3. **On success:**
   - `originalLineup` is set to the saved lineup and a toast appears.
   - `loadProgramming(id, date, keepSelection=true)` re-reads programming, which triggers `loadGuide`.
   - The channel list is refreshed (`tunarrApi.channels()`).
4. **On failure:** a toast reads "Not saved: …" and the edits stay dirty.

### Error propagation

`lib/tunarrClient.ts` `request()` behaviour:

- **Network failure** → `TunarrApiError(0, 'companion_unreachable')`.
- **Non-JSON body** → `companion_unavailable`.
- **Non-2xx** → error code, message and `tunarrHost` taken from the body.

In `page.tsx`:

- `noteFailure` switches `connection` to `unreachable` for `tunarr_unreachable`, `tunarr_timeout` and `companion_unreachable`. It never changes `mode`.
- Channel and programming errors render in the timeline's empty state with **Try again** (`retry`).
- Guide errors render as a `sourceNote` and fall back to the projection.

### Display helpers (module scope in `page.tsx`)

- **`getProgram`:** unwraps `programs[id].program` if present, or uses the entry itself.
- **`programTitle` / `programDetail`:** format episodes, tracks, movies and non-content types.
- **`programArtwork`:** returns only `data:image/` URLs.
- **Also:** `connectionLabel`, `artTone`, and date and time formatters built on `Intl.DateTimeFormat('en', …)`, using the browser's local time zone.

## 8. External integrations

- **Tunarr HTTP API** is the only integration. The proxy calls four upstream endpoints (`/api/channels`, `/api/channels/:id/programming` GET/POST, `/api/channels/:id/lineup`).
  - Payload types are defined loosely in `lib/lineup.ts` with index signatures, so unknown fields pass through.
  - There is no version negotiation.
  - The `lineup` endpoint receives `from`/`to` as UTC ISO strings.
- **OpenAI Sites** (hosted deployment): only the build-time plugin and `.openai/hosting.json` are in the repo. The deployment pipeline isn't, so how and when hosted deploys happen can't be determined. `app/layout.tsx` defaults `metadataBase` to `https://tunarr-lineup.acroix.chatgpt.site` unless `NEXT_PUBLIC_SITE_URL` is set.
- **Google Fonts** via `next/font/google` (Geist, Geist Mono): hosted only, self-hosted by Vinext into `.vinext/fonts/`. The CSS font stack prefers Geneva/Charcoal/Chicago before the Geist variable.

## 9. Persistence

- **Lineup stores nothing.** All durable data lives in Tunarr. The companion is stateless.
- **The browser** uses no `localStorage`, `sessionStorage` or IndexedDB.
- **Demo changes** live only in React state.
- **Hosted bindings:** `.openai/hosting.json` declares no D1 or R2, and `vite.config.ts` passes empty binding lists when those are `null`.

## 10. Authentication

None in the app, the companion or the proxy. The proxy forwards optional basic
auth to Tunarr only when it is embedded in `TUNARR_URL`. Cross-site writes are
mitigated by the Origin check and the JSON content-type requirement, which
forces a CORS preflight the server never approves. Network exposure of the
companion is up to the operator (`docker-compose.example.yml` comments).

## 11. Environment configuration

| Variable | Read by | Purpose |
| --- | --- | --- |
| `TUNARR_URL` | `server/tunarrProxy.ts` via `server/main.ts` and `vite.local.config.ts` | Upstream Tunarr base URL (server-side only) |
| `TUNARR_TIMEOUT_MS`, `TUNARR_SAVE_TIMEOUT_MS` | `createProxyConfig` | Upstream timeouts |
| `PORT` (3000), `HOST` (`0.0.0.0`) | `server/main.ts` | Listen address |
| `STATIC_DIR` | `server/main.ts` | Override UI directory (default `../dist-local` relative to `dist-server/`) |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx` | Hosted `metadataBase` |
| `CODEX_SANDBOX` | `vite.config.ts` | Enables polling file-watch under Codex's seatbelt sandbox |
| `WRANGLER_WRITE_LOGS`, `WRANGLER_LOG_PATH`, `MINIFLARE_REGISTRY_PATH` | `vite.config.ts` | Defaulted to project-local values for Wrangler and Miniflare |

The companion client bundle exposes only variables prefixed `LINEUP_PUBLIC_`
(`envPrefix` in `vite.local.config.ts`); none are currently used. `.env*`
files are git-ignored and excluded from the Docker context.

## 12. Build and deployment

- **Companion Docker image** (`Dockerfile`):
  1. The `node:22-alpine` build stage runs `npm ci --ignore-scripts` and `npm run build:local`.
  2. The runtime stage copies only `dist-server/` and `dist-local/`, writes a minimal `{"type":"module"}` `package.json`, and runs as `USER node`.
  3. It exposes 3000, has a `HEALTHCHECK` that fetches `/healthz`, and starts with `CMD node dist-server/main.js`.

  There is no `TUNARR_URL` in the image.
- **`docker-compose.example.yml`:** runs `tunarr` (`chrisbenincasa/tunarr:latest`, port 8000, volume `./tunarr-data:/config/tunarr`) and `lineup` (`build: .`, `TUNARR_URL=http://tunarr:8000`, port 3000) on a shared `tunarr` network. Comments note that the Tunarr image is amd64-only and suggest binding Lineup to `127.0.0.1`.
- **Hosted:** `vinext build` with the `cloudflare()` and `sites()` plugins. The output is `dist/client` (static, with an `_headers` file for immutable `/_next/static/*`), `dist/server` (worker bundle plus generated `wrangler.json`) and `dist/.openai/hosting.json`. The commits in git history are authored by "Codex Sites <sites@openai.com>".
- **CI:** none in the repository (there is no `.github/` or other pipeline config).

## 13. Testing

`vitest.config.ts` uses the React plugin, includes `tests/**/*.test.{ts,tsx}`,
and defaults to the `node` environment. `tests/page.test.tsx` opts into
`jsdom` with a docblock.

- **`tests/tunarrProxy.test.ts`** calls `handleTunarrApi` directly with an injected `fetchImpl`. It covers:
  - routing, the allowlist, channel-ID validation and query validation
  - timeouts, unreachable hosts, upstream error mapping and redirects
  - credential handling and base paths
  - save validation and the Origin check

  An **over real HTTP** block starts a fake Tunarr and the adapter on ephemeral ports to prove cookie and authorization headers are stripped and oversized bodies get a 413.
- **`tests/lineup.test.ts`** covers the pure functions: reorder, save payload preservation for each item type (`fixtures.mixedLineup()`), schedule detection, guide mapping, drift, stale guides and merging.
- **`tests/page.test.tsx`** renders `Home` in jsdom with `fetch` stubbed by `fakeCompanion()`, a stateful fake of `/api/tunarr/*`. It covers:
  - live loading, date navigation, reorder → save → re-fetch, and undo
  - the generated-schedule warning, save failures and the unsaved-changes guard
  - the no-silent-demo-fallback cases
- **`tests/fixtures.ts`**: `mixedLineup()`, `mixedPrograms()` and `guideFor()`, which builds a Tunarr-like guide from a lineup.

There are no end-to-end tests against a real Tunarr or a real browser in the repo.

## 14. Cross-cutting patterns

- **Pure core, thin shells:** domain logic in `lib/lineup.ts`; proxy logic in `server/tunarrProxy.ts` with no Node HTTP types; adapters (`nodeAdapter.ts`, the Vite middleware, `main.ts`) stay thin.
- **Validate, then call:** every proxy input is checked before any network I/O, and errors are normalized to `{error:{code,message}}`.
- **Pass-through data:** Tunarr payloads are typed with index signatures and forwarded or saved unchanged.
- **Stale-request guards:** request counters in refs (`programmingRequest`, `guideRequest`).
- **Honest UI state:** explicit loading, empty, error and source notes; the connection status reflects failures; there's no implicit mode switching.
- **Styling:** one global stylesheet with BEM-less semantic class names (`.channel`, `.program`, `.inspector`, `.modal`…).
  - Window titles come from CSS `content:` (for example `.workspace:before` "Tunarr Lineup — Programming", `.modal:before` "Dialog").
  - Sizes are in `rem`, scaled by `html { font-size: clamp(16px, 1.25vw, 32px) }`; 1px hairlines stay in `px`.
  - Breakpoints are at `max-width: 1180px` (floating inspector) and `760px` (stacked mobile layout).
