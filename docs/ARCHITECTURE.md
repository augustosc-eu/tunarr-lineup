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
                          ┌──────────────── Hosted preview (OpenAI Sites, demo-only) ─────────────────┐     /api/programs/:id/artwork/:type
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
| `app/page.tsx` | Main UI: state, data loading, editing commands, keyboard/remote handling, rendering, dialogs. `'use client'` component `Home` plus the local `ArtTile`. |
| `app/components/MenuBar.tsx` | Pull-down menu bar (`MenuBar`, types `Menu`, `MenuItem`) with mouse and keyboard handling. |
| `app/components/ScheduleEditor.tsx` | Slot-schedule editor for random- and time-slot channels (source, weight, cooldown, length, order, start time; duplicate/remove/reorder/shift). Displays and edits a draft; the page owns the state. |
| `app/components/LibraryBrowser.tsx` | Library browser (`LibraryBrowser`, `LibraryPick`): source/library pickers, search, show → season → episode navigation, **Add** / **Add all** into a basket. Modes: `programs`, `show`, `movies`. |
| `app/components/InsertDialog.tsx` | Insert programs (via the browser), commercial break, flex or redirect, before or after the selection. |
| `app/components/ListsManager.tsx` | Filler-list and custom-show manager (create, rename, delete, edit contents through `LibraryBrowser`). |
| `app/components/ChannelSettingsDialog.tsx` | Channel settings: name, number, group, guide flex title, guide minimum, start time, filler collections, filler cooldown, filler overlay. |
| `app/components/MoveDialog.tsx` | The "Move or swap" dialog: move to time (with preview), move to position, and a searchable candidate list capped at `MAX_CANDIDATES` (200). |
| `app/layout.tsx` | Hosted-only root layout: Geist fonts (`next/font/google`), metadata, OpenGraph. Not used by the companion build. |
| `app/globals.css` | All styling (Mac OS 9 theme, rem-based scaling, responsive rules). Imports Tailwind. |
| `lib/lineup.ts` | Domain types and schedule math: projection, guide mapping, `scheduleForDay`, `reorderLineup`, `buildManualSave`. |
| `lib/broadcast.ts` | Programming-desk helpers: timecode, block moves, move-to-position and move-to-time, change tracking, day totals, on-air lookup, CSV. |
| `lib/history.ts` | Undo/redo stack of whole-lineup snapshots (`record`, `undo`, `redo`, `MAX_HISTORY` = 200), plus `itemIdentity` and `rebaseHistory` for carrying history across a save. |
| `lib/draftStore.ts` | Persistent per-channel drafts: `encodeDraft` / `decodeDraft` (lineup states as index arrays into the loaded lineup), `createDraftStore` (IndexedDB `tunarr-lineup/drafts`, in-memory fallback, at most `MAX_DRAFTS` = 60), shared via `draftStore()`. |
| `lib/schedule.ts` | Slot-editing helpers: `sourceOptions`, `slotLabel`, `changeSlotSource`, `duplicateSlot`, `newSlotId` (v4 via `getRandomValues`), `shiftTimeSlots`, `slotProblems`, clock conversions, and types `Slot`, `SlotSchedule`, `SchedulePreview`. |
| `lib/library.ts` | Library types (`MediaSource`, `LibraryItem`, `ContentProgram`, `ListSummary`, `ChannelSettings`) and helpers (`topLevelType`, `childType`, `toContentProgram`, `lineupEntry`, `itemLabel`). |
| `lib/programInfo.ts` | `getProgram`, `programTitle`, `programDetail`, `programArtwork`. |
| `lib/tunarrClient.ts` | Browser client for `/api/tunarr/*`: `checkHealth`, `tunarrApi`, `TunarrApiError`, `ConnectionState`. |
| `lib/demoData.ts` | Demo channels and lineup (`demoChannels`, `demoProgramming()`, `demoDate`). |
| `local/index.html`, `local/main.tsx` | Companion SPA entry: renders `<Home />` into `#root` under `StrictMode` and imports `app/globals.css`. |
| `server/tunarrProxy.ts` | Framework-free proxy and validation: `handleTunarrApi`, `createProxyConfig`, `parseTunarrUrl`, validators, artwork passthrough. |
| `server/nodeAdapter.ts` | Adapts Node `IncomingMessage`/`ServerResponse` to `handleTunarrApi` (`handleNodeApiRequest`, `isTunarrApiPath`). |
| `server/slotSchedule.ts` | Slot-schedule rules: `buildSchedule` (create, convert or edit; per-type settings allowlist; slot, filler and mid-roll validation; materialized fields stripped), `defaultSchedule`, `programPool` (port of Tunarr's `lineupItemAppearsInSchedule`, plus extra programs), `validateExtraPrograms`, `slotSourceKey`, `validateSeed`. Pure, so `lib/` imports it too. |
| `server/content.ts` | Library, list and channel-settings routes: `matchContentRoute`, `handleContentRoute`, `sanitizeMediaSources`, `buildLibrarySearch`, `validateFillerListBody`, `validateCustomShowBody`, `channelSettings`, `validateChannelSettings`. |
| `server/upstream.ts` | Shared upstream plumbing: `fetchUpstream`, `callTunarr` (GET/POST/PUT/DELETE), `UpstreamError`, `json`, `fail`. |
| `server/lineupVersion.ts` | `programmingVersion(lineup, schedule)`: a non-cryptographic fingerprint (two cyrb53 hashes plus length), shared by the browser and the proxy for `If-Match`. |
| `server/auth.ts` | Optional HTTP Basic sign-in: `createAuthConfig`, `isAuthorized`, `AUTH_CHALLENGE`. |
| `server/app.ts` | `createLineupServer({ config, auth, staticRoot })`: request routing, static files, SPA fallback, security headers. |
| `server/main.ts` | Process entry: reads env, creates the server, listens, logs, handles SIGTERM/SIGINT. |
| `server/tsconfig.json` | Compiles `server/*.ts` (excluding tests) to `dist-server/` (NodeNext ESM). |
| `vite.config.ts` | Hosted build/dev: `vinext()`, `sites()` (OpenAI Sites), `cloudflare()` plugins. |
| `vite.local.config.ts` | Companion build/dev: React plugin, Tailwind PostCSS, and dev middleware for sign-in and `/api/tunarr`. |
| `vitest.config.ts` | Unit/UI tests (`tests/**/*.test.{ts,tsx}`, default env `node`). |
| `playwright.config.ts`, `e2e/` | End-to-end suite: `e2e/desk.spec.ts` against the built companion and `e2e/fake-tunarr.mjs`. |
| `.github/workflows/ci.yml` | CI: lint, typecheck, unit tests, both builds, e2e, Docker build plus healthcheck. |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml` | Companion container and an example stack alongside Tunarr. |
| `.openai/hosting.json` | OpenAI Sites project metadata (`project_id`; `d1` and `r2` both `null`). |
| `public/` | `favicon.svg`, `og.png`. Served by both targets. |
| Generated (do not edit) | `dist/`, `dist-local/`, `dist-server/`, `.next/types/`, `.vinext/`, `.wrangler/`, `next-env.d.ts`, `test-results/`, `playwright-report/`. |

## 3. Frameworks and major dependencies

From `package.json` (Node `>=22.13.0`, `"type": "module"`):

- **React 19** is the only UI library. There is no state library and no router.
- **Next 16 / Vinext 1.0.0-beta.3** are used only for the hosted target. The companion bundle uses no Next APIs.
- **Vite 8** runs both builds. **`@vitejs/plugin-react`** is used by the companion build and the tests.
- **`@cloudflare/vite-plugin`, `wrangler` and `@cloudflare/workers-types`** support the hosted build's Workers-style runtime.
- **`@openai/sites-vite-plugin`** (`sites()`) copies `.openai/hosting.json` into `dist/.openai/`.
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
production on OpenAI Sites was not verified.

**Companion server** (`createLineupServer` in `server/app.ts`) evaluates each request in this order:

1. **`/healthz`** → `200 {"status":"ok"}`. Liveness only; it doesn't check Tunarr. Always unauthenticated, for the Docker `HEALTHCHECK`.
2. **`isAuthorized(req.headers.authorization, auth)`** fails → `401` with `WWW-Authenticate: Basic`. This applies only when `LINEUP_PASSWORD` is set.
3. **`isTunarrApiPath`** → `handleNodeApiRequest`.
4. **Methods other than GET/HEAD** → `405`.
5. **An existing file** under `staticRoot` → served. `resolveStatic` rejects path traversal. `/assets/*` is cached `immutable`; everything else is `no-cache`.
6. **A missing path with a file extension** → `404`. **Anything else** → `index.html` (SPA fallback).

Static responses carry `securityHeaders`, including CSP `default-src 'self'`,
`connect-src 'self'`, `img-src 'self' data:` and `frame-ancestors 'none'`.

The Vite dev middleware in `vite.local.config.ts` applies the same sign-in
check to every request, including `/healthz`, before handling `/api/tunarr`.

## 6. The Tunarr proxy (`server/tunarrProxy.ts`)

### Configuration

`createProxyConfig(env)` builds a `ProxyConfig`:

- **`TUNARR_URL`** is parsed by `parseTunarrUrl` into `origin`, `basePath`, `host` and an optional `authorization`. Userinfo becomes a Basic header and never appears in `host`. Missing → `target: null`; invalid → `configError` (fixed text, never echoing the value).
- **`TUNARR_TIMEOUT_MS`** defaults to 10000 and **`TUNARR_SAVE_TIMEOUT_MS`** to 30000.
- **`fetchImpl`** is an optional override for tests.

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
   - **`programming` with `type: 'manual'`:** `validateManualProgramming` checks `append` false or absent and each item's type, positive duration and ids.
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
| `/smart-collections` | GET | `GET /api/smart_collections` → `{ id, name }` |
| `/channels/:id/settings` | GET, PUT | `GET /api/channels/:id` → `channelSettings` (only `CHANNEL_SETTING_FIELDS`). PUT validates with `validateChannelSettings`, then under `withChannelLock` re-reads the channel, merges only the allowed fields, drops read-only fields (`programCount`, `sessions`, `fallback`, `transcoding`), and `PUT`s the whole channel. |

`nodeAdapter` reads request bodies for POST and PUT (up to 20 MiB).

## 7. Client data flow (`app/page.tsx`)

### State

All state is local React state in `Home`. There is no context, store or browser storage.

- **Connection and mode:** `mode` (`'live' | 'demo'`, starting `'live'`) and `connection` (`ConnectionState`).
- **Data:** `channels`, `activeChannelId`, `programming`, `originalLineup` (the saved baseline) and `guide`.
- **Selection and cursor:** `anchorIndex` and `selectedIndex` form a contiguous block (`normalizeBlock`). `cursorStart` records the start time of the focused row, which disambiguates repeats of the same item within a day.
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
| Insert | `I`, Edit menu, inspector, empty-lineup inspector | `InsertDialog` → `insertAt(where, items, label, meta)` → `insertItems`. Library programs come from `LibraryBrowser` via `pickFromLibrary` → `lineupEntry`; their metadata is merged into `programming.programs`. Breaks use `makeCommercialBreak` (flex with `fillerConfig`); also `makeFlex` and `makeRedirect`. |
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
   - per-slot commercials (`SlotCommercials`)
   - extra movies
   - **Detach to manual lineup** (`detachToManual`), which saves the current base lineup as a manual lineup
2. **Preview.** `previewSlots` calls `tunarrApi.previewSchedule(id, draft)` and switches to preview mode.
   - The timeline renders `scheduleForDay(null, preview.lineup, preview.startTime, date)` with `viewPrograms` (the programs merged with the preview's).
   - Rows are read-only, a sticky `.preview-bar` and the inspector offer save, edit and discard, and keyboard edits are disabled (Back discards).
3. **Save.** `saveSlots` is enabled only when `previewOf` matches the current draft, and confirms first if the lineup has unsaved edits. It calls `tunarrApi.saveSchedule(id, type, draft, preview, base.version)` and then compares Tunarr's returned lineup with the preview (by `itemIdentity`) to report whether they match. Afterwards it deletes the draft and reloads with a fresh edit list, because the lineup was regenerated.

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

- **Tunarr HTTP API** is the only integration. The proxy uses four channel endpoints plus `/api/programs/:id/artwork/:type`. On a real server, the artwork route returned `image/jpeg` for program UUIDs; the raw `artwork[].path` values in programming pointed at Plex on `127.0.0.1:32400`. There is no version negotiation.
- **OpenAI Sites** hosts the preview. Only the build plugin and metadata are in the repo; the deploy pipeline is not.
- **Google Fonts** (Geist via `next/font/google`) are used by the hosted build only.

## 9. Persistence

- **Tunarr** holds all channel data. The companion server is stateless, apart from in-flight channel locks.
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
approves. Optional basic auth to Tunarr itself comes from `TUNARR_URL`
userinfo.

## 11. Environment configuration

| Variable | Read by | Purpose |
| --- | --- | --- |
| `TUNARR_URL` | `createProxyConfig` (via `server/main.ts`, `vite.local.config.ts`) | Upstream Tunarr base URL (server-side only) |
| `TUNARR_TIMEOUT_MS`, `TUNARR_SAVE_TIMEOUT_MS` | `createProxyConfig` | Upstream timeouts |
| `LINEUP_PASSWORD`, `LINEUP_USERNAME` | `createAuthConfig` | Optional sign-in |
| `PORT` (3000), `HOST` (`0.0.0.0`), `STATIC_DIR` | `server/main.ts` | Listen address and UI directory |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx` | Hosted `metadataBase` |
| `CODEX_SANDBOX`, `WRANGLER_*`, `MINIFLARE_REGISTRY_PATH` | `vite.config.ts` | Hosted dev tooling |
| `PLAYWRIGHT_CHANNEL`, `CI` | `playwright.config.ts` | Browser choice and retries/reporting for e2e |

Only `LINEUP_PUBLIC_`-prefixed variables can reach the companion client
bundle (`envPrefix`); none are used.

## 12. Build and deployment

- **Companion image** (`Dockerfile`):
  1. A `node:22-alpine` build stage runs `npm ci --ignore-scripts` and `npm run build:local`.
  2. The runtime stage copies only `dist-server/` and `dist-local/` and runs as `USER node`.
  3. It has a `HEALTHCHECK` on `/healthz` and starts with `CMD node dist-server/main.js`.

  No `TUNARR_URL` or password is baked in.
- **`docker-compose.example.yml`:** Tunarr plus Lineup on a shared network, with `TUNARR_URL=http://tunarr:8000`. Commented options cover `LINEUP_PASSWORD` and timeouts, the amd64-only Tunarr image, and binding to `127.0.0.1`.
- **Hosted:** `vinext build` with the `cloudflare()` and `sites()` plugins → `dist/`.
- **CI** (`.github/workflows/ci.yml`):
  - **`checks` job:** `npm ci`, lint, typecheck, `npm test`, both builds, `playwright install chromium`, `test:e2e`, and the report as an artifact on failure.
  - **`docker` job:** image build, then curls `/healthz` until the container answers.

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
  - Sizes are in `rem` from `html { font-size: clamp(16px, 1.25vw, 32px) }`; 1px hairlines stay `px`.
  - Breakpoints are at 1180px (floating inspector) and 760px (stacked layout; the connection button shows only its status dot).
