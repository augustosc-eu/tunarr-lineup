# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex) working in this repository.
Read this first; read the docs below before non-trivial changes.

- `docs/PRODUCT.md`: what Tunarr Lineup is, who uses it, terminology, intended behavior
- `docs/ARCHITECTURE.md`: how the code actually works (entry points, data flow, proxy, build)
- `docs/DECISIONS.md`: decisions already made and the evidence for them
- `README.md`: end-user setup (Docker, local Node, environment variables)

## What this is

A TV-friendly, skinnable programming desk for [Tunarr](https://tunarr.com) channels
(Mac OS 9 Platinum by default; View → Appearance… offers Classic Windows, Modern Studio
and Broadcast Console, D57):
arrange, insert and remove programs, build and edit slot schedules (season filters,
linked slots), start channels from programming templates (general, network-inspired for
Japan, Argentina, the US, Spain, the UK and Italy, the user's own, or AI-written), place
events on dates, and manage commercials, filler lists, custom shows, smart collections,
local videos (music-video and video folders that keep custom shows, D70),
channels (create, duplicate, delete, logos, streaming), media sources and transcode
profiles; and run a whole station: Tunarr compatibility checks (D63), a multichannel
Control Room (D64), and previewed, conditional batch operations with media repair,
programming packages and selective rollback (D65). It ships as two targets built from one React page (`app/page.tsx`):

- **Local companion** (supported for real use): `server/` (dependency-free Node HTTP
  server plus a narrow `/api/tunarr/*` proxy) serving a Vite build of the page.
  Configured in its setup wizard (`config.json`, D62), not by environment
  variables. Docker: `Dockerfile`, `docker-compose.example.yml`.
- **Desktop app** (`desktop/`, D58): Electron running the same companion on
  `127.0.0.1` in a sandboxed window; it opens the setup wizard with its code and
  signs its window in with a per-launch key (`lineup.env` only sets where it listens). Its own npm package; `npm run build:desktop` packages it.
- **Installable web app** (D59): `public/manifest.webmanifest` and icons let iPad,
  Android and TV browsers add the companion's page to the home screen.
- **Android app** (`android/`, D60): a native WebView window onto a Lineup server
  for phones, tablets and Android TV. Plain Java, no libraries; built by Gradle.
- **Hosted preview**: Vinext (Next.js App Router on Vite) built for a Cloudflare
  Workers runtime (`vite.config.ts`, `app/layout.tsx`). It has no proxy, so only demo
  mode works there.

## Commands

```sh
npm install
npm run lint          # eslint (next core-web-vitals + typescript)
npm run typecheck     # tsc for the app and for server/
npm test              # vitest run (tests/)
npm run test:e2e      # Playwright (e2e/) against dist-server + fake Tunarr; run build:local first
npm run build         # hosted preview build (vinext) -> dist/
npm run build:local   # companion build -> dist-local/ (UI) + dist-server/ (server)
npm run dev:local     # companion dev server on :3000 (prints the setup code on first run)
npm run start:local   # run the built companion
npm --prefix desktop install && npm run start:desktop  # desktop app from the repo
npm run build:desktop # desktop installers for this OS -> desktop/release/
node scripts/make-icons.mjs   # re-render app icons from public/favicon.svg
(cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug)  # Android app; needs JDK 21 + Android SDK
```

Before declaring work done, run `lint`, `typecheck`, `test`, `build`,
`build:local` and `test:e2e`. Both builds must keep working; they use different
Vite configs. For local e2e runs, set `PLAYWRIGHT_CHANNEL=chrome` or install
Chromium with `npx playwright install chromium`. CI runs all of them
(`.github/workflows/ci.yml`).

## Invariants (do not break without explicit approval)

1. **The browser never contacts Tunarr (or any other server).** It calls only
   same-origin `/api/tunarr/*`. Never put `TUNARR_URL` or any Tunarr address in client
   code. Only the `LINEUP_PUBLIC_` env prefix is exposed to the client
   (`vite.local.config.ts`). Never add wildcard CORS or a generic proxy. The one
   way to enter Tunarr's address (owner decision 2026-10-25, D62) is the setup
   wizard and Setup → Server Settings: the address goes to the companion through
   the code-checked `/setup/*` routes or the signed-in `/server-config`, is
   validated by `parseTunarrUrl`, kept in `config.json`, and used only as the
   companion's fixed upstream; the browser never fetches it, and its credentials
   are never sent back. The one address a user types is the Lineup
   server's own, in the Android app (owner decision 2026-10-24, D60): it is opened
   as the top-level page, nothing is fetched cross-origin, and the window never
   leaves that origin or exposes a JavaScript bridge. Channel logos come through
   `/api/tunarr/channels/:id/logo` (`server/logos.ts`); public logo hosts are fetched
   by the companion with the guards there (public addresses only, ports 80/443, image
   types, size and redirect limits), never by the browser. Operational notifications
   (D68, `server/notify.ts`) go only to the one webhook the owner saved in Server Settings,
   HTTPS to public addresses (a private-network address only with its explicit option,
   never loopback or link-local), lookup pinned, no redirects, with Lineup's own words; the
   address is write-only and Tunarr's replies or error texts are never sent. The AI provider is likewise
   configured and called only by the companion (`server/ai.ts`, `LINEUP_AI_*`); its key
   and address never reach the browser, and its replies are validated as templates.
2. **The proxy stays an allowlist.**
   - Channel routes live in `server/tunarrProxy.ts` (`matchRoute`). Library, list and
     channel-settings routes live in `server/content.ts` (`matchContentRoute`). Setup
     routes (channels, transcode profiles, media sources, smart collections) live in
     `server/admin.ts` (`matchAdminRoute`). The setup wizard and server configuration
     live in `server/setup.ts` (`matchSetupRoute`): before setup only they answer
     (everything else is `503 setup_required`), and the wizard's need the setup code.
     Lineup's own routes (saved templates, filler-list roles, the media folder, local videos, AI)
     live in `server/lineupRoutes.ts` (`matchLineupRoute`); templates are always checked
     with `validateTemplate` (`server/templateSchema.ts`). Every route is explicit, IDs are validated,
     and no raw Tunarr request is accepted: search filters and smart-collection filters
     are built server-side (`buildLibrarySearch`, `rulesToFilter`), channel settings and
     transcode profiles are allowlists merged onto Tunarr's copy, and media sources are
     sanitized so server addresses, tokens, accounts and folder paths never reach the
     browser.
   - Slot schedules are validated in `server/slotSchedule.ts` (`buildSchedule`), and
     the program pool is computed server-side.
   - Compatibility (`/compatibility`, in `server/lineupRoutes.ts`, decided by
     `server/compatibility.ts`), the Control Room (`server/controlRoom.ts`,
     `matchControlRoomRoute`) and batch operations (`server/batch.ts`,
     `matchBatchRoute`) only read Tunarr through explicit GETs (plus one library
     search for one result), and batches write only through the same conditional,
     locked, snapshotted paths as the desk (owner request 2026-10-25, D63–D65).
     Capabilities are decided in one place, `CAPABILITY_MATRIX`; never check
     Tunarr's version in components.
   - Watching routes live in `server/watch.ts` (`matchWatchRoute`, owner decision
     2026-10-19): the all-channel guide, viewer counts (never addresses or user agents)
     and a channel's HLS stream. Stream playlists are rewritten to companion paths, and a
     playlist naming anything but that channel's own HLS files is refused.
   - Adding a route means validating its params and body, adding tests, and documenting
     it in `docs/ARCHITECTURE.md`.
   - Keep the SSRF guards: fixed upstream origin, ID regexes, `redirect: 'manual'`,
     timeouts, no forwarded cookies or auth, the Origin check, and normalized JSON
     errors without stack traces.
3. **Edits go through Tunarr, and Tunarr's data is preserved.**
   - Adding programs, breaks, slots, sources and list contents is allowed (owner
     decision, 2026-10-03), but only through Tunarr's own APIs and only with programs
     Tunarr already indexes.
   - Lineup item objects are passed through untouched on save (`buildManualSave`);
     never rebuild them from a subset of fields.
   - Custom-show updates must keep their Plex sync settings.
   - Setting up Tunarr is allowed too (owner decision, 2026-10-03): creating,
     duplicating and deleting channels; adding and removing media sources and enabling
     or scanning their libraries; editing transcode profiles; creating smart
     collections. Media-server addresses and tokens are write-only: they go to Tunarr
     and are never returned. Don't add endpoints that create or upload media files,
     edit Tunarr's global settings (FFmpeg paths, HDHomeRun, XMLTV), or reveal secrets.
     The one exception (owner decision, 2026-10-07): video uploads into the companion's
     own media folder (`LINEUP_MEDIA_DIR`, `server/mediaFolder.ts`), which Tunarr reads
     as a local source. Files there can be moved between role folders or deleted;
     nothing is overwritten, and nothing is written anywhere else. Since the owner
     decision of 2026-10-27 (D70) that includes music videos and videos in its named
     `music-videos/<folder>` and `videos/<folder>` folders (one level, never through a
     symlink), each added to Tunarr as its own local source.
4. **Every save is conditional.**
   - The client sends `If-Match` with `programmingVersion(lineup, schedule)` of what it
     loaded (`server/lineupVersion.ts`, shared with the browser).
   - The proxy re-checks it under a per-channel lock (`withChannelLock`) and answers
     412 `lineup_changed` on mismatch.
   - Manual saves use `{ "type": "manual", "lineup": [...], "append": false }` (optionally
     `keepOnAir`, or `startTime` for a planned lineup, D67; neither is forwarded); afterwards,
     re-fetch programming and the visible day.
   - Warn before saving a manual lineup over a generated `schedule`. Schedule saves must
     be previewed first and reuse the preview's seed.
5. **Drafts persist.**
   - Unsaved order and undo history are stored per channel and per programming version
     (`lib/draftStore.ts`, IndexedDB with an in-memory fallback), as positions into the
     loaded lineup.
   - Keep `base.lineup` objects as the only items in history snapshots. `revertAll` uses
     `base.lineup`, not a clone.
   - After a manual save, re-attach history with `rebaseHistory`.
6. **No silent demo fallback.** Live failures show errors; demo data appears only after
   the user picks "Use demo data". Keep demo mode visibly labeled.
7. **Server stays dependency-free.** The runtime Docker stage copies only `dist-server/`
   and `dist-local/`, with no `node_modules`. Use Node built-ins in `server/`, or update
   the Dockerfile deliberately (client-only packages such as `hls.js` are bundled into
   `dist-local/`). Its stored state, all through `server/jsonFile.ts` (atomic writes; a
   file it can't parse is never overwritten): its configuration from the setup
   wizard (`config.json`, `server/configStore.ts`, owner decision 2026-10-25, D62:
   owner-only, the password only as a scrypt hash, keys never sent back), saved templates (`templates.json`,
   `server/templateStore.ts`), filler-list roles (`filler-roles.json`,
   `server/fillerRoleStore.ts`, owner decision 2026-10-07), local-video kinds and followed
   custom shows (`local-videos.json`, `server/localVideoStore.ts`, owner decision
   2026-10-27, D70), and since the owner decision
   of 2026-10-19 snapshots (`snapshots/<channel>.json`, `server/snapshotStore.ts`),
   shared drafts (`drafts/`, `server/sharedDraftStore.ts`) and scheduled changes
   (`scheduled.json`, `server/scheduler.ts`); since the owner decision of 2026-10-19
   (D54, D55) also picked station IDs (`station-ids.json`, `server/stationIdStore.ts`) and
   the tuning settings changed from the desk (`settings.json`, `server/settings.ts`; only
   the allowlist in `EDITABLE_SETTINGS`; addresses, keys, the account and the media
   folder are changed only through `server/setup.ts`); and since the owner request of
   2026-10-25 (D65) the batch-operation record (`batches.json`, `server/batchStore.ts`:
   outcomes, the old values of allowlisted settings, snapshot ids; last 30), and (D66) the
   schedule library and calendar (`schedule-library.json`, `calendar.json`,
   `server/calendarStore.ts`). Calendar occurrences are armed by the scheduler as ordinary
   conditional plans; never let the browser send the `calendar` group. When `LINEUP_MEDIA_DIR` is set, it also
   holds the filler videos users upload there.
   - **Sign-in is required after setup** (D62). Don't add a way to turn it off or to
     reach the wizard's routes without the setup code.
   - **The scheduler** (scheduled changes on, off by default) is the only thing that
     writes to Tunarr without someone at the desk. It uses the same conditional save
     under `withChannelLock` (`server/channelLock.ts`), takes a snapshot first, and skips
     (never forces) a change whose channel no longer matches what was planned.
8. **Keep the desk TV/remote-operable.** Every action must be reachable without a
   mouse: arrow keys, Enter/OK, Escape/Back, PageUp/PageDown or CH±, the menus and
   the `?` shortcut list. Don't add hover-only or drag-only features.
9. **Preserve the Mac OS 9 visual treatment** as the default Platinum skin: platinum
   chrome, striped title bars, 1px bevels. Style through the semantic tokens in
   `app/globals.css` (Platinum values in `:root`, other skins as `[data-skin]` token
   overrides), never per-skin copies of rules. The skin is a browser preference only
   (`lib/skins.ts`, `localStorage`), never a server setting. The interface is used on a TV, so keep text large and smooth. Size things in
   `rem` (the root scales with viewport width in `app/globals.css`); keep 1px hairlines
   in `px`; don't reintroduce `-webkit-font-smoothing:none` or sub-13px base type.

## Working rules

- **Network templates describe a style, not an official schedule.** Name networks only in
  `inspiredBy` text ("Inspired by …"), never with logos, and keep descriptions honest
  approximations. Every built-in must pass `validateTemplate` and `buildSchedule` (tested).
- **Treat any reachable Tunarr as real user data.** Read-only checks are fine. Never
  save programming to a real Tunarr unless the user asks. For write testing, use the
  test suite or a throwaway Tunarr container.
- **Match the surrounding style.** `app/page.tsx` uses compact, dense JSX and helper
  functions at module scope; `server/` and `lib/` use small typed functions with brief
  "why" comments. Use custom CSS classes in `app/globals.css`; Tailwind is imported
  but its utilities are essentially unused.
- **Put pure logic in `lib/`** (testable without React): `library.ts` for library types and helpers, `lineup.ts` for schedule math,
  `broadcast.ts` for block moves, timecode, totals and CSV, `history.ts` for
  undo/redo and rebasing, `draftStore.ts` for persistent drafts, `schedule.ts` for slot
  editing (seasons, linked slots), `templates.ts` (presets, ad styles, `templateToDraft`,
  `scheduleToTemplate`), `networkTemplates.ts` (the network catalog), `templateCatalog.ts`,
  `events.ts` (placing events on dates), `programBin.ts` (arranging picked programs: order, passes, breaks after each), `fillerRoles.ts` (filler-list roles, spot lengths),
  `airKinds.ts` (station-log kinds: breaks, IDs, flex; hour summaries, break rundowns),
  `compatibility.ts` (what the desk refuses and why, the diagnostics file), `controlRoom.ts`
  (Control Room statuses, filters, paging, the opt-in stream check), `batch.ts` (batch
  labels, defaults, what can be rolled back), `calendar.ts` (calendar labels, zones and the entry form),
  `planner.ts` (the advanced planner: seeded, fair-queued rotations materialized as a lineup),
  `epg.ts` (the guide preview and its checks; Lineup never serves a guide, D69),
  `localVideos.ts` (music videos in the bin: artists, clean titles, grouping, `spreadArtists`),
  `lineupCheck.ts` (the lineup check), `weekLog.ts` (several days: week view, logs, AI
  summary), `guideGrid.ts` (guide grid layout and focus), `skins.ts` (the skin catalog and its validator), `tvRemote.ts` (watching like a cable box: remote keys, tuning, retries), `loading.ts` (load phases, time limits, bounded waits), `rowWindow.ts` (which of a long day's rows are mounted), `lastChannel.ts` (`?channel=` and the last channel opened), and `programInfo.ts` for titles,
  artwork and logo URLs.
- **Put HTTP and validation logic in `server/`:** `tunarrProxy.ts` (framework-free),
  `content.ts`, `admin.ts`, `logos.ts`, `smartCollection.ts`, `templateSchema.ts`,
  `templateStore.ts`, `fillerRoles.ts`, `fillerRoleStore.ts`, `configStore.ts`, `setup.ts`, `boot.ts`, `mediaFolder.ts`, `jsonFile.ts`, `lineupRoutes.ts`, `ai.ts`, `upstream.ts`,
  `watch.ts`, `programmingCache.ts`, `compression.ts`, `settings.ts`, `stationIdStore.ts`, `snapshotStore.ts`, `sharedDraftStore.ts`, `scheduler.ts`, `channelLock.ts`, `lineupItems.ts`,
  `slotSchedule.ts`, `recreateChannel.ts`, `lineupVersion.ts`, `auth.ts`, `hosts.ts`, `app.ts`,
  `compatibility.ts`, `channelHealth.ts`, `controlRoom.ts`, `batch.ts`, `batchStore.ts`, `notify.ts`,
  `programmingPackage.ts`, `calendar.ts`, `calendarStore.ts`, `calendarArm.ts`, `videoTitles.ts`,
  `localVideos.ts` and `localVideoStore.ts`. `lib/` and
  `app/` may import pure modules from `server/` (`lineupVersion`, `slotSchedule`,
  `smartCollection`, `templateSchema`, `fillerRoles`, `programmingPackage`, `calendar`, `videoTitles`; types from any module) but never Node
  APIs (`logos.ts`, `jsonFile.ts`, `mediaFolder.ts`, the stores, `setup.ts`, `boot.ts`,
  `notify.ts`, `batch.ts`, `calendarArm.ts`, `localVideos.ts` and the scheduler use Node built-ins or import them;
  `app/` imports only types from `setup.ts`, `batch.ts`, `calendarArm.ts` and `localVideos.ts`).
- **Keep `app/page.tsx` for UI state and rendering,** and `app/components/` for larger
  UI pieces: `MenuBar`, `MoveDialog`, `ScheduleEditor`, `InsertDialog`,
  `LibraryBrowser`, `ProgramBin` (the poster bin docked beside the lineup), `ListsManager`, `ChannelSettingsDialog`, `NewChannelDialog`,
  `SmartCollectionsManager`, `MediaSourcesDialog`, `FillerFoldersDialog`, `LocalVideosDialog` (Setup → Local Videos), `TranscodeProfilesDialog`, `ServerSettingsDialog`,
  `TemplatesDialog` (gallery, AI panel), `TemplateEditor`, `EventDialog`, `DayStrip`,
  `GuideGrid`, `WeekView`, `LineupCheckDialog`, `AlignDialog`, `MarathonDialog`,
  `NetworkDialog` (copy, simulcast, shared commercials), `WatchDialog` (with `TvRemote` and `CableGuide`), `SnapshotsDialog`,
  `PlanDialog` (Save Later, seasonal overlays), `ScheduledDialog`, `AppearanceDialog` (skins),
  `CompatibilityPanel` (Server Settings → Compatibility), `NotificationsPanel` (Server Settings →
  Notifications), `ControlRoomDialog` (View → Control
  Room), `BatchDialog` (batch operations, media repair, packages), `ScheduleCalendarDialog` (schedule
  library and calendar), `PlannerDialog` (Edit → Advanced Planner), `GuidePreviewDialog` (View → Guide
  Preview); `app/dpad.ts` gives form dialogs D-pad movement and keeps focus inside them,
  `SetupWizard` (first start; also the Tunarr, AI and media fields `ServerSettingsDialog` reuses).
  `app/useSkin.ts` applies and remembers the skin (`public/skin-init.js` applies it before React);
  `app/useFillerSpots.ts` loads filler lists, their roles and spots for the day view;
  `app/useLiveStream.ts` plays and retries a channel's live stream;
  `app/useLibraryListing.ts` browses the libraries for `LibraryBrowser` and `ProgramBin`.
- **Add or update tests** for any behavior change.
  - Unit and UI tests go in `tests/`. Proxy tests inject `fetchImpl`; UI tests mock
    `fetch` with a stateful fake companion (`tests/page.test.tsx`).
  - Browser flows go in `e2e/`, using the fake Tunarr in `e2e/fake-tunarr.mjs`.
- **Don't edit generated or vendored output:** `dist*/`, `.next/`, `.vinext/`,
  `.wrangler/`, `next-env.d.ts`.
- **Don't change the `vinext()` / `cloudflare()` plugin setup** in `vite.config.ts`
  unless the task is about the hosted build.
- **Keep docs current.** When behavior, routes, env vars or commands change, update
  `README.md` and the relevant file in `docs/`.
- Commit or push only when asked.


## vexp - Context-Aware AI Coding <!-- vexp v3.3.2 -->

### Context strategy: call run_pipeline ONCE at task start
If the task already names the files/symbols to touch, SKIP vexp. Otherwise one
`run_pipeline({ "task": "..." })` returns ranked pivot files with line ranges and
blast radius. Do NOT open files one by one to find your way around - every extra
tool call costs a turn. Call it again ONLY when the task moves to a new area.
`get_skeleton` for files to understand, not edit. `verify_done` before calling a
multi-file task complete, then RUN the tests it names.

### Query shape (do this)
Anchor the task on real identifiers (ClassName, functionName) or file paths:
`run_pipeline({ "task": "fix JWT expiry in AuthService.validateToken" })`

vexp runs entirely on this machine, index in `.vexp/`;
`run_pipeline` transmits nothing to any external service.
On `status: "degraded"` or 0 pivots the index is still building - use your own tools.
For literal string sweeps use your native search - do NOT route text sweeps through vexp.
Repo SOURCE only: logs, dist/, node_modules/ and files outside the repo are NOT indexed.
<!-- /vexp -->