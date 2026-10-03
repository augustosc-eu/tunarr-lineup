# Decisions

Architectural and product decisions that can be established from this
repository. Each entry is labelled with its evidence:

- **Explicit**: stated in `README.md` or in code comments (quoted or cited).
- **Evidenced**: not stated, but clearly shown by the implementation.

Reasons are given only where the repository states them. Otherwise the entry
says the reason is not recorded.

The first two commits were authored by "Codex Sites <sites@openai.com>":
"Build Tunarr Lineup" and "Restyle Tunarr Lineup for Mac OS 9". Later work is
on the `broadcast-programming` branch.

---

## D1. Two deployment targets sharing one UI

- **Status:** Explicit (`README.md` "Architecture", `local/main.tsx` comment, `vite.local.config.ts` header comment).
- **Decision:** Keep the hosted Vinext site as a demo/preview. Add a local Node companion that serves the same `app/page.tsx` plus a same-origin proxy, as the supported way to edit real channels.
- **Stated reason:** an HTTPS page served from the internet can't call a private HTTP Tunarr (mixed content, CORS, private-network access), and a Cloudflare Worker can't reach the LAN. The README rejects weakening browser security.

## D2. The browser never talks to Tunarr directly

- **Status:** Explicit (`README.md`; comments in `server/tunarrProxy.ts`, `lib/tunarrClient.ts`, `server/main.ts`, `vite.local.config.ts`).
- **Decision:** All Tunarr access goes through `/api/tunarr/*` on the app's origin. `TUNARR_URL` is server-side only and is never exposed to the client (`envPrefix: 'LINEUP_PUBLIC_'`). The served page sets CSP `connect-src 'self'`.
- **Replaces:** the original implementation in commit `1d77ac6`, which fetched a user-entered Tunarr URL from the browser and stored it in `localStorage` (`tunarr-lineup-url`). That workflow was removed.

## D3. A narrow allowlist proxy, not a general proxy

- **Status:** Explicit (`server/tunarrProxy.ts` header: "It is deliberately not a general proxy…"; `README.md` "Proxy routes").
- **Decision:**
  - Five fixed routes and methods.
  - The upstream origin is fixed by configuration, and channel IDs are regex-validated.
  - Query parameters are allowlisted, and the lineup range is capped at 14 days.
  - Redirects aren't followed and browser cookies or auth are never forwarded.
  - Timeouts default to 10 s for reads and 30 s for saves.
  - Errors are normalized and never include credentials or stack traces.
- **Stated reason:** prevent SSRF and keep upstream access limited to what the UI needs (header comment).

## D4. Framework-free proxy core with thin adapters

- **Status:** Evidenced.
- **Decision:** `handleTunarrApi` takes and returns plain objects (`ProxyRequest`/`ProxyResponse`), so the same code runs in the production server (`server/main.ts`) and the Vite dev middleware (`vite.local.config.ts`) and can be unit-tested with an injected `fetchImpl`.
- **Reason:** not recorded beyond the "framework-free" adapter comment in `server/nodeAdapter.ts`.

## D5. Dependency-free companion server

- **Status:** Explicit (`Dockerfile` comment: "The server has no runtime dependencies; only the built output is shipped").
- **Decision:** `server/` uses only Node built-ins, compiled with `tsc`. The runtime image contains no `node_modules`.
- **Consequence:** adding a runtime dependency to `server/` requires changing the Dockerfile.

## D6. Manual-lineup saves that preserve every item field

- **Status:** Explicit (`lib/lineup.ts` comment on `buildManualSave`; `README.md`).
- **Decision:**
  - Saves send `{type: 'manual', lineup, append: false}`.
  - Lineup objects are forwarded untouched, so Tunarr's own fields (flex filler config, redirect targets, custom-show and filler references, offsets) survive.
  - Zero-length items are omitted because Tunarr won't accept them (comment).
  - The UI reports how many items were left out.

## D7. ~~Rearrange-only editing~~ (superseded by D29)

- **Status:** Superseded. The original build explicitly limited editing to reordering ("This view only changes programs already assigned to a channel"). On 2026-10-03 the owner asked to "fully edit, add commercials, add fillers, everything". See D29.

## D8. Re-fetch after save instead of trusting local state

- **Status:** Explicit (comment in `performSave`: "Re-read what Tunarr actually stored rather than trusting local state.").
- **Decision:** After a successful POST, reload programming, the visible day's guide, and the channel list.

## D9. Warn before saving over a generated schedule

- **Status:** Explicit (confirm-dialog copy in `save()`; `README.md`).
- **Decision:** If programming has a `schedule`, confirm first. Saving a manual lineup can detach the channel from that schedule, and regeneration may overwrite manual edits.

## D10. No silent fallback to demo data

- **Status:** Explicit (comment above `noteFailure`: "live mode stays live: it never switches to demo data on its own"; `README.md`; tests in `tests/page.test.tsx` "no silent fallback to demo mode").
- **Decision:**
  - The app starts in live mode with no data and checks health.
  - Demo mode requires the user to choose **Use demo data**, and it is labelled throughout.
  - The hosted preview reports "Live mode unavailable" rather than showing sample data immediately.

## D11. Guide where available, projection elsewhere

- **Status:** Explicit (`lib/lineup.ts` comments on `scheduleForDay`, `nearestById`, `instancesFromGuide`).
- **Decision:**
  - Date navigation requests Tunarr's `/lineup` guide for the local day.
  - Because Tunarr keeps a guide only for a window around "now" and it can lag behind edits, the day is filled from the lineup projection outside the guide window.
  - A guide where less than half the time span matches the lineup is treated as stale and ignored.
  - Drifted entries are matched by program id.
  - The UI labels which source each part of the day comes from.
- **Not recorded:** the 50% stale threshold has no stated rationale.

## D12. Local, component-level state only

- **Status:** Evidenced.
- **Decision:** All UI state lives in `useState` hooks inside `Home`, including selection, edit history and grab state, with request-counter refs to drop stale responses. Larger UI pieces are split into `app/components/`, but state stays in `Home`. There's no state library, router, context or browser storage.
- **Reason:** not recorded.

## D13. Artwork only through the companion

- **Status:** Explicit (comment on `programArtwork` in `lib/programInfo.ts`; `fetchArtwork` in `server/tunarrProxy.ts`; `README.md`).
- **Decision:**
  - Live artwork is loaded from `/api/tunarr/programs/:id/artwork/:type`, which proxies Tunarr's own artwork endpoint. Only UUID program ids, four artwork types and image content types up to 8 MB are accepted, and redirects are not followed.
  - Raw `artwork[].path` URLs are never used. Embedded `data:image/` icons are shown as-is; demo data has none.
- **Stated reason:** the browser must not contact Tunarr or a media server directly.
- **Replaces:** an earlier state of this branch that showed no remote artwork at all.

## D14. Mac OS 9 visual identity

- **Status:** Explicit that it was done (commit `fa10bfd` "Restyle Tunarr Lineup for Mac OS 9"). Evidenced by `app/globals.css`.
- **Decision:** Platinum chrome, striped title bars drawn with gradients, bevelled buttons, CSS-generated window titles, and a Geneva/Charcoal/Chicago font stack.
- **Reason:** not recorded.

## D15. TV-readable, viewport-scaled typography

- **Status:** Explicit (`app/globals.css` comment: "Everything is sized in rem, so the whole interface scales with the screen: 16px on laptops, about 24px on a 1080p TV viewed from the couch.").
- **Decision:**
  - The root font size is `clamp(16px, 1.25vw, 32px)` and every size is in `rem`, except 1px hairlines.
  - Font smoothing is on (`antialiased`), and base type is at least 13px before scaling.
- **Replaces:** the earlier `-webkit-font-smoothing: none` with body text mostly 8–12px (commit `fa10bfd` stylesheet).

## D16. Hosted target scaffolded by OpenAI Sites on Vinext with a Workers-style runtime

- **Status:** Evidenced (`vite.config.ts` plugins `vinext()`, `sites()`, `cloudflare()`; `.openai/hosting.json`; commit author; `metadataBase` default `*.chatgpt.site`; `package.json` name `sites-project`).
- **Decision:**
  - The hosted app is a Next App Router app run by Vinext.
  - It is packaged for OpenAI Sites, with no D1 or R2 bindings.
  - It uses a polling watcher under Codex's seatbelt sandbox (explicit comment in `vite.config.ts`).
- **Not recorded:** why this stack was chosen. The deployment pipeline is outside the repo.

## D17. Tailwind present but effectively unused

- **Status:** Evidenced.
- **Decision:** `@import 'tailwindcss'` stays in `app/globals.css` (which provides Tailwind's base/preflight), but styling uses custom classes. Only `antialiased` appears as a utility.
- **Not recorded:** whether Tailwind is intended for future use or is scaffold residue.

## D18. CSRF mitigation, plus optional sign-in

- **Status:**
  - The CSRF mitigation is evidenced (`isCrossOrigin`; 415 for non-JSON POSTs; tests).
  - Optional sign-in is explicit (`server/auth.ts` header comment; `README.md` "Sign-in").
- **Decision:**
  - Cross-site writes are always refused, by the Origin check and by the JSON content type, which forces a preflight the server never approves.
  - Sign-in is optional HTTP Basic, off unless `LINEUP_PASSWORD` is set. `/healthz` stays open for container checks. Credentials are compared through SHA-256 digests with `timingSafeEqual`.
  - The server logs a warning when it listens on a non-loopback host without a password.
- **Not recorded:** why sign-in is off by default rather than required.

## D19. Testing approach

- **Status:** Evidenced (`vitest.config.ts`, `tests/`, `playwright.config.ts`, `e2e/`, `.github/workflows/ci.yml`).
- **Decision:**
  - **Vitest:** pure-function tests for `lib/`; handler tests with an injected fetch for the proxy; real-HTTP tests for the server app (`createLineupServer`); jsdom plus Testing Library with a stateful fake companion for the UI.
  - **Playwright:** drives the built companion against a stateful fake Tunarr (`e2e/fake-tunarr.mjs`) at TV resolution.
  - **CI** runs all of it, plus a Docker build and healthcheck.
  - Tests never write to a real Tunarr.

## D20. Day boundaries in the viewer's local time zone

- **Status:** Evidenced (`dayRange` uses `new Date('YYYY-MM-DDT00:00:00')`; formatters use the default time zone).
- **Decision:** The "day" shown and requested from Tunarr is the browser's local calendar day, sent to Tunarr as UTC ISO timestamps.
- **Reason:** not recorded.

## D21. A "programming desk" feature set

- **Status:** Explicit (`README.md` "Programming desk features").
- **Decision:** Add broadcast-scheduling tools on top of rearranging:
  - an on-air line and **Now**
  - `HH:MM:SS` timecode and cycle length
  - day airtime totals by type
  - block selection and block moves
  - move to position or to a start time
  - an edit list with step undo and redo
  - program-log CSV export
  - functional pull-down menus

  Introduced while D7 was in force; the same tools now also work on inserted items (D29).

## D22. Conditional saves, checked in the companion

- **Status:** Explicit (comments in the `programming` case of `handleTunarrApi`: "Conditional save: Tunarr has no If-Match of its own…"; `withChannelLock`; `server/lineupVersion.ts` header).
- **Decision:**
  - Every save sends `If-Match` with `programmingVersion(lineup, schedule)` of what the client loaded.
  - The companion re-reads the channel and compares versions while holding a per-channel lock, then writes. It answers `412 lineup_changed` on a mismatch and `428` when the header is missing.
  - The UI offers **Reload from Tunarr** or **Keep my edits**. There is no "overwrite anyway".
- **Why server-side:** the check and the write can't interleave with another Lineup session's save (it was previously a client-side pre-read, which left a gap).
- **Why not a crypto hash:** the fingerprint is non-cryptographic because Web Crypto is unavailable to pages served over plain HTTP, and the browser must compute the same value.
- **Known limitation:** an edit made in Tunarr's own UI in the milliseconds between the companion's check and its write is not detected. Closing that would need a conditional write in Tunarr itself.

## D23. Keyboard and TV remote as first-class input

- **Status:** Explicit (comment above the `keydown` effect in `app/page.tsx`: arrow keys map to a remote's D-pad, Enter to OK, Escape/Back to Back, PageUp/PageDown to CH+/CH−; `MenuBar` header comment; `AGENTS.md` invariant).
- **Decision:**
  - Every command is reachable without a mouse. Moving uses a pick-up / slide / drop model (`grab`), with Back cancelling to the exact prior lineup.
  - The whole slide becomes one undo entry.
- **Evidence for the reason:** the owner uses the app on a TV (`app/globals.css` comment). Beyond that, the reason isn't recorded.

## D24. Undo history as snapshots, persisted per channel and version

- **Status:** Explicit (`lib/history.ts` header; `lib/draftStore.ts` header: drafts "survive reloads, channel switches and the TV being turned off"; `rebaseHistory` doc comment).
- **Decision:**
  - **Snapshots.** Each history entry stores the lineup arrays before and after (permutations of the loaded `base.lineup` objects) plus the selections. History is capped at 200 entries.
  - **Persistence.** Drafts (current order plus history) are stored per channel in IndexedDB as index arrays, tagged with the programming version they were made against.
    - Same version on load → restored.
    - Different version → dropped, with a notice.
    - IndexedDB unavailable → kept in memory for the session only.
  - **Across a save,** history is re-attached to Tunarr's returned objects. If they don't line up item for item, it starts fresh with a notice.
  - **Not persisted:** slot-schedule saves regenerate the lineup, so they start a fresh edit list, and demo edits aren't stored.
- **Replaces:** the earlier in-memory history, which was cleared on reload, save and channel switch.

## D25. Blocks are contiguous lineup ranges

- **Status:** Explicit (comment in `moveCursor`: "A block must stay contiguous in the lineup, so stop extending across a cycle wrap.").
- **Decision:** Multi-selection is an anchor/focus range of lineup indices. Shift-extension across the cycle wrap is refused. Swap is offered only for single items.

## D26. Move-to-time is computed against the real cycle

- **Status:** Explicit (`moveBlockToTime` doc comment).
- **Decision:** Every insertion point is evaluated against the full cycle length, which is unchanged by a move. The UI previews the exact resulting start and its offset from the requested time before anything changes.
- **Replaces:** an earlier draft on this branch that measured against the lineup without the block. It was wrong beyond the first cycle, and a regression test now covers it.

## D27. Program log export guards against spreadsheet formulas

- **Status:** Explicit (comment in `toCsv`).
- **Decision:** CSV cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`, and values are quoted per RFC 4180. Exports of unsaved lineups get an `-unsaved` filename suffix.

## D28. Slot schedules: full editing, validated in the companion

- **Status:**
  - Explicit (`server/slotSchedule.ts` header: "Lineup can create, convert and fully edit a channel's schedule"; `README.md`).
  - History:
    1. Slot editing was first excluded.
    2. The owner approved it on 2026-10-03, limited to existing sources.
    3. The owner widened it to "everything" the same day.
- **Decision:**
  - **What can be edited:** any source (library shows, movies, custom shows, filler lists, smart collections, redirects, flex); schedule-wide settings from a per-type allowlist; per-slot commercials (`filler` entries and `midRoll` breaks); conversion between random and time slots; creating a schedule for a manual channel; and **Detach to manual lineup**.
  - **What the companion enforces** (`buildSchedule`):
    - It starts from Tunarr's current schedule when the type is unchanged, so fields Lineup doesn't edit are kept. Otherwise it starts from Tunarr's editor defaults.
    - It validates source ids, orders, timing, weights, filler and mid-roll shapes.
    - It computes the program pool server-side (`programPool`) and accepts extra program ids only as validated UUIDs.

  Tunarr's strict validation still runs.
- **Preview first:** saving requires a preview of the exact draft, reuses its seed, and reports any difference. Movies added to the pool are not part of Tunarr's preview (its preview API has no program list), and the UI says so.
- **Not built:** per-season filters on show slots, editing iteration groups (existing ones are kept), per-slot time overrides, and smart-collection authoring. Slot-schedule drafts are not persisted.
## D29. Full lineup editing through Tunarr's APIs

- **Status:**
  - Explicit: the owner's request on 2026-10-03, `AGENTS.md` invariant 3, and `README.md` "Full lineup editing".
  - Evidenced: `insertItems`, `removeBlock`, `setItemDuration` and `makeCommercialBreak` in `lib/broadcast.ts`.
- **Decision:**
  - The manual lineup can gain programs from Tunarr's indexed libraries, commercial breaks, flex and redirects; items can be removed and flex, break and redirect lengths changed.
  - Every change goes through the same edit list, drafts and conditional save.
  - Inserted programs are minimal content entries (`{ type: 'content', id, duration }`); Tunarr validates that they exist.
  - Lineup still doesn't add media sources, scan libraries, create channels, or change transcoding or streaming.

## D30. "Commercials" are Tunarr filler

- **Status:** Evidenced (`makeCommercialBreak`, `SlotCommercials`, `ChannelSettingsDialog`, `ListsManager`).
- **Decision:** Lineup has no commercial system of its own. It maps "commercials" onto Tunarr's existing filler features:
  - filler lists, managed in Lineup
  - **commercial breaks** in manual lineups: flex items with `fillerConfig.fillerListIds`
  - **slot commercials**: `filler` entries (pre, post, head, tail, mid, fallback) and `midRoll` breaks
  - **channel flex filler**: `fillerCollections` with weights and cooldowns
- **Reason:** not recorded beyond reusing Tunarr's mechanisms, so playout behaves exactly as Tunarr's own UI would configure it.

## D31. Content routes are explicit and sanitized

- **Status:** Explicit (`server/content.ts` header; tests in `tests/content.test.ts` and `e2e/desk.spec.ts`).
- **Decision:**
  - Library browsing, lists and channel settings get their own allowlisted routes.
  - **Search:** filters are built server-side from a small query (no raw Tunarr filters).
  - **Media sources:** returned without server addresses or accounts.
  - **Channel settings:** an allowlist merged onto Tunarr's current channel under the channel lock, so transcoding, streaming and other fields are never sent from the browser.
  - **Custom shows:** updates re-send their Plex sync settings, because Tunarr's update otherwise clears them.

## D32. Search paging normalized by the companion

- **Status:** Explicit (comment in `buildLibrarySearch`, citing Tunarr's `SearchProgramsCommand`).
- **Decision:** Tunarr pages free-text searches from 1 and plain listings from 0. Lineup always uses 0-based pages, and the companion adds 1 for free-text queries.
- **Why it's recorded:** the first build sent 0 for text searches and got empty pages (with a non-zero `totalHits`) on the owner's server.
