# Architecture

This document describes the architecture that exists in the repository. File
paths are relative to the repo root; `Symbol` names refer to exports or
functions in those files. Where something could not be determined from the
repository, it says so.

## 1. Overview

```
                          ┌──────────────────────── Local companion (real use) ───────────────────────┐
 Browser (React SPA) ───▶ │ server/main.ts → server/app.ts  (node:http, port 3000)                     │
  app/page.tsx            │   ├─ /healthz (always open)                                                │
  lib/tunarrClient.ts     │   ├─ optional Basic sign-in (server/auth.ts, LINEUP_PASSWORD)              │
  (same-origin fetch,     │   ├─ /api/tunarr/*  → server/nodeAdapter.ts → server/tunarrProxy.ts ──────┼──▶ Tunarr (TUNARR_URL)
   <img> artwork)         │   └─ static files from dist-local/ (Vite build of local/ + app/page.tsx)   │     /api/channels
                          └────────────────────────────────────────────────────────────────────────────┘     /api/channels/:id/programming
                                                                                                             /api/channels/:id/lineup
                                                                                                             /api/channels/:id/schedule
                                                                                                             /api/channels/:id/schedule-slots | schedule-time-slots
                          ┌───────────── Hosted preview (Cloudflare Workers, demo-only) ──────────────┐     /api/programs/:id/artwork/:type
 Browser ───────────────▶ │ Vinext app router: app/layout.tsx + app/page.tsx                           │
                          │ No /api/tunarr routes, so /api/tunarr/health → 404 HTML → "unavailable"     │
                          └────────────────────────────────────────────────────────────────────────────┘
```

One UI component (`app/page.tsx`, default export `Home`, plus
`app/components/*`) is shared by both targets. All Tunarr I/O in the browser
goes to same-origin `/api/tunarr/*` paths: JSON through `lib/tunarrClient.ts`
and artwork through `<img src>` built by `programArtwork`. Only the companion
server implements those paths.

## 2. Repository layout

| Path | Role |
| --- | --- |
| `app/page.tsx` | Main UI: state, data loading, editing commands, keyboard/remote handling, rendering, dialogs. `'use client'` component `Home` plus the local `ArtTile`, `ChannelLogo` and `LengthEditor`, and `loadSeasons`. |
| `app/components/MenuBar.tsx` | Pull-down menu bar (`MenuBar`, types `Menu`, `MenuItem`) with mouse and keyboard handling. |
| `app/components/ScheduleEditor.tsx` | Slot-schedule editor for random- and time-slot channels (source, weight, cooldown, length, order, start time; duplicate/remove/reorder/shift; per-slot seasons, direction, linked slots and commercials). Displays and edits a draft; the page owns the state. |
| `app/components/LibraryBrowser.tsx` | Library browser (`LibraryBrowser`, `LibraryPick`): source/library pickers, search, show → season → episode navigation, **Add** / **Add all** into a basket that lists every pick. Listings of up to 1,000 items are loaded whole (100 per request) and then ordered and searched in the browser (`sortLibraryItems`, `findLibraryItems`, `defaultLibrarySort` in `lib/library.ts`): episode-number order from the first number in each title, natural title order, or release date; search ignores accents, and a number in the search must be a number of the title. Bigger listings page through Tunarr's search. Modes: `programs`, `show`, `movies`. |
| `app/components/InsertDialog.tsx` | Insert programs (via the browser), commercial break, flex or redirect, before or after the selection or at a date and time; shows when the items will start. |
| `app/components/ListsManager.tsx` | Filler-list and custom-show manager (create, rename, delete, edit contents through `LibraryBrowser`). |
| `app/components/ChannelSettingsDialog.tsx` | Channel settings in tabs: General (name, number, group, guide flex title, guide minimum, start time, hidden, on demand), Logo & watermark (logo address and corner, watermark, offline screen), Streaming (stream mode, transcode profile, subtitles), Commercials (filler collections, cooldown, overlay). |
| `app/components/NewChannelDialog.tsx` | New or duplicated channel: name, number (next free by default), group, transcode profile or channel to copy. |
| `app/components/SmartCollectionsManager.tsx` | Smart collections: rule rows (`RULE_FIELDS`), match all/any, keywords, preview count and sample, create, edit, delete. |
| `app/components/MediaSourcesDialog.tsx` | Media sources: libraries with on/off switches, refresh, scan, remove; add Plex, Jellyfin, Emby or local folders. |
| `app/components/FillerFoldersDialog.tsx` | Filler folders: upload, move and delete files in the media folder's role folders; shows what Lineup follows in Tunarr, adds folders with a role, and runs the automatic pickup every 8 s while open. `app/useFillerSpots.ts` runs it once when the desk loads. |
| `app/components/TranscodeProfilesDialog.tsx` | Transcode profiles: edit the allowlisted fields, duplicate, delete. |
| `app/components/TemplatesDialog.tsx` | Programming templates: gallery (groups by country, search, My templates), the AI panel, day plan (`DayGrid`), role sources (defaults, suggested smart collections with match counts, library shows), commercials/promos lists, target channel, save/edit/delete/duplicate. |
| `app/components/TemplateEditor.tsx` | Template editor: details, day plan mode, blocks (start, role, ad level), roles (label, hint, order, suggestion kind and genres), start-time grid, lateness, commercial style. |
| `app/components/EventDialog.tsx` | Schedule an event on a date: programs, simulcast (redirect) or off-air; snap and replace/push; live placement preview. |
| `app/components/MoveDialog.tsx` | The "Move or swap" dialog: move to time (with preview), move to position, and a searchable candidate list capped at `MAX_CANDIDATES` (200). |
| `app/layout.tsx` | Hosted-only root layout: Geist fonts (`next/font/google`), metadata, OpenGraph. Not used by the companion build. |
| `app/globals.css` | All styling (Mac OS 9 theme, rem-based scaling, responsive rules). Imports Tailwind. |
| `lib/lineup.ts` | Domain types and schedule math: projection, guide mapping, `scheduleForDay`, `reorderLineup`, `buildManualSave`. |
| `lib/broadcast.ts` | Programming-desk helpers: timecode, block moves, move-to-position and move-to-time, change tracking, day totals, on-air lookup, CSV. |
| `lib/history.ts` | Undo/redo stack of whole-lineup snapshots (`record`, `undo`, `redo`, `MAX_HISTORY` = 200), plus `itemIdentity` and `rebaseHistory` for carrying history across a save. |
| `lib/draftStore.ts` | Persistent per-channel drafts: `encodeDraft` / `decodeDraft` (lineup states as index arrays into the loaded lineup), `createDraftStore` (IndexedDB `tunarr-lineup/drafts`, in-memory fallback, at most `MAX_DRAFTS` = 60), shared via `draftStore()`. |
| `lib/schedule.ts` | Slot-editing helpers: `sourceOptions`, `slotLabel`, `changeSlotSource`, `duplicateSlot`, `newSlotId` (v4 via `getRandomValues`), `shiftTimeSlots`, `slotProblems` (including link-group checks), clock conversions, drafts and conversion, linked slots (`linkGroups`, `linkCandidates`, `linkSlot`), season filters (`seasonSummary`, `setSeasons`), and types `Slot`, `SlotSchedule`, `SchedulePreview`. |
| `lib/library.ts` | Library and setup types (`MediaSource`, `LibraryItem`, `ContentProgram`, `ListSummary`, `ChannelSettings`, `TranscodeProfile`, `ManagedSource`, `NewMediaSource`, `SmartCollectionView`) and helpers (`topLevelType`, `childType`, `toContentProgram`, `lineupEntry`, `itemLabel`, `seasonsFromEpisodes`). |
| `lib/templates.ts` | Template building blocks: role `preset`s, `AD_STYLES` by market, `GENERAL_TEMPLATES`, `templateToDraft` (with per-block ad levels via `midRollFor`), `weekGrid`/`dayRows` (Sunday is day 0; single-weekday overrides), `daySegments`, `roleUsage`, `scheduleToTemplate`, `blankTemplate`, `defaultSource`. |
| `lib/networkTemplates.ts` | Network-inspired templates for Japan, Argentina, the United States, Canada, Spain, the United Kingdom and Italy, including music-channel formats (`NETWORK_TEMPLATES`, `REGIONS`). |
| `lib/templateCatalog.ts` | `BUILT_IN_TEMPLATES`, gallery groups (`TEMPLATE_GROUPS`, `inGroup`) and search. |
| `lib/events.ts` | `boundaryAt` (the insert position nearest a time, on the lengthened cycle), `insertedStart`, `passesBefore`, `placeEvent` (snap to a program boundary; replace with flex padding, or push), `repeatLabel` and `airTimeLabel`. |
| `lib/programInfo.ts` | `getProgram`, `programTitle`, `programDetail`, `programArtwork`, `channelLogoUrl`. |
| `lib/tunarrClient.ts` | Browser client for `/api/tunarr/*`: `checkHealth`, `tunarrApi`, `TunarrApiError`, `ConnectionState`. |
| `lib/demoData.ts` | Demo channels and lineup (`demoChannels`, `demoProgramming()`, `demoDate`). |
| `local/index.html`, `local/main.tsx` | Companion SPA entry: renders `<Home />` into `#root` under `StrictMode` and imports `app/globals.css`. |
| `server/tunarrProxy.ts` | Framework-free proxy and validation: `handleTunarrApi`, `createProxyConfig`, `parseTunarrUrl`, validators, artwork passthrough. |
| `server/nodeAdapter.ts` | Adapts Node `IncomingMessage`/`ServerResponse` to `handleTunarrApi` (`handleNodeApiRequest`, `isTunarrApiPath`). |
| `server/slotSchedule.ts` | Slot-schedule rules: `buildSchedule` (create, convert or edit; per-type settings allowlist; slot, filler and mid-roll validation; materialized fields stripped), `defaultSchedule`, `programPool` (port of Tunarr's `lineupItemAppearsInSchedule`, plus extra programs), `validateExtraPrograms`, `slotSourceKey`, `validateSeed`. Pure, so `lib/` imports it too. |
| `server/admin.ts` | Tunarr setup routes: `matchAdminRoute`, `handleAdminRoute`, `newChannel`, `validateChannelCreate`, `TRANSCODE_FIELDS`, `validateTranscodeChanges`, `manageableSources`, `validateMediaSourceAdd`, `validateSmartCollection`. |
| `server/templateSchema.ts` | Template types and `validateTemplate` (ids, names, roles and suggestions, day plans, ad style, pad/lateness, role defaults reduced to plain source fields). Pure; the browser imports it. |
| `server/templateStore.ts` | Saved templates in `LINEUP_DATA_DIR/templates.json`: serialized, atomic writes; unreadable files are reported, never overwritten. |
| `server/lineupRoutes.ts` | Lineup's own routes: `/templates`, `/filler-roles`, `/media-folder` and `/ai` (`matchLineupRoute`, `handleLineupRoute`). |
| `server/mediaFolder.ts` | The media folder (`LINEUP_MEDIA_DIR`): role subfolders, safe file names (`mediaFileName`), streamed uploads that never overwrite, move and delete. Node built-ins. |
| `server/jsonFile.ts` | One JSON file in `LINEUP_DATA_DIR`: serialized, atomic writes; a file that can't be parsed is reported, never overwritten. Used by both stores. |
| `server/fillerRoles.ts` / `server/fillerRoleStore.ts` | Filler-list roles (`station-id`, `commercials`, `promos`, `bumpers`, `other`) and their store, `LINEUP_DATA_DIR/filler-roles.json`, which also keeps the folder (library) each folder-built list follows, folders waiting for their first list, and libraries never to pick up again. |
| `lib/fillerRoles.ts` | Role labels, `guessRole` from list names, `spotLength` (`:30`), `spotBreakdown`. |
| `lib/airKinds.ts` | Station-log view: `airKind` per row, `hourSummaries`, `stripSegments`, `estimateBreakFill` (labeled estimate). Station-ID edits (`pickStationId`, `makeBreakWithId`, `openBreaksWithIds`) are in `lib/broadcast.ts`. |
| `app/useFillerSpots.ts` | Loads filler lists, roles and list programs for the day view (spot index, station IDs, break rundowns). |
| `server/ai.ts` | AI assistant: `createAiConfig` (`LINEUP_AI_*`), `gatherContext` (library, lists, channel summary from Tunarr), `SYSTEM_PROMPT`, `PROPOSAL_SCHEMA`, `callModel` (Anthropic Messages with a forced tool, or OpenAI-compatible function calling with a JSON-text fallback), `resolveProposal`. |
| `server/smartCollection.ts` | Smart-collection rules ↔ Tunarr search filters: `RULE_FIELDS`, `rulesToFilter`, `filterToRules`, `describeRules`. Pure; the browser imports it. |
| `server/logos.ts` | Channel logos: `channelLogo`, `logoSource`, `fetchPublicImage`, `isPublicAddress`, in-memory cache. Uses Node built-ins. |
| `server/content.ts` | Library, list and channel-settings routes: `matchContentRoute`, `handleContentRoute`, `sanitizeMediaSources`, `buildLibrarySearch`, `validateFillerListBody`, `validateCustomShowBody`, `channelSettings`, `validateChannelSettings`. |
| `server/upstream.ts` | Shared upstream plumbing: `fetchUpstream`, `callTunarr` (GET/POST/PUT/DELETE), `UpstreamError`, `json`, `fail`. |
| `server/lineupVersion.ts` | `programmingVersion(lineup, schedule)`: a non-cryptographic fingerprint (two cyrb53 hashes plus length), shared by the browser and the proxy for `If-Match`. |
| `server/auth.ts` | Optional HTTP Basic sign-in: `createAuthConfig`, `isAuthorized`, `AUTH_CHALLENGE`. |
| `server/app.ts` | `createLineupServer({ config, auth, staticRoot, hosts })`: request routing, static files, SPA fallback, security headers. |
| `server/hosts.ts` | Host-name check against DNS rebinding: `createHostPolicy` (`LINEUP_ALLOWED_HOSTS`), `isAllowedHost`, `hostRefusal`. |
| `server/main.ts` | Process entry: reads env, creates the server, listens, logs, handles SIGTERM/SIGINT. |
| `server/tsconfig.json` | Compiles `server/*.ts` (excluding tests) to `dist-server/` (NodeNext ESM). |
| `vite.config.ts` | Hosted build/dev: `vinext()` and `cloudflare()` plugins. |
| `vite.local.config.ts` | Companion build/dev: React plugin, Tailwind PostCSS, and dev middleware for sign-in and `/api/tunarr`. |
| `vitest.config.ts` | Unit/UI tests (`tests/**/*.test.{ts,tsx}`, default env `node`). |
| `playwright.config.ts`, `e2e/` | End-to-end suite: `e2e/desk.spec.ts` (TV) and `e2e/responsive.spec.ts` (phone, tablet, laptop, ultrawide) against the built companion and `e2e/fake-tunarr.mjs`. |
| `.github/workflows/ci.yml` | CI: lint, typecheck, unit tests, both builds, e2e, Docker build plus healthcheck. |
| `.github/workflows/release.yml` | On a published GitHub release: builds the image for amd64 and arm64, pushes it to `ghcr.io/<owner>/<repo>` (version, major.minor, `latest`), and checks its healthcheck. |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml` | Companion container and an example stack alongside Tunarr. |
| `public/` | `favicon.svg`, `og.png`. Served by both targets. |
| Generated (do not edit) | `dist/`, `dist-local/`, `dist-server/`, `.next/types/`, `.vinext/`, `.wrangler/`, `next-env.d.ts`, `test-results/`, `playwright-report/`. |

## 3. Frameworks and major dependencies

From `package.json` (Node `>=22.13.0`, `"type": "module"`):

- **React 19** is the only UI library. There is no state library and no router.
- **Next 16 / Vinext 1** are used only for the hosted target. The companion bundle uses no Next APIs.
- **Vite 8** runs both builds. **`@vitejs/plugin-react`** is used by the companion build and the tests.
- **`@cloudflare/vite-plugin`, `wrangler` and `@cloudflare/workers-types`** support the hosted build's Workers-style runtime.
- **Tailwind CSS 4** is imported, but only the `antialiased` utility is used.
- **Testing:** `vitest` 4, `jsdom`, `@testing-library/react` / `dom`, and `@playwright/test` for end-to-end tests.
- **Lint:** `eslint` 9 with `eslint-config-next`, which includes the React Compiler hook rules.
- **The companion server has no runtime dependencies.** It uses only `node:http`, `node:fs`, `node:path`, `node:url`, `node:crypto` and global `fetch`.

## 4. Entry points

| Target | Command | Entry |
| --- | --- | --- |
| Companion dev | `npm run dev:local` | `vite.local.config.ts` (root `local/`), with plugin `tunarrApi()` for sign-in and the proxy |
| Companion build | `npm run build:local` | `vite build` → `dist-local/`; `tsc -p server/tsconfig.json` → `dist-server/` |
| Companion run | `npm run start:local` / Docker `CMD` | `node dist-server/main.js` |
| Hosted | `npm run dev` / `build` / `start` | `vinext dev` / `vinext build` / `vinext start` |
| Unit/UI tests | `npm test` | `vitest run` |
| End-to-end | `npm run test:e2e` | `playwright test`. Starts `e2e/fake-tunarr.mjs` (port 18000) and `dist-server/main.js` (port 13000) |

## 5. Routing

**Client:** no client-side routing. `Home` is a single screen. The connection,
confirm, move, shortcuts and about dialogs are conditional overlays.

**Hosted (Vinext):** only the `/` route exists, with no route handlers.
`/api/tunarr/health` returns a 404 HTML page. This was verified with `vinext dev`;
a deployed Worker was not verified.

**Companion server** (`createLineupServer` in `server/app.ts`) evaluates each request in this order:

1. **`/healthz`** → `200 {"status":"ok"}`. Liveness only; it doesn't check Tunarr. Always unauthenticated, for the Docker `HEALTHCHECK`.
2. **Without sign-in, `isAllowedHost(req.headers.host, hosts)`** fails → `403` (plain text naming `LINEUP_ALLOWED_HOSTS`). IP addresses, `localhost` and `*.localhost` always pass. See §10.
3. **`isAuthorized(req.headers.authorization, auth)`** fails → `401` with `WWW-Authenticate: Basic`. This applies only when `LINEUP_PASSWORD` is set.
4. **`isTunarrApiPath`** → `handleNodeApiRequest`.
5. **Methods other than GET/HEAD** → `405`.
6. **An existing file** under `staticRoot` → served. `resolveStatic` rejects path traversal. `/assets/*` is cached `immutable`; everything else is `no-cache`.
7. **A missing path with a file extension** → `404`. **Anything else** → `index.html` (SPA fallback).

Static responses carry `securityHeaders`, including CSP `default-src 'self'`,
`connect-src 'self'`, `img-src 'self' data:` and `frame-ancestors 'none'`.

The Vite dev middleware in `vite.local.config.ts` applies the same host and
sign-in checks to every request, including `/healthz`, before handling
`/api/tunarr` (plugin middleware runs before Vite's own `allowedHosts` check,
which is set to the same rule for the page itself).

## 6. The Tunarr proxy (`server/tunarrProxy.ts`)

### Configuration

`createProxyConfig(env)` builds a `ProxyConfig`:

- **`TUNARR_URL`** is parsed by `parseTunarrUrl` into `origin`, `basePath`, `host` and an optional `authorization`. Userinfo becomes a Basic header and never appears in `host`. Missing → `target: null`; invalid → `configError` (fixed text, never echoing the value).
- **`TUNARR_TIMEOUT_MS`** defaults to 10000 and **`TUNARR_SAVE_TIMEOUT_MS`** to 30000.
- **`externalLogos`** comes from `LINEUP_EXTERNAL_LOGOS` (anything but `false` turns it on).
- **`fetchImpl`** and **`fetchExternalImage`** are optional overrides for tests.

### Allowed routes (`matchRoute`)

| Route | Methods | Upstream |
| --- | --- | --- |
| `/api/tunarr/health` | GET | `GET /api/channels`. Responds `{status:'connected', tunarrHost, channelCount}` |
| `/api/tunarr/channels` | GET | `GET /api/channels` (must be an array) |
| `/api/tunarr/channels/:id/programming` | GET, POST | `GET` / `POST /api/channels/:id/programming` |
| `/api/tunarr/channels/:id/lineup` | GET | `GET /api/channels/:id/lineup?from=&to=` |
| `/api/tunarr/channels/:id/schedule` | GET | `GET /api/channels/:id/schedule` (materialized: slots carry show, custom-show, channel and list names) |
| `/api/tunarr/channels/:id/schedule-preview` | POST | `GET …/programming`, then `POST /api/channels/:id/schedule-slots` (random) or `/schedule-time-slots` (time) with the merged schedule. Generates only; saves nothing |
| `/api/tunarr/programs/:id/artwork/:type` | GET | `GET /api/programs/:id/artwork/:type?fallbackArtworkTypes=<other types>` |
| `/api/tunarr/channels/:id/logo` | GET | `GET /api/channels/:id`, then the logo (see *Channel logos* below). Only a `v` query parameter (cache buster, `[a-z0-9]{0,16}`) is accepted. `204` when there is no usable logo |

### Request pipeline (`handleTunarrApi`)

1. **Path:** parsed with `new URL(...)`, which normalizes `..`. No route match → `404 route_not_allowed`.
2. **Parameters:**
   - Channel `:id` must match `CHANNEL_ID`, or the response is `400 invalid_channel_id`.
   - Artwork `:id` must be a UUID (`PROGRAM_ID`) and `:type` must be in `ARTWORK_TYPES` (`poster`, `thumbnail`, `landscape`, `banner`), or the response is `400 invalid_parameter`.
3. **Method:** not allowed → `405 method_not_allowed` with an `allow` header.
4. **Origin:** `isCrossOrigin` → `403 cross_origin_blocked`.
5. **Query:** `lineup` must pass `validateLineupRange` (ISO date-times, `to > from`, at most 14 days, normalized to UTC). Every other route rejects any query (`400 invalid_query`).
6. **POST body:**
   - Must be `application/json` (else `415`) and valid JSON (else `400 invalid_json`).
   - **`programming` with `type: 'manual'`:** `validateManualProgramming` checks `append` false or absent, `keepOnAir` true/false or absent, and each item's type, positive duration and ids.
   - **`programming` with `type: 'time' | 'random'`:** `{ schedule: { slots, timeZoneOffset? }, seed?, discardCount? }`, with the seed checked by `validateSeed`.
   - **Both programming saves** require `If-Match` (`parseIfMatch`), else `428 precondition_required`.
   - **`schedule-preview`:** the body is `{ slots, timeZoneOffset? }`.
7. **No target:** `503` (`not_configured` or `invalid_config`). Health uses `{status:'not_configured', error}`.
8. **Upstream call:** `fetchUpstream`, shared by `callTunarr` (JSON) and `fetchArtwork` (images).

### Conditional writes and slot schedules

`POST …/programming` runs inside `withChannelLock(channelId)`, a promise chain
per channel within this process:

1. **Version check.** `GET` the channel's programming and compute `programmingVersion(lineup, schedule)`. If it differs from `If-Match`, the response is `412 lineup_changed` and nothing is posted.
2. **Manual saves.** `POST {type:'manual', lineup, append:false}` with the items unchanged.
   - **`keepOnAir: true`** ("Keep what's on air in place") is Lineup's flag and is never forwarded. Refused with `400` on a channel with a slot `schedule`, because a start-time change regenerates it. After the lineup is saved, the proxy `GET`s `/api/channels/:id`, computes `keptStartTime(startTime, old length, new length, now)` (`server/lineupVersion.ts`: every pass before now grew or shrank by the same amount, so the start moves the other way by that many times), and `PUT`s Tunarr's copy of the channel with only `startTime` changed (read-only fields removed, as for channel settings). The reply adds `startTime`. If that step fails, the lineup stays saved and the reply carries `startTimeError` instead. The browser shows that message.
3. **Schedule saves.**
   - The requested type must match the current `schedule.type`, else `409 schedule_type_mismatch`.
   - `buildEditedSchedule(current.schedule, edit)` validates the slots and returns Tunarr's current schedule with only `slots` replaced (plus `timeZoneOffset` if it's a valid offset). Errors give `400 invalid_schedule`.
   - The program list is computed server-side with `programPool(slots, current.lineup, current.programs, extraPrograms)`: content and custom items already in the lineup that some slot draws from, plus validated extra program ids (for example movies for a movie slot).
   - The proxy then posts `{type, schedule, programs, seed, discardCount}`.

Guarantees:
- **Between Lineup sessions,** the lock makes check-then-write atomic. Tested: two concurrent saves leave the second with a 412.
- **Against Tunarr's own UI,** a write landing between the GET and the POST is not detected, because Tunarr's API has no conditional write.

`buildSchedule` starts from the channel's current schedule when the type is
unchanged, so fields Lineup doesn't edit (such as iteration groups and
per-slot overrides) are kept. When creating or converting, it starts from
`defaultSchedule(type)`, which uses Tunarr's editor defaults. Settings are
limited to a per-type allowlist. Tunarr's generator draws a slot's programs
from its source (for example, all of a show's episodes in the library) plus the
program pool.

### Upstream call (`fetchUpstream`)

- **Headers:** only `accept` (`application/json` or `image/*`), `content-type` for POST, and the configured `authorization`. No browser headers are forwarded; `nodeAdapter` passes only `host`, `origin`, `x-forwarded-host` and `content-type` into the handler, and only for checks.
- **Request options:** `redirect: 'manual'` and `AbortSignal.timeout`, which covers the body as well.

| Condition | Status | Code |
| --- | --- | --- |
| Timeout | 504 | `tunarr_timeout` |
| Network failure | 502 | `tunarr_unreachable` (host plus optional `cause.code`) |
| 3xx | 502 | `tunarr_redirect` |
| 404 | 404 | `not_found` |
| 400 | 400 | `tunarr_rejected` (upstream message, at most 300 chars) |
| 401/403 | 502 | `tunarr_auth` |
| Other non-2xx | 502 | `tunarr_error` |
| JSON route, non-JSON body | 502 | `tunarr_invalid_response` |
| Artwork that isn't `image/(jpeg\|png\|webp\|gif\|avif)` | 502 | `tunarr_invalid_response` |
| Artwork larger than `MAX_ARTWORK_BYTES` (8 MiB) | 502 | `artwork_too_large` |
| Unexpected exception | 500 | `internal_error` |

**Response formats:**
- **JSON:** `cache-control: no-store`.
- **Artwork:** raw bytes (`ProxyResponse.body` is `Uint8Array`) with the upstream image type, `cache-control: private, max-age=86400`, `nosniff`, and `content-security-policy: default-src 'none'; sandbox`.
- **Errors:** `{ "error": { "code", "message", "tunarrHost"? } }`.

`nodeAdapter.send` writes string or byte bodies with `content-length`. POST
bodies are capped at `MAX_BODY_BYTES` (20 MiB, else `413`).

### Library, lists and channel settings (`server/content.ts`)

`handleTunarrApi` first tries `matchContentRoute` on the path below
`/api/tunarr`. Matching routes get the same method allowlist, Origin check,
no-query rule and JSON body parsing, then `handleContentRoute`.

| Route | Methods | Upstream and rules |
| --- | --- | --- |
| `/media-sources` | GET | `GET /api/media-sources` → `sanitizeMediaSources` (id, name, type, mediaType, enabled libraries; `uri`, `username`, `userId` and `clientIdentifier` are dropped) |
| `/library/search` | POST | `buildLibrarySearch` validates `{ mediaSourceId, libraryId?, text?, type?, parentId?, page?, limit? }` (UUIDs, `type` in `SEARCH_TYPES`, limit ≤ 100). It builds Tunarr's `type =` / `parent.id =` filter itself, and converts Lineup's 0-based page to Tunarr's 1-based page for free-text queries (`SearchProgramsCommand`). |
| `/programs/:id/descendants` | GET | `GET /api/programs/:id/descendants`, capped at `MAX_LIST_ITEMS` |
| `/filler-lists`, `/custom-shows` | GET, POST | List summaries (id, name, count, `synced`); create with `validateFillerListBody` (at least one full content program) or `validateCustomShowBody` (condensed content entries; sync fields null) |
| `/filler-lists/:id`, `/custom-shows/:id` | PUT, DELETE | Update or delete. Custom-show updates re-read the show and re-send its sync settings, because Tunarr clears sync unless `enableSync` is set. |
| `/filler-lists/:id/programs`, `/custom-shows/:id/programs` | GET | Contents |
| `/filler-lists/from-library` | POST | `buildFromLibrary` after `validateFromLibrary`: `{ mediaSourceId, libraryId, name }` creates a list, `{ …, listId }` replaces that list's programs (name kept); optional `role`. Pages `POST /api/programs/search` for the library (100 at a time, up to `MAX_LIST_ITEMS`), keeps playable items as full content programs (`libraryEntries`), then `POST`s or `PUT`s the filler list. Stores the role and the list↔library link in `filler-roles.json`; a store failure comes back as `storeError`, since the list already exists. `409 library_empty` when Tunarr has indexed nothing there yet. |
| `/smart-collections` | GET | `GET /api/smart_collections` → `{ id, name }` |
| `/channels/:id/settings` | GET, PUT | `GET /api/channels/:id` → `channelSettings` (only `CHANNEL_SETTING_FIELDS`). PUT validates with `validateChannelSettings`, then under `withChannelLock` re-reads the channel, merges only the allowed fields, drops read-only fields (`programCount`, `sessions`, `fallback`, `transcoding`), and `PUT`s the whole channel. |

Channel settings fields (`CHANNEL_SETTING_FIELDS`) cover the programming fields
plus `icon` (logo path, corner, width), `watermark`, `offline`, `streamMode`
(`STREAM_MODES`), `transcodeConfigId`, `subtitlesEnabled`, `stealth` and
`onDemand`. Object fields are merged onto Tunarr's current value, and image
addresses must be `http(s)` URLs or Tunarr `/images/…` paths.

`nodeAdapter` reads request bodies for POST and PUT (up to 20 MiB), and sends
`204` responses without a body or `Content-Length`. The one exception is a
media upload (`PUT /api/tunarr/media-folder/:role/:file`): `planUpload` checks
it before any body is read (media folder on, Origin, no query, a valid role and
file name, `application/octet-stream` or `video/*`, a `Content-Length` within
`LINEUP_MEDIA_MAX_MB`, no chunked encoding), then `MediaFolder.save` streams it to
a dot-named temporary file and hard-links it into place (rename after an
existence check on shares without hard links), so nothing is overwritten and a
broken upload leaves nothing behind. Refusals answer with `Connection: close`.
When the media folder is on, the server's `requestTimeout` is 4 hours instead of
Node's 5 minutes so large uploads finish.

### Tunarr setup (`server/admin.ts`)

`handleTunarrApi` tries `matchAdminRoute` before `matchContentRoute`; admin
routes go through the same `handleContent` pipeline (method allowlist, Origin
check, no query, JSON bodies) and then `handleAdminRoute`.

| Route | Methods | Upstream and rules |
| --- | --- | --- |
| `/channels/create` | POST | `validateChannelCreate` (`name`, optional `number`, `groupTitle`, `transcodeConfigId`, `copyFrom`). Refuses a number already in use (409). New channels are `POST /api/channels {type:'new', channel: newChannel(…)}` with Tunarr's web defaults (`web/src/helpers/constants.ts`) and the default transcode profile; copies are `{type:'copy', channelId}` followed, under the channel lock, by a `PUT` that applies the requested name and number. |
| `/channels/:id` | DELETE | `DELETE /api/channels/:id` under the channel lock |
| `/transcode-configs` | GET | `GET /api/transcode_configs` → `transcodeSummary` (the `TRANSCODE_FIELDS` allowlist; VAAPI device and driver are not sent) |
| `/transcode-configs/:id` | PUT, DELETE | PUT validates with `validateTranscodeChanges`, re-reads the profile, merges, and `PUT`s it whole. DELETE refuses the default profile and profiles any channel uses (409). |
| `/transcode-configs/:id/copy` | POST | `POST /api/transcode_configs/:id/copy` |
| `/media-sources/manage` | GET | `manageableSources`: every library with `enabled`, `lastScannedAt`, `isLocked`; no `uri`, `accessToken`, `username`, `userId` or `paths` |
| `/media-sources/add` | POST | `validateMediaSourceAdd`. Plex: `{name, uri, accessToken}`. Jellyfin/Emby: `{name, uri, username, password}` → `POST /api/{jellyfin,emby}/login` (Tunarr signs in; failures become 502 `media_server_login_failed` without upstream detail), then insert with the returned token. Local: `{name, mediaType, paths}` (absolute paths). Then `POST /api/media-sources` and, for remote servers, `…/libraries/refresh`. Returns only `{id}`. |
| `/media-sources/:id` | DELETE | `DELETE /api/media-sources/:id` |
| `/media-sources/:id/refresh` | POST | `POST /api/media-sources/:id/libraries/refresh` |
| `/media-sources/:id/libraries/:libraryId` | PUT | `{enabled}` → `PUT /api/media-sources/:id/libraries/:libraryId` (Tunarr queues a scan when enabling) |
| `/media-sources/:id/libraries/:libraryId/scan` | POST | `POST …/scan?forceScan=true` |
| `/smart-collections/create` | POST | `validateSmartCollection` turns `{name, match, rules, keywords}` into Tunarr's filter tree with `rulesToFilter` (`server/smartCollection.ts`), then `POST /api/smart_collections` |
| `/smart-collections/preview` | POST | Same rules → `POST /api/programs/search` (page 1 with keywords, 0 without; limit 12) → `{totalHits, sample}` |
| `/smart-collections/:id` | GET, PUT, DELETE | GET returns `collectionView`: rules decoded by `filterToRules` (or `null` with Tunarr's `filterString` when the filter uses something the rule editor can't show). PUT refuses removing every rule, because Tunarr's update keeps the old filter when none is sent. |

`server/smartCollection.ts` is pure and shared with the browser: `RULE_FIELDS`
maps rule fields to Tunarr's search keys (`genres.name`, `studio.name`,
`originalReleaseYear`, `duration` in ms for minutes, `addedAt` with a
`relativeDate`…, from `shared/src/util/searchUtil.ts`).

### Lineup's own routes (`server/lineupRoutes.ts`)

`handleTunarrApi` tries `matchLineupRoute` first. These routes use the same
pipeline as the content routes but answer from the companion.

| Route | Methods | Behaviour |
| --- | --- | --- |
| `/templates` | GET, POST | List saved templates; create one (the server assigns a `my-…` id, so a saved template can't shadow a built-in one) after `validateTemplate` |
| `/templates/:id` | PUT, DELETE | Replace or delete a saved template |
| `/filler-roles` | GET | `{ [fillerListId]: role }` from `filler-roles.json` (works without `TUNARR_URL`) |
| `/filler-roles/:id` | PUT, DELETE | Set (`{ role }`, one of `station-id`, `commercials`, `promos`, `bumpers`, `other`) or clear a list's role. `:id` must be a UUID; up to 1,000 entries |
| `/media-folder` | GET | `{ enabled: false, message }`, or `{ enabled, maxBytes, folders: [{ role, folder, files: [{ name, size, modifiedAt }], tunarr }] }`. `tunarr` is the role folder's library (`roleLibraries` matches a local source library's `externalKey` to `LINEUP_MEDIA_TUNARR_DIR/<folder>`), or null; without Tunarr the files still list, with `tunarrError`. Absolute paths are never returned. |
| `/filler-folders` | GET | `{ links, pending, ignored }` from `filler-roles.json` |
| `/filler-folders/sync` | POST | `syncFillerFolders` (one run per server at a time). 1) If no local source reads the media folder's role folders, creates them and adds them as one local source (`Lineup media folder`, `other_videos`); Tunarr scans it on its own. 2) Re-reads every followed list whose library's `lastScannedAt` is newer than the link's `builtAt` and isn't scanning; a list deleted in Tunarr (404) is unfollowed and its library ignored. 3) Makes a list for each enabled, unfollowed, unignored library with a role: an upload role folder (`Station IDs (folder)`), a pending folder (its stored name), or a library whose name passes `folderRole` (whole words of the last path segment). A library found empty is not searched again until its next scan (in memory). Returns `{ connected, created, updated, errors }`. Needs `TUNARR_URL`. |
| `/filler-folders/add` | POST | `{ path, role }`: adds a local source for the folder (checked by `validateMediaSourceAdd`) and records its library as pending, so the next sync after Tunarr's scan makes its list. Needs `TUNARR_URL`. |
| `/media-folder/:role/:file` | DELETE | Deletes the file. Upload (PUT) is handled by `nodeAdapter` (above). `:role` is a filler role; `:file` must pass `mediaFileName` (one segment, video extension, no leading dot or reserved characters) |
| `/media-folder/:role/:file/move` | POST | `{ role }`: moves the file to another role folder without overwriting |
| `/ai` | GET | `{ enabled, provider, model }`, or `{ enabled: false, message }` saying what to set |
| `/ai/template` | POST | `{ prompt (≤ 2000 chars), channelId?, includeLibrary, baseTemplate? }`. `gatherContext` reads smart collections, custom shows and filler lists, and optionally the library (shows and movies via `POST /api/programs/search`, up to 600 and 300) and the channel's programming (a most-aired summary). `callModel` sends `SYSTEM_PROMPT` plus `buildUserMessage`; the model must call `propose_schedule` (`PROPOSAL_SCHEMA`). `resolveProposal` converts blocks, keeps role sources only when the id is in the catalog, drops suggestions `rulesToFilter` rejects, picks lists only from known ids, and validates the result with an `ai-…` id. Provider errors become `ai_auth`, `ai_rate_limited`, `ai_timeout`, `ai_unreachable` or `ai_invalid`. |

### Channel logos (`server/logos.ts`)

`channelLogo` reads the channel's `icon.path` and `logoSource` classifies it:

- **Tunarr-hosted:** a `/images/…` path, or an absolute URL on `TUNARR_URL`'s host, or any URL whose path is `/images/uploads/…`. Tunarr stores uploads under whatever host was used at upload time (`localhost`, `host.docker.internal`, a tailnet name), so the path is fetched from `TUNARR_URL` through `fetchUpstream`. Paths are limited to safe characters and refuse encoded dots and slashes. If Tunarr has no such file and the URL was on another host, that host is tried as a public logo.
- **Public:** any other `http(s)` URL, fetched by `fetchPublicImage` (`node:http(s)`): ports 80/443 only; IP literals and every DNS answer must be public (`isPublicAddress`, a `BlockList` of loopback, private, CGNAT, link-local, documentation, multicast and IPv6 local ranges; IPv4-mapped addresses are unwrapped); the lookup is pinned to the connection; up to 3 redirects, each re-checked; image content types only; 4 MB; 8 s. Off when `externalLogos` is false.
- **Nothing usable** (empty path, other schemes, Tunarr-host paths outside `/images`) → `404 no_logo` inside the module, which the route turns into `204`, so the browser shows the channel number without logging an error.

Results (and misses) are cached in memory per source (1 h, misses 5 min, 400 entries). Responses carry `cache-control: private, max-age=3600`, `nosniff` and a sandbox CSP.

## 7. Client data flow (`app/page.tsx`)

### State

All state is local React state in `Home`. There is no context, store or browser storage.

- **Connection and mode:** `mode` (`'live' | 'demo'`, starting `'live'`) and `connection` (`ConnectionState`).
- **Data:** `channels`, `activeChannelId`, `programming`, `originalLineup` (the saved baseline) and `guide`.
- **Selection and cursor:** `anchorIndex` and `selectedIndex` form a contiguous block (`normalizeBlock`). `cursorStart` records the start time of the focused row, which disambiguates repeats of the same item within a day. The stored selection (`storedSelected`, `storedAnchor`, `storedCursorStart`) only counts while it is a row of the day shown; otherwise the selection is derived (`fallbackRow`) as the row on air, or the day's first lineup row. A channel opens with nothing picked (`-1`), so it opens with what's on air selected. A picked item can also air on another day (on a long cycle, weeks away), and the fallback keeps Insert, Remove and Move on a row you can see.
- **Dialogs for full editing:** `insertOpen`, `libraryPicker` (`{ purpose: 'insert' | 'slot-show' | 'movies', … }`), `listsOpen` (`'filler' | 'custom'`), `settingsOpen`, and `catalog` (custom shows, filler lists, smart collections and channels for slot sources).
- **Editing:**
  - `history` (`lib/history.ts`); `grab` (`{ before, block }` while a block is picked up); `draggedIndex`.
  - `base` (`{ channelId, version, lineup }`): the lineup objects exactly as Tunarr returned them and their version. Every history snapshot is a permutation of `base.lineup`.
  - `draftMarks`: channels with unsaved stored drafts.
  - `slotEditor` (`SlotEditor`): the schedule, draft slots, preview, `previewOf` (the draft JSON the preview was made from), and whether the preview is showing.
- **Time and view:** `now` (ticks every 15 s), `selectedDate`, `search`.
- **Dialogs and status:** `connectionOpen`, `arrangeOpen`, `infoDialog` (`'shortcuts' | 'about'`), `confirmDialog` (with an optional `cancelLabel`), loading and error flags, and `message` (the toast).

Refs:
- `programmingRequest` / `guideRequest` hold request counters that drop stale responses.
- `rowRefs` maps row positions to buttons, using ref cleanup callbacks.
- `focusCursor` asks the next render to focus and scroll the cursor row.
- `scrolledToNow` makes the on-air auto-scroll happen once per channel and day.

Derived values:
- `dirty`, a memoized JSON comparison of the lineup against the baseline, and `changed`, the set of positions that differ (`changedPositions`).
- `daySchedule` (`scheduleForDay`), `visibleInstances`, `cursorPosition`, `selectedInstance`, `onAir` (`onAirPosition`), `totals` (`dayTotals`) and `sourceNote`.

### Startup and loading

Unchanged in shape from the original live flow:

- The mount effect calls `checkHealth()`, which maps the response to `connected`, `not_configured`, `unreachable` or `unavailable`.
- If connected, it loads channels (sorted by number), then `loadProgramming`, then `loadGuide` for the local day.
- `loadProgramming` clears `history` and `grab` (`resetEditing`).
- Once the on-air row renders, the "now" effect scrolls it into view (`scrollIntoView?.()`, which is guarded because some environments lack it).

### Day schedule computation (`lib/lineup.ts`)

- **`instancesForDay`** projects the repeating cycle onto the local day.
- **`instancesFromGuide`** maps guide entries to lineup indices.
  - It matches by position (`lineupIndexAt` and `sameProgram`), then falls back to `nearestById`.
  - Unmatched entries get `lineupIndex -1` and render disabled.
- **`scheduleForDay`** combines the two:
  - Guide rows are used inside the guide window and projected rows outside it.
  - If matched guide time is below half the guide's span, it returns `guideStale` and the projection only.

### Editing commands

Every committed edit goes through `applyEdit(label, next, nextBlock)`. It
records a `HistoryEntry` (lineup before and after, block before and after),
updates `programming.lineup`, and moves the selection and cursor with the
block (`followBlock`, which uses `occurrenceStart`).

| Command | Trigger | Implementation |
| --- | --- | --- |
| Earlier / Later | Inspector buttons, Edit menu | `nudge` → `shiftBlock` |
| Move before | Drag and drop, Move dialog | `moveBefore` → `moveBlock` (a block if the dragged row is in the selection) |
| Swap | Move dialog (single item only) | `swapWith` → `reorderLineup(..., swap)` |
| Move to position | Move dialog | `moveToPosition` → `moveBlockToPosition` |
| Move to time | Move dialog (live preview via `previewTime`) | `moveToTime` → `moveBlockToTime`, which tries every insertion point against the real cycle and returns the exact resulting start |
| Pick up / slide / drop | OK/Enter, ↑/↓, OK/Enter; inspector button; Edit menu | `pickUp` stores `grab`; `slideGrab` → `shiftBlock` without history; `drop` records one entry; `cancelGrab` restores `grab.before` |
| Undo / Redo / Revert all | ⌘Z / ⇧⌘Z / Ctrl+Y, Edit menu, edit list | `undo` / `redo` (`lib/history.ts`); `revertAll` restores the baseline and clears history |
| Insert | `I`, Edit menu, inspector, empty-lineup inspector | `InsertDialog` → `insertAt(where, items, label, meta)` → `insertPoint` (`boundaryAt` for a time, `insertedStart` next to the selection) → `insertItems`; then the desk shows the day the items air and puts the cursor on them. With **Keep what's on air in place** (`keepOnAir`, stored in the draft), the desk projects from `channelStart = keptStartTime(Tunarr's start, base length, draft length, now)` and places inserts with `startWith(added)`, so the preview matches what the save sets. Library programs come from `LibraryBrowser` via `pickFromLibrary` → `lineupEntry`; their metadata is merged into `programming.programs`. Breaks use `makeCommercialBreak` (flex with `fillerConfig`); also `makeFlex` and `makeRedirect`. |
| Remove | `Delete`, Edit menu, inspector | `removeSelection` → `removeBlock` |
| Change length | Inspector `LengthEditor` (flex, breaks, redirects) | `changeLength` → `setItemDuration` (returns a new item object) |

### Keyboard and remote

A `keydown` listener on `window` is re-bound every render so it sees current state.

- **When dialogs are open,** only Escape/Back is handled, and it closes the topmost dialog.
- **Ignored:** events from inputs and other typing targets, events from inside the menubar (`MenuBar` handles its own keys), and events with Alt held.
- **Bindings:**

  | Key | Action |
  | --- | --- |
  | ↑/↓ | Move the cursor; with Shift, extend the block, which stops at a cycle wrap; while grabbing, slide |
  | ←/→ | Change day |
  | PageUp/PageDown, `ChannelUp`/`ChannelDown` | Change channel |
  | Enter or Space on a row or the body | Pick up or drop |
  | Escape, `GoBack`, `BrowserBack` | Cancel a grab, or collapse a block |
  | `n` / `t` / `m` / `?` | Now / today / Move dialog / shortcuts |
  | ⌘ or Ctrl + Z / Shift+Z / Y / S | Undo / redo / redo / save |

`MenuBar` handles arrows to open menus and move through them, Enter to
activate, and Escape/Back to close. Outside clicks close menus.

### Saving (`save` → `performSave`)

1. **Guards.** Demo mode only resets the baseline. In live mode, a non-null `schedule` opens the generated-schedule confirmation (`scheduleSummary`).
2. **Write.** `buildManualSave`, then `tunarrApi.saveProgramming(id, request, base.version)`, which sends `If-Match`.
3. **Conflict.** A 412 shows "This channel changed in Tunarr" (`showConflict`): **Reload from Tunarr** deletes the stored draft and reloads; **Keep my edits** keeps the draft.
4. **Re-read.** `loadProgramming(id, date, { keepSelection, rebase: { saved: request.lineup, history } })` re-reads programming, then `rebaseHistory` maps every snapshot onto the fresh objects (position by position, checked with `itemIdentity`). If the lineups don't line up, for example because zero-length items were dropped, the edit list starts fresh with a notice.
5. **Failure.** A "Not saved: …" toast; edits are kept.

### Drafts (`lib/draftStore.ts`)

Drafts store order as indices into the loaded lineup, followed by `extras`
(inserted items, or items whose length changed) and `programs` (metadata for
inserted programs). That way an insert survives a reload with its title.
`rebaseHistory` keeps objects not present in the saved lineup, so a removal can
still be undone after a save.

- **Writing.** An effect writes the active channel's draft whenever `lineup`, `history` or `base` change in live mode. It skips writes while loading or grabbing, or when the lineup length doesn't match `base`. The draft is `encodeDraft(channelId, base.version, base.lineup, lineup, history, dirty)`, and is deleted when there's nothing to keep.
- **Loading.** `loadProgramming` (without `rebase`) reads the stored draft.
  - **Same version:** `decodeDraft` restores the order and history, with a "Restored your unsaved changes" notice when the draft was dirty.
  - **Different version:** the draft is deleted, and dirty drafts get a notice.
- **Leaving a channel.** Switching channels, going live and going to demo no longer ask about live edits, because they are kept. Demo edits are not stored and still prompt. `beforeunload` warns only when the store isn't persistent.
- **Discarding explicitly.** **Reload From Tunarr** (`reloadChannel` → `reloadFromTunarr`) confirms if dirty, then deletes the draft.

### Slot schedule editing

1. **Open.** `openSlotEditor` (Channel menu, or the generated-schedule warning) loads `catalog`. For a channel with a schedule, it loads `tunarrApi.schedule(id)` into `slotEditor.draft` via `draftFromSchedule` (a `ScheduleDraftState`: type, settings, slots, extra movies). For a manual channel, it starts a new draft (`isNew`). `ScheduleEditor` edits the draft:
   - type conversion with `convertDraft`
   - settings and slots, with sources from `catalogOptions` and `showOption` (library shows)
   - per-slot options behind **More**: seasons for show slots (`SlotSeasons`, which loads seasons with a season search scoped to the show's media source and library, or counts them from `descendants`), direction, linked slots (`SlotLinking`, using `linkCandidates`, `linkSlot` and `linkGroups`), and commercials (`SlotCommercials`)
   - extra movies
   - **Detach to manual lineup** (`detachToManual`), which saves the current base lineup as a manual lineup
2. **Preview.** `previewSlots` calls `tunarrApi.previewSchedule(id, draft)` and switches to preview mode.
   - The timeline renders `scheduleForDay(null, preview.lineup, preview.startTime, date)` with `viewPrograms` (the programs merged with the preview's).
   - Rows are read-only, a sticky `.preview-bar` and the inspector offer save, edit and discard, and keyboard edits are disabled (Back discards).
3. **Save.** `saveSlots` is enabled only when `previewOf` matches the current draft, and confirms first if the lineup has unsaved edits. It calls `tunarrApi.saveSchedule(id, type, draft, preview, base.version)` and then compares Tunarr's returned lineup with the preview (by `itemIdentity`) to report whether they match. Afterwards it deletes the draft and reloads with a fresh edit list, because the lineup was regenerated.

### Programming templates

0. **Catalog.** `BUILT_IN_TEMPLATES` = `GENERAL_TEMPLATES` + `NETWORK_TEMPLATES`; saved templates come from `/templates` and AI drafts live in the dialog until saved. Built-in templates share role presets and market ad styles; blocks are `[start, role, adLevel?]` and weekly plans may override single weekdays.
1. **Choose.** `TemplatesDialog` lists `TEMPLATES` and draws the day plan. For each role with a suggestion it calls `tunarrApi.previewSmartCollection` once and shows the match count; roles with matches default to "new smart collection", the rest to "leave out".
2. **Apply.** Suggested collections are created (`createSmartCollection`, named "<template> · <role>", reusing one of that name if it exists). `templateToDraft` builds a time-slot draft: one slot per block (blocks with no source are left out so the previous block runs on), each block's day offset in a weekly period with Sunday as day 0 (Tunarr's `startOf('week')`), the role's play order, the template's pad, lateness (generous, because Tunarr turns a block into flex when the previous program runs past its start by more than the lateness), `flexPreference: 'end'`, and the ad style (`filler` for the commercials and promos lists; `midRoll` only when a commercials list is chosen and the style has breaks).
3. **Open.** `applyTemplate` (page) creates a channel first when asked, then opens the slot editor with the draft (`saved: null`). Nothing reaches the channel until the user previews and saves.
4. **Role defaults.** Saved and AI templates can carry `defaults` (a role's source). `defaultSource` turns one back into a source option, and the dialog preselects it.
5. **Saving a format.** `scheduleToTemplate` turns a time-slot schedule into a template: one role per source (flex left out), blocks per weekday (Mon–Fri collapses to `weekdays` when equal), the ad style from the first slot with mid-roll/filler, and `none` on blocks without commercials.
6. **Ad levels.** `midRollFor(style, level)`: light = interval ×1.6, length ×0.75, two fewer breaks; heavy = interval ×0.75, length ×1.25, one more break; none = no commercials list and no mid-roll (promos stay).

### Events on a date

`EventDialog` builds the event items (`lineupEntry` for library programs, `makeRedirect`, `makeFlex`) and calls `placeEvent(lineup, channel.startTime, at, items, mode, snap)`: it finds the pass and item airing at `at`, snaps to its end (`after`) or start (`before`), and either replaces items until the event's length is covered and pads with flex (`replace`, cycle unchanged) or inserts (`push`). The page's `placeEventEdit` applies it as one edit (`applyEdit`), merges program metadata, and jumps to the event's day. The preview states the drift from the requested time, what is taken off, and the new cycle (the event repeats every cycle).

Suggestions always include a playable type, and TV suggestions match `show_genre`: Tunarr indexes genres on shows, not episodes (on the owner's server "Type is episode and Genre is Drama" matched 0, "… Show genre is Drama" 3,683), and smart collections play raw search results.

### Program log export

`exportLog` builds CSV with `toCsv`, which quotes values and prefixes cells
that start with `= + - @` to neutralize spreadsheet formulas. It covers every
row of the visible day (date, start, end, duration, type, title, detail,
position) and downloads it via a `Blob` object URL. The filename gets an
`-unsaved` suffix when the lineup is dirty.

### Error propagation

- **Network failure** → `TunarrApiError('companion_unreachable')`.
- **Non-JSON response** → `companion_unavailable`.
- **Other errors** carry the code from the response body.
- **`noteFailure`** sets `connection` to `unreachable` for transport errors and never changes `mode`.
- **Where errors show:** channel and programming errors appear in the timeline's empty state with **Try again**; guide errors appear as a `sourceNote`.

## 8. External integrations

- **Tunarr HTTP API** is the main integration. The proxy uses the channel endpoints, `/api/programs/:id/artwork/:type`, and the content and setup endpoints listed in section 6.
- **Public image hosts** (for channel logos that link outside Tunarr, such as YouTube or TMDB images) are fetched by the companion only, through `fetchPublicImage`.
- **An AI provider** (Anthropic, or an OpenAI-compatible API such as OpenAI or Ollama), only when configured, called by `server/ai.ts`. On a real server, the artwork route returned `image/jpeg` for program UUIDs; the raw `artwork[].path` values in programming pointed at Plex on `127.0.0.1:32400`. There is no version negotiation.
- **Hosting the preview** is up to whoever deploys it (for example `wrangler deploy` on the `dist/` build). No deploy pipeline is in the repo.
- **Google Fonts** (Geist via `next/font/google`) are used by the hosted build only.

## 9. Persistence

- **Tunarr** holds all channel data. The companion's only stored state is saved templates (`LINEUP_DATA_DIR/templates.json`) and filler-list roles and folder links (`filler-roles.json`), plus the video files users upload to the media folder (`LINEUP_MEDIA_DIR`, when set); in memory it keeps channel locks and the logo cache.
- **The browser** keeps per-channel drafts (unsaved order and edit list) in IndexedDB (database `tunarr-lineup`, store `drafts`, key `channelId`). Each draft is tied to the programming version it was made against and is dropped once that version is gone.
  - If IndexedDB is unavailable or fails, an in-memory store is used and `draftStore().persistent` is false.
  - Drafts are per browser; they are not shared between devices.
- **Not persisted:** slot-schedule drafts and demo edits live only in React state.

## 10. Authentication

**Optional.** `server/auth.ts` implements HTTP Basic, enabled when
`LINEUP_PASSWORD` is set (user `LINEUP_USERNAME`, default `lineup`). It
compares SHA-256 digests with `timingSafeEqual`. `/healthz` stays open on the
production server. Without a password, `server/main.ts` logs a warning when
listening on a non-loopback host.

Cross-site writes are refused independently of sign-in: by the Origin check,
and by the JSON content type, which forces a CORS preflight the server never
approves.

**DNS rebinding.** The Origin check alone can't stop a page whose own host name
was re-pointed at the companion: Origin and Host then both carry the attacker's
name. Without sign-in, `server/hosts.ts` therefore answers only to IP
addresses, `localhost` and the names in `LINEUP_ALLOWED_HOSTS` (`.domain`
matches subdomains, `*` turns the check off). With sign-in the check is
skipped: the browser has no credentials for the rebound name, so it gets `401`.
`x-forwarded-host` is never used for this check, since a same-origin page can
set it. Optional basic auth to Tunarr itself comes from `TUNARR_URL`
userinfo.

## 11. Environment configuration

| Variable | Read by | Purpose |
| --- | --- | --- |
| `TUNARR_URL` | `createProxyConfig` (via `server/main.ts`, `vite.local.config.ts`) | Upstream Tunarr base URL (server-side only) |
| `TUNARR_TIMEOUT_MS`, `TUNARR_SAVE_TIMEOUT_MS` | `createProxyConfig` | Upstream timeouts |
| `LINEUP_EXTERNAL_LOGOS` | `createProxyConfig` | `false` stops fetching channel logos from public sites |
| `LINEUP_DATA_DIR` | `createProxyConfig` → `createTemplateStore` | Saved templates folder (default `./data`, `/data` in Docker) |
| `LINEUP_MEDIA_DIR`, `LINEUP_MEDIA_TUNARR_DIR`, `LINEUP_MEDIA_MAX_MB` | `createMediaFolder` | The media folder as Lineup sees it (uploads off when unset), as Tunarr sees it (default: the same), and the upload size limit (default 4096 MB) |
| `LINEUP_AI_PROVIDER`, `LINEUP_AI_API_KEY` (or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), `LINEUP_AI_MODEL`, `LINEUP_AI_BASE_URL`, `LINEUP_AI_TIMEOUT_MS` | `createAiConfig` | AI assistant provider (off when unset) |
| `LINEUP_PASSWORD`, `LINEUP_USERNAME` | `createAuthConfig` | Optional sign-in |
| `LINEUP_ALLOWED_HOSTS` | `createHostPolicy` | Host names answered without sign-in, besides IPs and `localhost` |
| `PORT` (3000), `HOST` (`0.0.0.0`), `STATIC_DIR` | `server/main.ts` | Listen address and UI directory |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx` | Hosted `metadataBase` (default `http://localhost:3000`) |
| `WRANGLER_*`, `MINIFLARE_REGISTRY_PATH` | `vite.config.ts` | Hosted dev tooling |
| `PLAYWRIGHT_CHANNEL`, `CI` | `playwright.config.ts` | Browser choice and retries/reporting for e2e |

Only `LINEUP_PUBLIC_`-prefixed variables can reach the companion client
bundle (`envPrefix`); none are used.

## 12. Build and deployment

- **Companion image** (`Dockerfile`):
  1. A `node:22-alpine` build stage runs `npm ci --ignore-scripts` and `npm run build:local`.
  2. The runtime stage copies only `dist-server/` and `dist-local/` and runs as `USER node`.
  3. It has a `HEALTHCHECK` on `/healthz` and starts with `CMD node dist-server/main.js`.

  No `TUNARR_URL` or password is baked in.
- **`docker-compose.example.yml`:** Tunarr plus Lineup (the published `ghcr.io/augustosc-eu/tunarr-lineup` image, or `build: .`) on a shared network, with `TUNARR_URL=http://tunarr:8000`. Commented options cover `LINEUP_PASSWORD` and timeouts, the amd64-only Tunarr image, and binding to `127.0.0.1`.
- **Hosted:** `vinext build` with the `cloudflare()` plugin → `dist/`.
- **CI** (`.github/workflows/ci.yml`):
  - **`checks` job:** `npm ci`, lint, typecheck, `npm test`, both builds, `playwright install chromium`, `test:e2e`, and the report as an artifact on failure.
  - **`docker` job:** image build, then curls `/healthz` until the container answers.
- **Release** (`.github/workflows/release.yml`): publishing a GitHub release `vX.Y.Z` builds the multi-arch image with QEMU and Buildx, pushes it to GHCR, then runs the pushed image and curls `/healthz`. It can also be run by hand for an existing tag. Notes come from `CHANGELOG.md`.

## 13. Testing

- **`tests/` (Vitest):**
  - `tunarrProxy.test.ts`: proxy routes, validation, error mapping, artwork, and header stripping over real HTTP.
  - `server.test.ts`: `createLineupServer` over real HTTP for static files, traversal, CSP, SPA fallback and sign-in; plus `isAuthorized` unit cases.
  - `lineup.test.ts`, `broadcast.test.ts`: pure logic for lineup, block moves, time targeting, timecode, totals, CSV, history and artwork URLs.
  - `schedule.test.ts`:
    - server slot validation and the program pool
    - schedule proxy routes: preview routing, server-computed pool, 409/400/412 refusals
    - slot helpers
    - draft encoding and decoding, the IndexedDB store via `fake-indexeddb`, the memory fallback, `rebaseHistory` and version fingerprints
  - `page.test.tsx` (jsdom): `Home` against a stateful `fakeCompanion()`. The fake enforces `If-Match` like the companion. Covers live loading, saves, 412 conflicts, remote slide and cancel, block moves, the Move dialog, menus, the on-air marker, export, drafts kept across channel switches and reloads, undo past a save, stale drafts dropped, the slot editor (catalog sources, adding slots with commercials and mid-roll, creating a time-slot schedule for a manual channel, preview then save with the seed, discard), library inserts, commercial breaks, remove/length/undo, drafts with inserted items, filler-list creation, and channel filler settings, demo guards, and no silent demo fallback.
- **`e2e/` (Playwright):**
  - `responsive.spec.ts` checks a 390×844 touch phone (Menu sheet, Program Info sheet edit and save, channel strip) and that 768×1024, 1280×800 and 2560×1080 fit without horizontal overflow.
  - `desk.spec.ts` runs at 1920×1080 against the built companion and `fake-tunarr.mjs`. The fake mimics Tunarr's guide window and provides `/__test/reset`, `/__test/state` and `/__test/edit-elsewhere` hooks.
  - It covers:
    - same-origin requests, artwork and the on-air marker
    - remote keys, with persistence after reload
    - conflict refusal, including two browser sessions racing
    - draft restore after a real reload (IndexedDB)
    - random-slot edit → preview → save (checking the saved schedule, seed and server-built program pool in the fake)
    - keyboard menus, CSV download and phone width

## 14. Cross-cutting patterns

- **Pure core, thin shells:** logic lives in `lib/*` and `server/tunarrProxy.ts`/`auth.ts`. Adapters and the UI stay thin.
- **Validate, then call:** every proxy input is checked before any I/O, and errors are normalized.
- **Pass-through data:** Tunarr objects are typed loosely and saved unchanged. Block moves only reorder references.
- **Snapshot history:** undo entries hold whole-lineup arrays that share `base.lineup` objects, capped at 200, stored as index arrays per version, and rebased across saves.
- **Optimistic concurrency:** every write carries the version it was based on, and the server checks it under a per-channel lock.
- **Honest UI state:** source notes, changed-row markers, the edit list, explicit conflict and confirmation dialogs, and no implicit mode switching.
- **Remote-first input:** every command has a keyboard path, and the menus duplicate toolbar actions.
- **Styling:**
  - One global stylesheet with semantic classes. Window titles come from CSS `content:`.
  - Sizes are in `rem` from `html { font-size: clamp(16px, min(1.25vw, 2.2223vh), 32px) }`; 1px hairlines stay `px`. The height term keeps short, wide windows from getting TV-size text; 1920×1080 is exactly 24px.
  - Heights use `--vh` (`100dvh` where supported, so mobile browser toolbars are accounted for) and `--bar` (the menu bar height, taller on touch screens).
  - Breakpoints:
    - **≤1180px:** two columns. Program Info becomes a floating sheet whose title bar (`.sheet-toggle`, state `infoExpanded`) expands it. Collapsed, it shows the program and the everyday actions (Earlier/Later, Move or swap, Insert, Remove, grouped in `.primary-actions`); expanded, everything.
    - **≤960px:** the connection button shows only its status dot, and the toolbar Undo is hidden (it stays in the Edit menu and the edit list).
    - **≤760px (phones):** `MenuBar` swaps its titles for one **Menu** button whose sheet lists every menu (same keys: ↑/↓, Enter, Esc); the channel rail becomes a strip of chips that keeps the active one in view; dialogs fill the screen.
  - `@media (pointer: coarse)`: larger hit targets, a taller menu bar and close box, and inputs of at least 16px so phones don't zoom on focus. `@media (hover: none)` swaps the drag tip for a touch one.
