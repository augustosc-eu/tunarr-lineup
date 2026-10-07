# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex) working in this repository.
Read this first; read the docs below before non-trivial changes.

- `docs/PRODUCT.md`: what Tunarr Lineup is, who uses it, terminology, intended behavior
- `docs/ARCHITECTURE.md`: how the code actually works (entry points, data flow, proxy, build)
- `docs/DECISIONS.md`: decisions already made and the evidence for them
- `README.md`: end-user setup (Docker, local Node, environment variables)

## What this is

A Mac OS 9–styled programming desk for [Tunarr](https://tunarr.com) channels:
arrange, insert and remove programs, build and edit slot schedules (season filters,
linked slots), start channels from programming templates (general, network-inspired for
Japan, Argentina, the US, Spain, the UK and Italy, the user's own, or AI-written), place
events on dates, and manage commercials, filler lists, custom shows, smart collections,
channels (create, duplicate, delete, logos, streaming), media sources and transcode
profiles. It ships as two targets built from one React page (`app/page.tsx`):

- **Local companion** (supported for real use): `server/` (dependency-free Node HTTP
  server plus a narrow `/api/tunarr/*` proxy) serving a Vite build of the page.
  Configured by `TUNARR_URL`. Docker: `Dockerfile`, `docker-compose.example.yml`.
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
TUNARR_URL=http://localhost:8000 npm run dev:local    # companion dev server on :3000
TUNARR_URL=http://localhost:8000 npm run start:local  # run the built companion
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
   (`vite.local.config.ts`). Never add a user-entered URL workflow for reaching Tunarr,
   wildcard CORS, or a generic proxy. Channel logos come through
   `/api/tunarr/channels/:id/logo` (`server/logos.ts`); public logo hosts are fetched
   by the companion with the guards there (public addresses only, ports 80/443, image
   types, size and redirect limits), never by the browser. The AI provider is likewise
   configured and called only by the companion (`server/ai.ts`, `LINEUP_AI_*`); its key
   and address never reach the browser, and its replies are validated as templates.
2. **The proxy stays an allowlist.**
   - Channel routes live in `server/tunarrProxy.ts` (`matchRoute`). Library, list and
     channel-settings routes live in `server/content.ts` (`matchContentRoute`). Setup
     routes (channels, transcode profiles, media sources, smart collections) live in
     `server/admin.ts` (`matchAdminRoute`). Lineup's own routes (saved templates, filler-list roles, the media folder, AI)
     live in `server/lineupRoutes.ts` (`matchLineupRoute`); templates are always checked
     with `validateTemplate` (`server/templateSchema.ts`). Every route is explicit, IDs are validated,
     and no raw Tunarr request is accepted: search filters and smart-collection filters
     are built server-side (`buildLibrarySearch`, `rulesToFilter`), channel settings and
     transcode profiles are allowlists merged onto Tunarr's copy, and media sources are
     sanitized so server addresses, tokens, accounts and folder paths never reach the
     browser.
   - Slot schedules are validated in `server/slotSchedule.ts` (`buildSchedule`), and
     the program pool is computed server-side.
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
     nothing is overwritten, and nothing is written anywhere else.
4. **Every save is conditional.**
   - The client sends `If-Match` with `programmingVersion(lineup, schedule)` of what it
     loaded (`server/lineupVersion.ts`, shared with the browser).
   - The proxy re-checks it under a per-channel lock (`withChannelLock`) and answers
     412 `lineup_changed` on mismatch.
   - Manual saves use `{ "type": "manual", "lineup": [...], "append": false }`; afterwards,
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
   the Dockerfile deliberately. Its only stored state is saved templates in
   `LINEUP_DATA_DIR/templates.json` (`server/templateStore.ts`) and filler-list roles in
   `LINEUP_DATA_DIR/filler-roles.json` (`server/fillerRoleStore.ts`, owner decision
   2026-10-07), both through `server/jsonFile.ts`: atomic writes, and a file it can't
   parse is never overwritten. When `LINEUP_MEDIA_DIR` is set, it also holds the
   filler videos users upload there.
8. **Keep the desk TV/remote-operable.** Every action must be reachable without a
   mouse: arrow keys, Enter/OK, Escape/Back, PageUp/PageDown or CH±, the menus and
   the `?` shortcut list. Don't add hover-only or drag-only features.
9. **Preserve the Mac OS 9 visual treatment**: platinum chrome, striped title bars, 1px
   bevels. The interface is used on a TV, so keep text large and smooth. Size things in
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
  `events.ts` (placing events on dates), `fillerRoles.ts` (filler-list roles, spot lengths),
  `airKinds.ts` (station-log kinds: breaks, IDs, flex; hour summaries, break rundowns), and
  `programInfo.ts` for titles, artwork and logo URLs.
- **Put HTTP and validation logic in `server/`:** `tunarrProxy.ts` (framework-free),
  `content.ts`, `admin.ts`, `logos.ts`, `smartCollection.ts`, `templateSchema.ts`,
  `templateStore.ts`, `fillerRoles.ts`, `fillerRoleStore.ts`, `mediaFolder.ts`, `jsonFile.ts`, `lineupRoutes.ts`, `ai.ts`, `upstream.ts`,
  `slotSchedule.ts`, `lineupVersion.ts`, `auth.ts`, `hosts.ts` and `app.ts`. `lib/` and
  `app/` may import pure modules from `server/` (`lineupVersion`, `slotSchedule`,
  `smartCollection`, `templateSchema`, `fillerRoles`) but never Node APIs (`logos.ts`,
  `jsonFile.ts`, `mediaFolder.ts` and the stores use Node built-ins).
- **Keep `app/page.tsx` for UI state and rendering,** and `app/components/` for larger
  UI pieces: `MenuBar`, `MoveDialog`, `ScheduleEditor`, `InsertDialog`,
  `LibraryBrowser`, `ListsManager`, `ChannelSettingsDialog`, `NewChannelDialog`,
  `SmartCollectionsManager`, `MediaSourcesDialog`, `FillerFoldersDialog`, `TranscodeProfilesDialog`,
  `TemplatesDialog` (gallery, AI panel), `TemplateEditor`, `EventDialog`, `DayStrip`.
  `app/useFillerSpots.ts` loads filler lists, their roles and spots for the day view.
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
