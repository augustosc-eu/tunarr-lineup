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
- **Decision:** If programming has a `schedule`, confirm first. A manual save keeps Tunarr's slot schedule (`LineupRepository` only replaces the items), but regenerating it (saving the slot schedule, or a start-time change) replaces the edited lineup.

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
  - The root font size is `clamp(16px, min(1.25vw, 2.2223vh), 32px)` and every size is in `rem`, except 1px hairlines. The height term (added 2026-10-06) keeps short, wide windows such as a 2560×1080 monitor at 24px instead of 32px; a 1080p TV is unchanged at 24px.
  - Font smoothing is on (`antialiased`), and base type is at least 13px before scaling.
- **Replaces:** the earlier `-webkit-font-smoothing: none` with body text mostly 8–12px (commit `fa10bfd` stylesheet).

## D16. Hosted target scaffolded by OpenAI Sites on Vinext with a Workers-style runtime

- **Status:** Evidenced (`vite.config.ts` plugins `vinext()`, `sites()`, `cloudflare()`; `.openai/hosting.json`; commit author; `metadataBase` default `*.chatgpt.site`; `package.json` name `sites-project`, renamed `tunarr-lineup` on 2026-10-05).
- **Decision:**
  - The hosted app is a Next App Router app run by Vinext.
  - It is packaged for OpenAI Sites, with no D1 or R2 bindings.
  - It uses a polling watcher under Codex's seatbelt sandbox (explicit comment in `vite.config.ts`).
- **Not recorded:** why this stack was chosen. The deployment pipeline is outside the repo.
- **Superseded in part (2026-10-05, owner request "remove openai sites"):** the `sites()` plugin, `@openai/sites-vite-plugin`, `.openai/hosting.json`, its placeholder D1/R2 bindings, the Codex sandbox polling and the `*.chatgpt.site` `metadataBase` default were removed. The Vinext build for a Cloudflare Workers runtime stays as a demo-only target that anyone can deploy.

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
- **Not built:** per-slot time overrides. Slot-schedule drafts are not persisted. (Season filters, linked slots and smart-collection authoring were added later; see D34 and D35.)
## D29. Full lineup editing through Tunarr's APIs

- **Status:**
  - Explicit: the owner's request on 2026-10-03, `AGENTS.md` invariant 3, and `README.md` "Full lineup editing".
  - Evidenced: `insertItems`, `removeBlock`, `setItemDuration` and `makeCommercialBreak` in `lib/broadcast.ts`.
- **Decision:**
  - The manual lineup can gain programs from Tunarr's indexed libraries, commercial breaks, flex and redirects; items can be removed and flex, break and redirect lengths changed.
  - Every change goes through the same edit list, drafts and conditional save.
  - Inserted programs are minimal content entries (`{ type: 'content', id, duration }`); Tunarr validates that they exist.
  - Media sources, library scans, channel creation and transcoding/streaming were out of scope here; D33 later brought them in.

## D30. "Commercials" are Tunarr filler

- **Status:** Evidenced (`makeCommercialBreak`, `SlotCommercials`, `ChannelSettingsDialog`, `ListsManager`).
- **Decision:** Lineup has no commercial system of its own. It maps "commercials" onto Tunarr's existing filler features:
  - filler lists, managed in Lineup
  - **commercial breaks** in manual lineups: flex items with `fillerConfig.fillerListIds`
  - **slot commercials**: `filler` entries (pre, post, head, tail, mid, fallback) and `midRoll` breaks
  - **channel flex filler**: `fillerCollections` with weights and cooldowns
- **Reason:** not recorded beyond reusing Tunarr's mechanisms, so playout behaves exactly as Tunarr's own UI would configure it.
- **Amended by D45:** filler lists now carry a role (station IDs, commercials, promos, bumpers) kept by Lineup.

## D31. Content routes are explicit and sanitized

- **Status:** Explicit (`server/content.ts` header; tests in `tests/content.test.ts` and `e2e/desk.spec.ts`).
- **Decision:**
  - Library browsing, lists and channel settings get their own allowlisted routes.
  - **Search:** filters are built server-side from a small query (no raw Tunarr filters).
  - **Media sources:** returned without server addresses or accounts.
  - **Channel settings:** an allowlist merged onto Tunarr's current channel under the channel lock, so fields outside it are never sent from the browser. (D33 added streaming, logo, watermark and offline fields to the allowlist.)
  - **Custom shows:** updates re-send their Plex sync settings, because Tunarr's update otherwise clears them.

## D32. Search paging normalized by the companion

- **Status:** Explicit (comment in `buildLibrarySearch`, citing Tunarr's `SearchProgramsCommand`).
- **Decision:** Tunarr pages free-text searches from 1 and plain listings from 0. Lineup always uses 0-based pages, and the companion adds 1 for free-text queries.
- **Why it's recorded:** the first build sent 0 for text searches and got empty pages (with a non-zero `totalHits`) on the owner's server.

## D33. Setting up Tunarr from Lineup (channels, media sources, transcoding)

- **Status:** Explicit: the owner's request on 2026-10-03 ("creating or deleting channels, adding media sources, and transcoding or streaming settings"), `AGENTS.md` invariant 3, `server/admin.ts` header.
- **Decision:**
  - Channels can be created (Tunarr's web defaults, default transcode profile, next free number), duplicated (Tunarr's `copy`, then renamed) and deleted (after a confirmation).
  - Channel settings also cover the logo, watermark, offline screen, stream mode, transcode profile, subtitles, hidden and on-demand flags.
  - Transcode profiles can be edited from an allowlist (`TRANSCODE_FIELDS`), duplicated and deleted. The default profile and profiles in use can't be deleted. VAAPI device paths and drivers are left as Tunarr has them.
  - Media sources can be added (Plex with a token; Jellyfin and Emby by signing in through Tunarr; local folders), removed, refreshed, and their libraries enabled and scanned.
- **Secrets are write-only:** server addresses, tokens and passwords go to Tunarr and are never returned (`manageableSources` drops `uri`, `accessToken`, `username`, `userId` and `paths`). Jellyfin/Emby passwords are only passed to Tunarr's login endpoint, never stored.
- **Still out of scope:** uploading or creating media files (uploads into the media folder were allowed later, see D46), Tunarr's global settings (FFmpeg, HDHomeRun, XMLTV), Plex OAuth sign-in (a token is entered instead).

## D34. Season filters and linked slots follow Tunarr's own rules

- **Status:** Evidenced (`validateEpisodesAndLinks` and `checkLinkGroups` in `server/slotSchedule.ts`, a port of Tunarr's `slotGroupValidator.ts`; `linkSlot` in `lib/schedule.ts`).
- **Decision:**
  - Show slots carry `seasonFilter` (only these) or `seasonExcludeFilter` (all but these). The editor uses one at a time. Non-show slots have them removed.
  - Linked slots share an `iterationGroup` (a UUID). Every member must play the same source in the same order and direction; a group of one is unlinked. Linking a slot copies the group's order and direction, and changing either changes the whole group.
  - Random-slot groups must all continue, so the rerun choice is only offered for time slots, and converting to random turns reruns into continues. Time-slot groups need at least one slot that continues.

## D35. Smart collections are authored as rules

- **Status:** Evidenced (`server/smartCollection.ts`, `SmartCollectionsManager`).
- **Decision:**
  - The browser sends rules (`{field, op, values|value|amount+unit}`) and match all/any; the companion builds Tunarr's filter tree (`rulesToFilter`) from a fixed field table, so no raw filter or query string is accepted.
  - Stored filters are read back as rules when possible (`filterToRules`). A collection made in Tunarr with something else is shown with its query string, and its filter is kept unless new rules replace it.
  - Removing every rule from a saved collection is refused: Tunarr's update keeps the old filter when none is sent.
- **Why the field table:** it mirrors Tunarr's search aliases (`shared/src/util/searchUtil.ts`), including unit conversion for minutes and the `relativeDate` form for "in the last N weeks".

## D36. Channel logos come through the companion, including public ones

- **Status:** Evidenced (`server/logos.ts`, `tests/admin.test.ts`). Checked read-only against the owner's server on 2026-10-03: 103 of 104 logos loaded (68 uploads saved under `host.docker.internal`, 14 under a tailnet name, 1 under `localhost`, 14 TMDB, 6 YouTube); the remaining one is a dead YouTube link.
- **Decision:**
  - Uploaded logos are loaded from `TUNARR_URL` by path, ignoring the host they were saved under.
  - Logos on public sites are fetched by the companion with SSRF guards (public addresses only, pinned DNS, ports 80/443, re-checked redirects, image types, size and time limits) and cached. `LINEUP_EXTERNAL_LOGOS=false` turns this off.
  - A missing or unusable logo is `204`, and the interface shows the channel number.
- **Reason:** keeps invariant 1 (the browser only talks to the companion) and the page's `img-src 'self'` CSP, while real channels' logos point at several hosts the browser often can't reach (`host.docker.internal`) or shouldn't contact directly.

## D37. Programming templates are styles that become ordinary drafts

- **Status:** Explicit: the owner's request on 2026-10-03 ("programming templates such as for general TV channels, brands such as FOX, Telefe, Asahi, NHK, HBO"). Evidenced: `lib/templates.ts`, `TemplatesDialog`, `tests/templates.test.ts`.
- **Decision:**
  - A template is roles plus daypart grids plus an ad style. It produces a time-slot draft that opens in the slot editor, so the existing validation, preview-before-save and conditional save all apply. Nothing is written to the channel by the template itself; the only writes before the editor opens are the smart collections the user chose to create (and a new channel when asked).
  - Network names appear only as "Inspired by …" text. Templates describe a style, say they are not official schedules, and use no logos or branding.
  - Every template, with all roles filled, must pass `buildSchedule` (tested).
  - Suggestions use playable types and `show_genre` for TV (see ARCHITECTURE, *Programming templates*), measured against the owner's library.
- **Later (2026-10-04):** saved templates (D38), per-block ad levels, the network catalog (D41), AI templates (D39) and events by date (D40) were added.

## D38. Saved templates are stored by the companion

- **Status:** Explicit: the owner asked for "saving your own templates" (2026-10-04). Evidenced: `server/templateStore.ts`, `server/lineupRoutes.ts`.
- **Decision:** Saved templates live in one JSON file on the Lineup server (`LINEUP_DATA_DIR`, a Docker volume at `/data`), not in the browser, so the TV, laptop and phone share them. Writes are serialized and atomic, the server picks ids (`my-…`) so built-ins can't be shadowed, and a file it can't parse is reported and left alone. This is the companion's first stored state; Tunarr still holds all channel data.
- **Alternatives considered:** browser IndexedDB (per device, like drafts) was rejected because the owner programs from the TV and other devices.

## D39. The AI assistant writes templates, never schedules

- **Status:** Explicit: the owner asked for "AI prompts to generate schedule / programming based on channels" (2026-10-04). Evidenced: `server/ai.ts`, tests in `tests/ai.test.ts`.
- **Decision:**
  - The provider (Anthropic Messages API, or any OpenAI-compatible API such as OpenAI or a local Ollama) is configured only on the server; it's off until set.
  - The model gets the prompt, list names and, by choice, the library's show and movie titles/genres and what the channel plays, and must answer through one tool schema.
  - Its answer goes through the same `validateTemplate` as anything else; ids not in the catalog are dropped. The result is a draft template the user saves, edits or applies, and applying still goes through preview and the conditional save.
- **Default model:** `claude-sonnet-5-5` for Anthropic; any model can be set with `LINEUP_AI_MODEL`.
- **Not verified live:** no provider key was available while building; both wire formats are covered by tests with fake providers, and the end-to-end suite runs against a fake OpenAI-compatible endpoint.

## D40. Events by date are lineup edits

- **Status:** Explicit: the owner asked for "scheduling sports or events by date" (2026-10-04). Evidenced: `lib/events.ts`, `EventDialog`.
- **Decision:** Tunarr's schedules have no dated items and Tunarr can't cut a program short, so an event is placed into the lineup at a program boundary: replacing what would have aired (padding with flex to keep later programs on time) or pushing everything later. It is an ordinary edit: undoable, drafted, saved with the conditional save.
- **Consequences, shown in the dialog:** the start may move to the nearest boundary; a replacing event that runs past the end of the lineup makes the lineup longer (the cycle can't wrap), so later repeats move; the event repeats every lineup cycle (a 30-day generated lineup airs it again 30 days later); on slot-scheduled channels, regenerating the schedule removes it.

## D41. Network templates cover mainstream and music channels in seven countries

- **Status:** Explicit: the owner asked for "all mainstream Japanese, Argentine, US, Spain, UK, and Italian channels" and later for MTV Japan, Space Shower TV, MUSIC ON! TV, Music Japan TV, MTV, VH1, MuchMusic and other music channels (2026-10-04). Evidenced: `lib/networkTemplates.ts`, `tests/templates.test.ts`.
- **Decision:** The catalog has templates for 11 Japanese, 6 Argentine, 20 US broadcast and cable, 1 Canadian, 6 Spanish, 7 British and 7 Italian networks. The music additions include four Japanese formats, classic MTV/VH1/MuchMusic styles, country, hip-hop/R&B, UK request-pop and UK rock. They use shared role presets, music-video rules and market ad styles. Each is a simplified daypart plan in the network's style, not an official current schedule; the new music templates keep network names only in "Inspired by …" metadata and use no logos.

## D42. Answer only to known host names when sign-in is off

- **Status:** Explicit: the owner asked to fix the issues found in the pre-release review (2026-10-05). Evidenced: `server/hosts.ts`, `tests/hardening.test.ts`.
- **Decision:** Without `LINEUP_PASSWORD`, the companion refuses requests whose `Host` isn't an IP address, `localhost`, or a name in `LINEUP_ALLOWED_HOSTS`. This closes DNS rebinding, which the Origin check alone can't detect. With sign-in on, any name is accepted, because a rebound page has no credentials and gets `401`.
- **Alternatives considered:** checking only when sign-in is on as well was rejected, because it would break people who open a password-protected Lineup by a host name, for no added protection. Trusting `x-forwarded-host` was rejected, because a same-origin page can set it.
- **Consequence:** people who open Lineup without a password by a name such as `nas.local` must add it to `LINEUP_ALLOWED_HOSTS`. The 403 page says so.

## D43. Insert anywhere, at the time it will really air

- **Status:** Explicit (owner request, 2026-10-06: "we need to ensure we can insert programs into any channel at any time"). Prompted by an insert on a 50-day lineup that landed weeks away from the program on screen.
- **Decision:**
  - Insert works on every channel: empty lineups, generated schedules (with the existing save warning) and any day. Besides before/after the selection, it takes a date and time, snapped to a program boundary like events (D40).
  - A channel opens with the program on air selected (owner decision, 2026-10-06). Until a row on the day shown is picked, the selection stays on what's on air (or the day's first program), never an off-screen lineup item. Tests that act on a specific row pick it first, so they don't depend on the clock.
  - A manual lineup repeats from the channel's fixed start time, so inserting L ms makes every pass L longer and moves a channel that has repeated N times by N×L. Placement is worked out on the new cycle (`boundaryAt`, `insertedStart`), the dialog states the start time and the repeat effect first, and the desk then follows the items to the day they air.
- **Keeping what's on air in place** is an opt-in per draft (owner decision, 2026-10-06). On save, the companion moves the channel's start time by N×L (`keptStartTime`), so the pass airing now keeps its times.
  - It is a second write, made under the same channel lock after the lineup save. If it fails, the result is an ordinary save, and the reply says so; it doesn't roll back.
  - The new start is computed server-side from Tunarr's current copy. The browser sends only a flag, never a start time.
  - It isn't offered on slot-schedule channels, because a start-time change regenerates the schedule and would discard the edit.
  - It isn't the default: it changes a channel setting, and on a lineup that hasn't repeated it does nothing.

## D44. Phones and tablets get a compact desk, not a separate app

- **Status:** Explicit (owner request, 2026-10-06: "adjust the app for different resolutions and add a mobile view or mode").
- **Decision:**
  - The same page adapts by width; there is no separate mobile app or manual switch. Below 1180px Program Info is a collapsible sheet over the lineup. Below 760px the menus fold into one **Menu** sheet and the channels become a scrollable strip.
  - Collapsed, the sheet keeps the everyday edits (Earlier/Later, Move or swap, Insert, Remove) one tap away; its title bar expands the full details, the length editor, pick-up and the edit list.
  - Touch screens get larger targets (`pointer: coarse`) and a bigger close box, because phones have no Escape key.
- **Alternatives considered:** hiding the menu bar on phones, as before, left most commands unreachable. A separate mobile route would duplicate the desk and drift from it.
- **Consequence:** drag and drop doesn't work with touch; touch users move programs with Earlier/Later and Move or swap.

## D45. Station IDs, commercials and flex time read like a station log

- **Status:** Explicit: the owner asked to "manage station IDs, manage commercials, flex time, and flex time visible in the programming", as close to a real station as possible (2026-10-07). Choices made with the owner: roles stored by Lineup; flex time means Tunarr's flex (no new mechanics); every visibility option; station IDs open each commercial break. Evidenced: `lib/airKinds.ts`, `lib/fillerRoles.ts`, `server/fillerRoleStore.ts`, `app/useFillerSpots.ts`, `DayStrip`, tests in `tests/airtime.test.ts`.
- **Decision:**
  - **Roles are Lineup's own metadata.** Each filler list can be tagged Station IDs, Commercials, Promos, Bumpers or Other in `LINEUP_DATA_DIR/filler-roles.json` (`/filler-roles` routes). Tunarr's lists have no such field, and encoding it in list names would rename the user's data in Tunarr. Untagged lists get a guess from their name (`guessRole`), shown as a suggestion only. This is the companion's second piece of stored state (invariant 7).
  - **A station ID is a real program before the break.** A Tunarr flex break picks spots from its lists at random, so it can't promise what plays first. Inserting a break "with a station ID", or **Edit → Open Breaks With Station IDs**, puts a content item from a station-ID list in front of the flex break and takes the ID's length out of the break, so programs keep their air times. IDs rotate (least used first). Slots get an **Add station IDs to breaks** shortcut (`pre` filler); there Tunarr decides the order inside a break.
  - **The day view is a log.** Each row is classified (`airKind`): program, commercial break, flex, station ID, commercial, promo, bumper, filler, redirect, with its own colour, tile and badge. Rows Tunarr's guide adds on its own (slot filler, padding) keep their kind and title. Each clock hour gets a summary line; a day strip shows the whole day; **View → Show Break Rundowns** (`B`) lists a plausible fill for each break.
- **Honesty:** rundowns are estimates labeled as such (`estimateBreakFill`); Tunarr chooses the actual spots at air time.
- **Consequence:** the day view reads programs of every filler list (up to 40, or only tagged ones beyond that) once per session to recognise spots.

## D46. Filler videos can be uploaded to a media folder Tunarr reads

- **Status:** Explicit: the owner asked for "a way to add media to Tunarr so that we can organize local files for fillers, commercials, station IDs" and chose both uploads and existing folders (2026-10-07). This narrows D33's "no uploads". Evidenced: `server/mediaFolder.ts`, `planUpload` in `server/nodeAdapter.ts`, `/media-folder` in `server/lineupRoutes.ts`, `/filler-lists/from-library` in `server/content.ts`, `app/components/FillerFoldersDialog.tsx`, `tests/mediaFolder.test.ts`, the filler-folders e2e test.
- **Decision:**
  - **Uploads go only to the companion's own media folder** (`LINEUP_MEDIA_DIR`, off unless set), into one subfolder per filler role. Lineup never writes into Tunarr's or a media server's folders, and never edits files. Users can move files between role folders and delete them; nothing else.
  - **Tunarr reads the folder as an ordinary local media source.** Lineup adds it through Tunarr's media-source API with the paths Tunarr sees (`LINEUP_MEDIA_TUNARR_DIR`), so the folder must be mounted into both containers. Programs still come only from what Tunarr has indexed (invariant 3).
  - **Folders become filler lists, automatically** (owner, same day: "folders and sources in tunarr should be picked up automatically"). `syncFillerFolders` runs when the desk loads and while Filler Folders is open. It adds the upload folder to Tunarr, makes a list for each upload role folder, each folder added with a role, and each Tunarr library (any source type) plainly named for a role, and replaces a followed list's programs after every newer Tunarr scan. Only whole words of a library's name count (`folderRole`), so "Accidents" is never taken for idents. Libraries with no obvious role need one **Make filler list**. The list↔folder links, pending folders and ignored folders are Lineup's own metadata in `filler-roles.json`, like roles.
  - **A deleted list stays deleted.** If a followed list is gone from Tunarr, Lineup stops following its folder and won't make it again unless the user makes it by hand.
  - **Upload safety:** streamed to disk (never buffered), size-limited (`LINEUP_MEDIA_MAX_MB`), video extensions only, one path segment, written under a dot-named temporary file and linked into place without overwriting. Same Origin check, host check and optional sign-in as every other route. Absolute paths are not returned to the browser.
- **Consequence:** the companion now stores user files when the media folder is on (invariant 7). Updating a list replaces its contents with the folder's; hand-added programs in a folder-built list are dropped at the next scan; the dialog shows which lists follow which folder. Lineup writes filler lists in Tunarr without a click, but only lists it made from folders.

## D47. A channel's station IDs are the station-ID lists in its Tunarr filler

- **Status:** Explicit: the owner asked to "assign specific station IDs to the channels instead of having to add them as different items" and chose both behaviors: Tunarr airs them, and Lineup's ID tools use them (2026-10-07). Evidenced: `channelStationIds` in `lib/fillerRoles.ts`, the Station IDs section of `ChannelSettingsDialog`, `app/page.tsx`, tests in `tests/airtime.test.ts` and `tests/page.test.tsx`.
- **Decision:**
  - **No new storage.** A channel's own station IDs are the station-ID lists (by Lineup's role) in the channel's Tunarr `fillerCollections`. Ticking one in Channel Settings adds it there (weight 1, no cooldown), so Tunarr plays it in flex time that has no lists of its own, without a lineup item.
  - **Lineup's ID tools follow the channel.** Open with a station ID, Open Breaks With Station IDs and the slot shortcut draw only from the channel's lists; a channel with none (or only empty ones) uses every station-ID list, as in D45.
- **Consequence:** Tunarr picks channel filler at random by weight, so an ID in flex time isn't guaranteed to open a break; for that, the D45 tools still put an ID item in front of each break. Commercial breaks with their own filler lists don't draw from the channel's filler.

