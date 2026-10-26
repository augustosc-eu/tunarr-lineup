# Architecture

This document describes the architecture that exists in the repository. File
paths are relative to the repo root; `Symbol` names refer to exports or
functions in those files. Where something could not be determined from the
repository, it says so.

## 1. Overview

```
                          ┌──────────────────────── Local companion (real use) ───────────────────────┐
 Browser (React SPA) ───▶ │ server/main.ts → server/boot.ts → server/app.ts  (node:http, port 3000)    │
  app/page.tsx            │   ├─ /healthz (always open)                                                │
  lib/tunarrClient.ts     │   ├─ Basic sign-in (server/auth.ts; account from setup, config.json)       │
  (same-origin fetch,     │   ├─ /api/tunarr/*  → server/nodeAdapter.ts → server/tunarrProxy.ts ──────┼──▶ Tunarr (address from setup)
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
| `app/components/ProgramBin.tsx` | The program bin (`A`, Edit → Program Bin, the lineup's ▦ Program Bin button): the library as a poster grid, docked beside the lineup (`.workspace.bin-open` hides the channel list and Program Info). Artwork comes through `/api/tunarr/programs/:id/artwork/:kind` (`libraryArtwork`), with the title's initial when there is none. Picks (single programs, or a show, season or album loaded with `descendants`) are arranged by `arrangePrograms` (`lib/programBin.ts`) with the tray's order, passes and what airs after each program, then placed by `onPlace` (after or before the selection, at the end, or at a time: `snap: 'exact'` uses `exactBoundary` (`lib/events.ts`), which solves for the flex gap in front so they start right then, even though the gap also lengthens earlier passes), by `onPlaceSlots` (recurring time slots: `placeInSlots`, previewed with `planSlots`), by `premiere.onSchedule` (At a time… with Add to the lineup: Just before they start: the page's `schedulePremiere` posts a `premiere` plan whose `at` is `PREMIERE_LEAD_MS` before the program it follows starts, from `premiereFor`; not offered with the scheduler off, unsaved edits, an empty lineup or a slot schedule), by `onScheduleShows` (Slot schedule…: show picks only; the page's `scheduleShows` loads the channel's schedule, or starts a time-slot one for a manual channel, applies `addShowSlots` and opens the slot editor with the result, so it's previewed and saved as any schedule edit), by **Choose spot** (the page's `placing` state: ↑ ↓ on the lineup, OK places, Back cancels), or by dragging a card (or the picked set) onto a row (`binDrag`, `dropFromBin`: the row's top half drops before it, the bottom half after). Arrow keys move between cards, OK opens or picks, Space picks a whole show, Back goes up then closes. The desk's global keys ignore keys inside the bin. |
| `app/useLibraryListing.ts` | Library browsing shared by `LibraryBrowser` and `ProgramBin`: sources, libraries, the opened-folder path, search, whole-listing sort and paging. |
| `app/components/InsertDialog.tsx` | Insert programs (via the browser), commercial break, flex or redirect, before or after the selection or at a date and time; shows when the items will start. |
| `app/components/ListsManager.tsx` | Filler-list and custom-show manager (create, rename, delete, edit contents through `LibraryBrowser`). |
| `app/components/ChannelSettingsDialog.tsx` | Channel settings in tabs: General (name, number, group, guide flex title, guide minimum, start time, hidden, on demand), Logo & watermark (logo address and corner, watermark, offline screen), Streaming (stream mode, transcode profile, subtitles), Commercials (filler collections, cooldown, overlay). |
| `app/components/NewChannelDialog.tsx` | New or duplicated channel: name, number (next free by default), group, transcode profile or channel to copy. Profiles are read only once an empty channel is chosen and allowed (`create`), then kept; a copy never reads them. |
| `app/components/SmartCollectionsManager.tsx` | Smart collections: rule rows (`RULE_FIELDS`), match all/any, keywords, preview count and sample, create, edit, delete. |
| `app/components/MediaSourcesDialog.tsx` | Media sources: libraries with on/off switches, refresh, scan, remove; add Plex, Jellyfin, Emby or local folders. |
| `app/components/FillerFoldersDialog.tsx` | Filler folders: upload, move and delete files in the media folder's role folders; shows what Lineup follows in Tunarr, adds folders with a role, and runs the automatic pickup every 8 s while open (not at all when adding the upload folder and making and refreshing lists are all refused; steps the server left out are listed). `app/useFillerSpots.ts` runs it once when the desk loads. |
| `app/components/TranscodeProfilesDialog.tsx` | Transcode profiles: edit the allowlisted fields, duplicate, delete. |
| `app/components/TemplatesDialog.tsx` | Programming templates: gallery (groups by country, search, My templates), the AI panel, day plan (`DayGrid`), role sources (defaults, suggested smart collections with match counts, library shows), commercials/promos lists, target channel, save/edit/delete/duplicate. |
| `app/components/TemplateEditor.tsx` | Template editor: details, day plan mode, blocks (start, role, ad level), roles (label, hint, order, suggestion kind and genres), start-time grid, lateness, commercial style. |
| `app/components/EventDialog.tsx` | Schedule an event on a date: programs, simulcast (redirect) or off-air; snap and replace/push; live placement preview. |
| `app/components/MoveDialog.tsx` | The "Move or swap" dialog: move to time (with preview), move to position, and a searchable candidate list capped at `MAX_CANDIDATES` (200). |
| `app/components/GuideGrid.tsx` | The guide grid: every channel × three hours from `/guide` (or the demo lineup projected), remote focus model (`stepFocus`, paging at the edges), network grouping (`byNetwork`), viewer badges. |
| `app/components/WeekView.tsx` | Monday–Sunday blocks (`dayBlocks`), keyboard focus across days, week/month exports. |
| `app/components/LineupCheckDialog.tsx` | The lineup check (`checkLineup`) for one or 7 days, per-channel settings in `localStorage` (`loadCheckSettings`), the redirect-loop read, and the AI review. |
| `app/components/AlignDialog.tsx` | Align programs to the clock (`alignToClock`) with a preview. |
| `app/components/MarathonDialog.tsx` | A run of programs with breaks between (`buildMarathon`), placed with `placeEvent`. |
| `app/components/NetworkDialog.tsx` | Copy the selection to a channel, simulcast it on the network (redirects placed with `placeEvent`), or share commercial settings; each target saved with its own version or settings merge. |
| `app/components/WatchDialog.tsx` | The live player, run like a cable box: CH±, number entry, LAST, the INFO banner (now/next from the guide), volume, mute and full screen (`toggleFullscreen` and `volumeIsFixed` in `lib/tvRemote.ts` handle the webkit-prefixed and iPhone video-player fallbacks, and iOS's fixed volume). Owns the cable guide's focus and loads the guide in three-hour chunks with the same loader as the guide grid. |
| `app/useLiveStream.ts` | Plays `streamUrl(channelId)` (`hls.js`, dynamic import, wherever it runs; native HLS only where it can’t, since Chrome’s native player drops Tunarr streams) and keeps it playing: retries with a growing wait (`retryDelay`), a 45 s tuning timeout, a 20 s stall watchdog, a retry when the browser comes back online, and muted autoplay when sound is blocked. |
| `app/components/TvRemote.tsx` | The on-screen remote beside the picture; every button sends the same `RemoteAction` as its key. |
| `app/components/CableGuide.tsx` | The early-2000s on-screen guide inside the picture: details and the picture window on top, five channels × ninety minutes below, forward only. |
| `app/components/SnapshotsDialog.tsx` | Snapshot list, restore, take now, delete; lineup export/import files (`readExport`). |
| `app/components/PlanDialog.tsx` / `ScheduledDialog.tsx` | Save Later and seasonal overlays; the list of scheduled changes with cancel. |
| `app/layout.tsx` | Hosted-only root layout: Geist fonts (`next/font/google`), metadata, OpenGraph, and the `/skin-init.js` script in `<head>`. Not used by the companion build. |
| `app/globals.css` | All styling (rem-based scaling, responsive rules) written against semantic custom properties. `:root` holds the Platinum (Mac OS 9) values, including exact shade tokens that keep Platinum identical to the original stylesheet; one `:root:is([data-skin=…])` block aliases those shades to role tokens, and `:root[data-skin="windows" \| "modern" \| "broadcast"]` blocks at the end override only tokens. Imports Tailwind. |
| `lib/skins.ts` | The skin catalog: `SkinId`, `SKINS` (name, description), `DEFAULT_SKIN` (`platinum`), `SKIN_STORAGE_KEY` (`tunarr-lineup-skin`), `isSkinId`, `parseSkin` (unknown values become Platinum). |
| `app/useSkin.ts` | `useSkin()`: reads the stored skin (`readStoredSkin`, safe when storage is missing or throws), sets `document.documentElement.dataset.skin`, and saves a new pick to `localStorage` at once. |
| `app/components/AppearanceDialog.tsx` | View → Appearance…: a `radiogroup` of four skin cards with CSS-only previews. Arrows move focus (roving `tabIndex`), Enter/OK or Space picks, Done or Back closes without reverting. |
| `public/skin-init.js` | Runs before the app bundle in both entries and sets `data-skin` from the validated stored value, so a reload doesn't flash Platinum. A same-origin file because the companion's CSP has `script-src 'self'` and no inline script. |
| `lib/lineup.ts` | Domain types and schedule math: projection, guide mapping, `scheduleForDay`, `reorderLineup`, `buildManualSave`. |
| `lib/broadcast.ts` | Programming-desk helpers: timecode, block moves, move-to-position and move-to-time, change tracking, day totals, on-air lookup, CSV. |
| `lib/history.ts` | Undo/redo stack of whole-lineup snapshots (`record`, `undo`, `redo`, `MAX_HISTORY` = 200), plus `itemIdentity` and `rebaseHistory` for carrying history across a save. |
| `lib/draftStore.ts` | Persistent per-channel drafts: `encodeDraft` / `decodeDraft` (lineup states as index arrays into the loaded lineup), `createDraftStore` (IndexedDB `tunarr-lineup/drafts`, in-memory fallback, at most `MAX_DRAFTS` = 60), shared via `draftStore()`. |
| `lib/schedule.ts` | Slot-editing helpers: `sourceOptions`, `slotLabel`, `changeSlotSource`, `duplicateSlot`, `newSlotId` (v4 via `getRandomValues`), `shiftTimeSlots`, `slotProblems` (including link-group checks), clock conversions, drafts and conversion, linked slots (`linkGroups`, `linkCandidates`, `linkSlot`), season filters (`seasonSummary`, `setSeasons`), and types `Slot`, `SlotSchedule`, `SchedulePreview`. |
| `lib/library.ts` | Library and setup types (`MediaSource`, `LibraryItem`, `ContentProgram`, `ListSummary`, `ChannelSettings`, `TranscodeProfile`, `ManagedSource`, `NewMediaSource`, `SmartCollectionView`) and helpers (`topLevelType`, `childType`, `toContentProgram`, `lineupEntry`, `itemLabel`, `seasonsFromEpisodes`). |
| `lib/templates.ts` | Template building blocks: role `preset`s, `AD_STYLES` by market, `GENERAL_TEMPLATES`, `templateToDraft` (with per-block ad levels via `midRollFor`), `weekGrid`/`dayRows` (Sunday is day 0; single-weekday overrides), `daySegments`, `roleUsage`, `scheduleToTemplate`, `blankTemplate`, `defaultSource`. |
| `lib/networkTemplates.ts` | Network-inspired templates for Japan, Argentina, the United States, Canada, Spain, the United Kingdom and Italy, including music-channel formats (`NETWORK_TEMPLATES`, `REGIONS`). |
| `lib/templateCatalog.ts` | `BUILT_IN_TEMPLATES`, gallery groups (`TEMPLATE_GROUPS`, `inGroup`) and search. |
| `lib/schedule.ts` (bin) | `addShowSlots(draft, shows, plan)`: each show in its own time slot, back to back from a time on chosen weekdays, its copies linked (`iterationGroup`, `continue`) so episodes carry on; slots starting inside the window are dropped (or, if one is still on at the window's end, moved there); what was on at the end resumes there, linked to the slot it continues. A daily schedule becomes weekly (`dailyToWeekly`, every slot on seven linked days) when only some days are chosen; an empty random draft becomes a time one; a random schedule with slots is refused. |
| `lib/programBin.ts` | The program bin's arranging: `arrangePrograms` (as picked, `episodeOrder`, shuffled, or `mixedInOrder`: shows drawn at random in proportion to the episodes they have left, each show's episodes in `episodeOrder`; in up to 20 passes, with flex or a commercial break after each program and rotating station IDs), `units` (each program with what airs after it), `arrangedDuration`, `placedLabel`, time slots (`SlotPlan`, `slotTimes`, `slotWindow`, `placeInSlots`: one slot after another, each placed with `exactBoundary`; stops when the next slot is in another pass of the lineup or would move the first one), and `PlaceWhere` (the Insert dialog's places, `'end'`, or `{ index, near }` for a drop). |
| `lib/events.ts` | `boundaryAt` (the insert position nearest a time, on the lengthened cycle), `insertedStart`, `passesBefore`, `placeEvent` (snap to a program boundary; replace with flex padding, or push), `repeatLabel` and `airTimeLabel`. |
| `lib/lineupCheck.ts` | `checkLineup` (issues with severity, first air time and lineup position), `redirectLoop`, `DEFAULT_CHECK_SETTINGS`, `issueLines`. |
| `lib/weekLog.ts` | `dateRange`, `weekStart`, `projectDays`, `dayBlocks`, `logRows` (multi-day CSV), `weekSummary` (bounded text for the AI review). |
| `lib/guideGrid.ts` | `windowStart`, `cellsFor`, `entryAt`, `stepFocus`, `byNetwork`. |
| `lib/tvRemote.ts` | Watching like a cable box: `remoteAction` (keys to remote buttons), `stepChannel`, number entry (`addDigit`, `channelByNumber`, `mightContinue`), `retryDelay`, `nowAndNext`, `progress`, `visibleRows` and the cable guide's span and paging constants. |
| `lib/programInfo.ts` | `getProgram`, `programTitle`, `programDetail`, `programArtwork`, `channelLogoUrl`. |
| `lib/tunarrClient.ts` | Browser client for `/api/tunarr/*`: `checkHealth`, `tunarrApi`, `TunarrApiError`, `ConnectionState`. Reads take `RequestOptions` (`signal`, `timeoutMs`, `onPhase`); a cancelled read is `TunarrApiError('aborted')` (`isAborted`), a timed-out one `client_timeout`. |
| `lib/loading.ts` | `LoadPhase` / `LoadState` (connecting, downloading, processing, cancelled), `loadingCopy`, the client time limits (`PROGRAMMING_TIMEOUT_MS`, `SHORT_TIMEOUT_MS`, `DRAFT_WAIT_MS`), `settleWithin`, `withTimeout`, `linkedSignal` (parent signal plus timeout without `AbortSignal.any`). |
| `lib/rowWindow.ts` | `rowWindow` / `shiftWindow`: which of a day's rows the timeline mounts (`ROW_WINDOW` = 200, moved by `ROW_STEP` = 100). |
| `lib/lastChannel.ts` | The channel the desk opens on: `channelFromQuery` (`?channel=`), `readLastChannel` / `writeLastChannel` (`localStorage` key `tunarr-lineup-last-channel`), `pickChannel`, `addressWithChannel`. |
| `lib/demoData.ts` | Demo channels and lineup (`demoChannels`, `demoProgramming()`, `demoDate`). |
| `local/index.html`, `local/main.tsx` | Companion SPA entry: loads `/skin-init.js` in `<head>`, renders `<Home />` into `#root` under `StrictMode` and imports `app/globals.css`. |
| `server/tunarrProxy.ts` | Framework-free proxy and validation: `handleTunarrApi`, `createProxyConfig`, `parseTunarrUrl`, validators, artwork passthrough. |
| `server/nodeAdapter.ts` | Adapts Node `IncomingMessage`/`ServerResponse` to `handleTunarrApi` (`handleNodeApiRequest`, `isTunarrApiPath`). |
| `server/slotSchedule.ts` | Slot-schedule rules: `buildSchedule` (create, convert or edit; per-type settings allowlist; slot, filler and mid-roll validation; materialized fields stripped), `defaultSchedule`, `programPool` (port of Tunarr's `lineupItemAppearsInSchedule`, plus extra programs), `validateExtraPrograms`, `slotSourceKey`, `validateSeed`. Pure, so `lib/` imports it too. |
| `server/admin.ts` | Tunarr setup routes: `matchAdminRoute`, `handleAdminRoute`, `newChannel`, `validateChannelCreate`, `TRANSCODE_FIELDS`, `validateTranscodeChanges`, `manageableSources`, `validateMediaSourceAdd`, `validateSmartCollection`. |
| `server/templateSchema.ts` | Template types and `validateTemplate` (ids, names, roles and suggestions, day plans, ad style, pad/lateness, role defaults reduced to plain source fields). Pure; the browser imports it. |
| `server/templateStore.ts` | Saved templates in `LINEUP_DATA_DIR/templates.json`: serialized, atomic writes; unreadable files are reported, never overwritten. |
| `server/lineupRoutes.ts` | Lineup's own routes: `/templates`, `/filler-roles`, `/station-ids`, `/server-settings`, `/media-folder` and `/ai` (`matchLineupRoute`, `handleLineupRoute`). |
| `server/settings.ts` | Tuning settings the desk may change (`EDITABLE_SETTINGS`), their store `LINEUP_DATA_DIR/settings.json` over the setup values (`setEnv`), `settingsView` and `applySettings`. `bootCompanion` applies saved values at startup (`loadSavedSettings`). |
| `server/stationIdStore.ts` | Station IDs picked for each channel, `LINEUP_DATA_DIR/station-ids.json`. |
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
| `server/watch.ts` | Watching routes: `matchWatchRoute`, `handleWatchRoute`, `slimGuide`/`guideEntry`, `viewerCounts`, `rewritePlaylist`, `validateGuideRange`, and the redirect graph route. |
| `server/snapshotStore.ts` | Snapshots per channel (`LINEUP_DATA_DIR/snapshots/<id>.json`): `take` (skips repeats), `list`, `get`, `remove`, `moveChannel`. |
| `server/sharedDraftStore.ts` | Shared drafts (`LINEUP_DATA_DIR/drafts/`, with `index.json`): `validateDraft`, `createSharedDraftStore`. |
| `server/premiere.ts` | `premierePlacement`: where a premiere goes in the lineup when the scheduler runs it, its flex gap, and the channel start that keeps what's on air in place (pure). |
| `server/scheduler.ts` | Scheduled changes (`scheduled.json`): `validatePlan` (groups `save`, `event`, `overlay`, `premiere`; a premiere is a plan of one change, going in at most `MAX_PREMIERE_LEAD_MS` before `startsAt`), `findPatch`, `applyChange` (a lineup change a restore will undo goes in only after a snapshot that is written and read back, `keptSnapshot`, else it fails with nothing written; other changes keep D50's best-effort snapshot; a restore whose snapshot is missing fails visibly), `createSchedulerStore` (`cancel` with a reason), `createScheduler` (`runDue`, `start`, `stop`; each due change is read again under the channel's lock and skipped if it's no longer pending; a `calendar` change goes in only through its `calendarGuard`, and a `CalendarCheckError` from it leaves the change pending with `held`, along with later changes on that channel), `summarize`. |
| `server/channelLock.ts` | `withChannelLock`, shared by the proxy, the recreate route and the scheduler; `channelGeneration` / `channelBusy`, bumped by every write, invalidate cached programming. |
| `server/programmingCache.ts` | The desk's view of a channel's programming: `slimProgramming` (lineup and schedule untouched, programs via `slimPrograms`, no `startTimeOffsets`), `bodyEtag`, `etagMatches`, `createProgrammingCache` (in-flight sharing, optional TTL, dropped by writes). |
| `server/compression.ts` | `pickEncoding` (Brotli, else gzip, from Accept-Encoding), `isCompressible`, `compress` (async zlib), `compressionEnabled` (`LINEUP_COMPRESSION`). |
| `server/lineupItems.ts` | `lineupItemsError` (shared item validation), `slimPrograms`. |
| `server/upstream.ts` | Shared upstream plumbing: `fetchUpstream`, `callTunarr` (GET/POST/PUT/DELETE), `UpstreamError`, `json`, `fail`, `routeMissing` (Tunarr's own "Route … not found" 404, answered as `501 tunarr_unsupported`). |
| `server/compatibility.ts` | What this Tunarr can do (D63): `CAPABILITY_MATRIX` (each capability's label, what uses it, the operations it needs from Tunarr's API description, its `parts` (a manager's create, edit, delete and the like, each with its own operations) and its read-only probe), `detectCompatibility` (version, `/openapi.json`, probes, four at a time), `decide` (one capability from the evidence, with each part's state from `decideParts`; pure), `checkVersion` (`VALIDATED_VERSIONS` 1.x), `describedOperations`, `failureReason` (Lineup's own words, never upstream messages), `compatibility` (per-config cache, `COMPATIBILITY_TTL_MS` 5 min, shared runs, keyed by Tunarr's address), `unavailableReason` (a capability, or one of its parts), `compatibilitySummary`. |
| `server/channelHealth.ts` | A channel's health (pure): `channelFindings` (programs Tunarr no longer has, zero lengths, redirects to itself or to a channel that's gone, breaks from deleted filler lists, flex with no filler when the channel's lists are known to be empty, guide drift on manual lineups only when both sides name different programs), `loopFindings`/`findLoop` (loops across channels, or a note that the check is partial), `positionAt`, `healthStatus`, `sortFindings`. |
| `server/controlRoom.ts` | The Control Room routes: `controlRoomSummary` (channels, a three-hour guide, sessions, pending scheduled changes, last diagnostics; each part `ok`, `error` or `unsupported`), `checkChannels` (programming and channel document per channel, `CHECK_CONCURRENCY` 3, `MAX_CHECK_CHANNELS` 25 per request, findings computed as each reply arrives, loops from every channel's known redirects; results kept in memory, at most 2,000), `validateCheck`. |
| `lib/controlRoom.ts` | `channelStatus` (the last check made worse, never better, by an empty guide or a failed stream check; never healthy without a check), `summaryNotes`, filters (`ROOM_FILTERS`, `matchesFilter`, `filterCounts`, `nextFilter`), `stepRow` (arrows, pages, ends), `checkBatches`, `checkStream` (the playlist only, `STREAM_CHECK_MS` 15 s, cancellable), `ROOM_REFRESH_MS` 60 s. |
| `app/components/ControlRoomDialog.tsx` | View → Control Room (`O`): filters with counts, the channel list (at most 120 rows mounted, `rowWindow`), the focused channel's details, findings and actions, Check all/Cancel, the stream check; refreshes the summary every minute while the page is visible. Keys: ↑ ↓ PgUp PgDn Home End, OK or → into the actions (↑ ↓ there, ← or Back out), F filter, R refresh, C check, A check shown, S stream, Back closes. |
| `lib/epg.ts` | The guide preview (pure, D69): `epgEntries` (a channel's slim guide entries with titles, sub-titles and categories), `epgIssues` (holes, overlaps, entries under the channel's minimum guide entry or a minute, entries over six hours, untitled ones, flex listed under a generic title), `toXmltv` / `xmltvTime` (an escaped XMLTV document marked as a preview). |
| `app/components/GuidePreviewDialog.tsx` | View → Guide Preview (XMLTV)…: a channel and 3–24 hours from the guide grid's loader (`/guide`, or the demo projection), the checks, the listing, and a download of the XMLTV preview. No route of its own. |
| `server/notify.ts` | Operational notifications (D68): `NOTIFY_EVENTS`, `addressAllowed` (public; RFC 1918, CGNAT and unique-local only with `allowPrivate`; never loopback, link-local or multicast), `addressKind`, `destinationAllowed` (all public on HTTPS 443, or all private with `allowPrivate`, which alone may use http or other ports; mixed answers refused), `validateWebhookUrl` (https, or http with the private exception; no userinfo or fragment; a public literal or any address without the exception on HTTPS 443; names checked at send time), `shownWebhook` (host only), `buildPayload` (schema `tunarr-lineup.notification`, version 1; names only when opted in), `postWebhook` (node:http(s), every resolved address checked and the lookup pinned, no redirects, 8 s, reply read up to 4 KB), `createNotifier` (chosen events, dedupe keys, a queue of at most 50, two retries on 429/5xx/network errors after 2 s and 10 s, the last 20 deliveries without the address), `readNotifySettings`. |
| `app/components/NotificationsPanel.tsx` | Server Settings → Notifications: status (host only), a new address, events, names opt-in, the private-network exception, Save, Send a test, Turn off, recent deliveries. |
| `lib/planner.ts` | The advanced planner (pure, D67): `planSchedule` (virtual-time fair queueing over sources: each source's clock advances by airtime ÷ weight, or one unit ÷ weight when balancing counts, and the earliest goes next; sources joining a daypart start level; season blocks keep a source until its season ends; repeat limits and cooldowns skip programs, flex fills when nothing may air), `seededRandom` (mulberry32 from the seed; ties and shuffles only), `episodeOrder`, `daypartAt` (in an IANA zone via `wallClock`), `daypartBoundaries` (every instant a daypart can change: each daypart's start and end and each local midnight on every local date, both instants of a repeated time, and the clock changes), `nextDaypartChange` (the first of those where the daypart really changes; flex, including cooldown flex, ends there even when that's under `MIN_FLEX_MS`), `MAX_PLAN_AIRINGS` (50,000; a plan that reaches it before its end is returned with `truncated` `{ requestedEnd, reachedAt, limit }`, `end` where it stopped, and a first warning), `planSaveBlocked`, `plannerProgram` (a library entry's season, episode and genres), `newSeed`. Output: airings, `{type:'content', id, duration}` / flex items, per-source shares against weight shares, genres, types, flex total, warnings. |
| `app/components/PlannerDialog.tsx` | Edit → Advanced Planner…: sources (a show via LibraryBrowser and its descendants, picked programs, a custom show), each with weight, order, start, repeat limit and cooldown; balance; dayparts with per-source weights; start, days, zone and seed; the preview (distribution table, genres, types, warnings, the first 300 airings); saving exactly the previewed items with `startTime` and `If-Match` (refused with unsaved desk edits or a slot schedule, and for a `truncated` plan, which shows why and disables both saves), or to the schedule library. |
| `server/calendar.ts` | The calendar's rules (pure; the browser imports it): `Recurrence` (`once`, `yearly`, `weekly`), `StartMode` (`as-is`, `restart`, `position`), `EndBehavior` (`restore`, `resume`, `keep`), `zonedTime` (a local time in an IANA zone: skipped times move forward, repeated ones take the first), `wallClock`, `localDate`, `isTimeZone`, `occurrences` (29 February on the 28th in other years; exceptions by local start date; weekly days walked on the local calendar), `calendarConflicts` (same priority refused; otherwise the higher wins), `outranks` (higher priority; on a tie the older entry, then the lower id), `outranked`, `zonedInstants` (every instant a local time happens at, both in a repeated hour), `offsetAt`, `validateCalendarEntry` (`CONTINUE_UNSUPPORTED` for continuing progress), `startingLineup`, `resumedStartTime`, `occurrenceKey`. |
| `server/calendarStore.ts` | `schedule-library.json` (`createScheduleLibrary`: up to 100 lineups of up to 20,000 items, titles via `slimPrograms`, `validateLibraryEntry`, `validateDetails`, `librarySummary`) and `calendar.json` (`createCalendarStore`: up to 100 entries, each with the last 100 occurrence records), through `jsonFile`. |
| `server/calendarArm.ts` | `withCalendarLock` (one in-process lock: calendar edits, arming commits and applying a calendar change take turns), `calendarGuard` (the scheduler's: reconcile, then apply, under the lock; a failed reconcile throws `CalendarCheckError`), `reconcileAfterEdit` (`{ reconciled }`, and `CALENDAR_UNRECONCILED` when it failed), `reconcileCalendar` (on every tick, before each calendar change goes in, and from the calendar routes right after an edit: cancels plans of occurrences not yet started that are no longer right, because their entry was edited (`calendarRevision`: name, schedule, dates, zone, exceptions, start, end and lead time), disabled or removed, the channel left it, the occurrence is gone, or an entry that `outranks` it now overlaps, and forgets their records so they're armed again; forgets outranked records whose winner no longer outranks them; never touches an occurrence on air; idempotent), `armCalendar` (on the scheduler's tick, after reconciling; an occurrence already planned is noted, never planned twice: each occurrence starting within its entry's `armLeadMinutes` becomes a `calendar` plan, `lineup` (with `startAt` for restart/position) then `restore` (`mode: 'resume'` when resuming), against the version read then; outranked, deleted-schedule and slot-scheduled cases are recorded, Tunarr unreachable retries next tick; a plan is committed under the lock only if the entry still has the revision it was read with), `endOccurrences` (brings restores forward; cancels armed plans when an entry is removed; `runEnding` runs them after the lock is let go), `checkCalendar` (validation, next occurrences, conflicts, warnings), `entryView`. |
| `lib/calendar.ts` | Labels, `COMMON_ZONES`, `browserZone`, `inZone`, `recurrenceLabel`, `conflictLine`, and the dialog's flat `CalendarForm` (`blankForm`, `formToInput`, `inputToForm`). |
| `app/components/ScheduleCalendarDialog.tsx` | File → Save to Schedule Library… / Schedule Library & Calendar…: save a lineup with name, description and tags; the library (add to calendar, delete); calendar entries (next occurrence in their zone, ON NOW, history, edit, End now, remove); the entry form (repeat, zone, channels, start, end, priority, lead, skipped dates) with **Check** (next occurrences, conflicts, warnings) required before saving and again after any change. |
| `app/dpad.ts` | `dpadKey` (↑ ↓ between a dialog's controls, OK ticks checkboxes and radios) and `keepFocusIn` (focus back inside the dialog after a button disabled during work), shared by `BatchDialog` and `ScheduleCalendarDialog`. |
| `server/batch.ts` | Batch operations (D65): `validateBatch` (operations `filler`, `group`, `transcode`, `renumber`, `settings`, `repair`, `import`; settings through `validateChannelSettings` and a per-operation field allowlist, `BATCH_SETTING_FIELDS` for options; at most `MAX_BATCH_CHANNELS` 50), `previewBatch` (per-channel diff with `shown` values and the `expect` fingerprint: `settingsVersion` of the touched fields, or `programmingVersion`), `validateApply` (a valid fingerprint for every channel named, none for others, and an import's channels matching its mapping, or the whole apply is refused), `startBatch`/`runBatch` (background, one at a time, each channel under `withChannelLock`, stops the rest when Tunarr stops answering), `spareNumber` (a free number in 1..`MAX_CHANNEL_NUMBER` that no channel has or is moving to), `planRenumber` (the whole order worked out before the first write; refused when a cycle needs a spare and none is free), `moveNumbers` (renumbering without a transient duplicate: waits for a number to free up, parks one channel of a cycle on a spare number; re-reads the channel list under the lock before every PUT and stops with `RenumberConflict` on an outside change), `startRollback`/`runRollback`, media repair (`missingPositions`, `nextAirings`, `resolveReplacements` and `canonicalProgram` (each replacement looked up in Tunarr; its length is Tunarr's), `repairExpect`, `repairLineup`), `exportPackage`, `matchBatchRoute`, `handleBatchRoute`. |
| `server/batchStore.ts` | `LINEUP_DATA_DIR/batches.json` through `jsonFile` (last `MAX_BATCHES_KEPT` 30): each batch's label, fields, and per channel its outcome, message, old values or snapshot id, the fingerprint it left, and its rollback. A batch without a finish time that this process isn't running is reported as cut short. `summarizeBatch`. |
| `server/programmingPackage.ts` | The programming package (pure): `PACKAGE_FORMAT` `tunarr-lineup-package`, `PACKAGE_VERSION` 1, `packageChannel` (lineup untouched, `slimPrograms` titles only), `buildPackage`, `validatePackage` (format, version, ≤ 50 channels, ≤ 200,000 items, every item through `lineupItemsError`; anything but titles dropped from `programs`), `importSummary`. The browser imports it to read a file before sending it. |
| `lib/batch.ts` | `TASKS` (the dialog's operations plus export), outcome and preview labels, `outcomeTone`, `readyChannels`, `expectations`, `sequentialNumbers`, `defaultMapping` (same id, else same number), `rollbackable`, `inProgress`, `outcomeLine`, `defaultDecisions`. |
| `app/components/BatchDialog.tsx` | Channel → Batch Operations… / Repair Missing Media…, File → Export/Import Programming Package…: task, channels (all, none, by network), options, preview per channel (missing programs with their decisions and a LibraryBrowser for replacements), confirmation, the report polled every 700 ms with rollback checkboxes, and Recent batches. Apply is enabled only while the request equals the one previewed. Arrows move between controls, OK ticks checkboxes and radios, Back leaves the library or the confirmation first, then closes. |
| `lib/compatibility.ts` | The desk's side: `blockedReason` (only `unavailable` refuses), `blockedCapabilities`, `STATUS_LABELS`, `versionLine`, `diagnosticsFile` (the report, no address). |
| `app/components/CompatibilityPanel.tsx` | Server Settings → Compatibility: version, connection, API description, each capability's state and reason, what the desk turns off, **Check again** and **Export diagnostics**. |
| `server/lineupVersion.ts` | `programmingVersion(lineup, schedule)`: a non-cryptographic fingerprint (two cyrb53 hashes plus length), shared by the browser and the proxy for `If-Match`. |
| `server/auth.ts` | HTTP Basic sign-in: scrypt `hashPassword`/`verifyPassword`, `authorize` (hashed account, remembered matches, the desktop app key), `isAuthorized` (plain text, tests), `validateAccount`, `AUTH_CHALLENGE`. |
| `server/configStore.ts` | `config.json` (D62): `CONFIG_KEYS`, `createConfigStore` (owner-only file), `importEnv` (the one-time import, password hashed), `configEnv` (the env the rest of the server reads), `isComplete`, `ignoredEnv`, `savedAiModel`. |
| `server/setup.ts` | The setup wizard and `/server-config`: `createSetup` (state, setup code and its lockout, `auth()`), `applyConfig` (points the running server at the saved values), `applyConnectionFields` (validation), `detectCandidates`/`probeTunarr`, `matchSetupRoute`, `handleSetupRoute`, `setupRequired`. |
| `server/boot.ts` | `bootCompanion`: reads or imports `config.json`, makes the setup state and the proxy config; shared by `server/main.ts` and the dev server. `setupBanner` prints the code. |
| `server/app.ts` | `createLineupServer({ config, auth, staticRoot, hosts })`: request routing, static files, SPA fallback, security headers. |
| `server/hosts.ts` | Host-name check against DNS rebinding: `createHostPolicy` (`LINEUP_ALLOWED_HOSTS`), `isAllowedHost`, `hostRefusal`. |
| `server/main.ts` | Process entry: `bootCompanion`, creates the server, listens, logs (the setup code until setup is done), handles SIGTERM/SIGINT. |
| `server/tsconfig.json` | Compiles `server/*.ts` (excluding tests) to `dist-server/` (NodeNext ESM). |
| `vite.config.ts` | Hosted build/dev: `vinext()` and `cloudflare()` plugins. |
| `vite.local.config.ts` | Companion build/dev: React plugin, Tailwind PostCSS, and dev middleware for sign-in and `/api/tunarr`. |
| `vitest.config.ts` | Unit/UI tests (`tests/**/*.test.{ts,tsx}`, default env `node`). |
| `playwright.config.ts`, `e2e/` | End-to-end suite: `e2e/desk.spec.ts` (TV) and `e2e/responsive.spec.ts` (phone, tablet, laptop, ultrawide) against the built companion and `e2e/fake-tunarr.mjs`. |
| `.github/workflows/ci.yml` | CI: lint, typecheck, unit tests, both builds, e2e, Docker build plus healthcheck. |
| `.github/workflows/release.yml` | On a published GitHub release: builds the image for amd64 and arm64, pushes it to `ghcr.io/<owner>/<repo>` (version, major.minor, `latest`), and checks its healthcheck. |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml` | Companion container and an example stack alongside Tunarr. |
| `public/` | `favicon.svg`, `og.png`, `skin-init.js`, `manifest.webmanifest` and `icons/` (home-screen icons, D59). Served by both targets. |
| `desktop/` | The desktop app (D58), its own npm package (Electron, electron-builder). `main.mjs` forks `dist-server/main.js` with `utilityProcess` on `127.0.0.1` and shows it in a sandboxed `BrowserWindow`; `lineupEnv.mjs` parses `lineup.env` and builds the companion's environment (tested in `tests/desktopEnv.test.ts`); `dist.mjs` packages it with the root version; `start.mjs` runs it from the repo; `build/icon.png` is the app icon. |
| `android/` | The Android app (D60): a Gradle project (`app/`, AGP, wrapper pinned with its checksum), plain Java and no libraries. `MainActivity` shows the saved Lineup server in a WebView; `SetupActivity` asks for its address and checks `/healthz`; `ServerAddress` normalizes the address to an origin and decides what may stay in the window (JUnit tests in `app/src/test/`); `Prefs` keeps the origin and an optional sign-in. Versioned from the root `package.json`. |
| `.github/workflows/android.yml` | On a published release (or by hand): builds the signed APK and attaches it. |
| `scripts/make-icons.mjs` | Renders `public/icons/*`, `desktop/build/icon.png` and the Android launcher icons and TV banner from `public/favicon.svg` with Playwright. |
| `.github/workflows/desktop.yml` | On a published release: builds the desktop app on macOS, Windows and Linux and attaches the installers to it. |
| Generated (do not edit) | `dist/`, `dist-local/`, `dist-server/`, `desktop/release/`, `.next/types/`, `.vinext/`, `.wrangler/`, `next-env.d.ts`, `test-results/`, `playwright-report/`. |

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
| Companion dev | `npm run dev:local` | `vite.local.config.ts` (root `local/`), with plugin `tunarrApi()` that runs `bootCompanion` for setup, sign-in and the proxy |
| Companion build | `npm run build:local` | `vite build` → `dist-local/`; `tsc -p server/tsconfig.json` → `dist-server/` |
| Companion run | `npm run start:local` / Docker `CMD` | `node dist-server/main.js` |
| Hosted | `npm run dev` / `build` / `start` | `vinext dev` / `vinext build` / `vinext start` |
| Unit/UI tests | `npm test` | `vitest run` |
| End-to-end | `npm run test:e2e` | `playwright test`. Starts `e2e/fake-tunarr.mjs` (port 18000), `dist-server/main.js` set up from its environment (port 13000, signed in with `httpCredentials`) and a second one with nothing set up (port 13001, `e2e/setup.spec.ts`) |

## 5. Routing

**Client:** no client-side routing. `Home` is a single screen. The connection,
confirm, move, shortcuts and about dialogs are conditional overlays.

**Hosted (Vinext):** only the `/` route exists, with no route handlers.
`/api/tunarr/health` returns a 404 HTML page. This was verified with `vinext dev`;
a deployed Worker was not verified.

**Companion server** (`createLineupServer` in `server/app.ts`) evaluates each request in this order:

1. **`/healthz`** → `200 {"status":"ok"}`. Liveness only; it doesn't check Tunarr. Always unauthenticated, for the Docker `HEALTHCHECK`.
2. **Without sign-in and outside setup, `isAllowedHost(req.headers.host, hosts)`** fails → `403` (plain text naming `LINEUP_ALLOWED_HOSTS`). IP addresses, `localhost` and `*.localhost` always pass. See §10.
3. **`authorize(req.headers.authorization, auth())`** fails → `401` with `WWW-Authenticate: Basic`. `auth()` is the account from setup (none until setup is done).
4. **`isTunarrApiPath`** → `handleNodeApiRequest`.
5. **Methods other than GET/HEAD** → `405`.
6. **An existing file** under `staticRoot` → served. `resolveStatic` rejects path traversal. `/assets/*` is cached `immutable`; everything else is `no-cache`.
7. **A missing path with a file extension** → `404`. **Anything else** → `index.html` (SPA fallback).

Static files of 1 KB or more that are text, JSON, JavaScript, CSS or SVG are
compressed per request encoding and kept compressed in memory per file size
and modification time. Static responses carry `securityHeaders`, including CSP `default-src 'self'`,
`connect-src 'self'`, `img-src 'self' data:`, `media-src 'self' blob: data:` and
`worker-src 'self' blob:` (MSE playback for the live player; `data:` for the empty
subtitle track hls.js adds) and `frame-ancestors 'none'`.
`GET`/`HEAD /api/tunarr/media-folder/:role/:file` is served by `nodeAdapter`
(`handlePlayback`): a media-folder file streamed with single byte ranges (`parseRange`),
for previews.

The Vite dev middleware in `vite.local.config.ts` applies the same host and
sign-in checks to every request, including `/healthz`, before handling
`/api/tunarr` (plugin middleware runs before Vite's own `allowedHosts` check,
which is set to the same rule for the page itself).

## 6. The Tunarr proxy (`server/tunarrProxy.ts`)

### Configuration

`bootCompanion` (`server/boot.ts`) reads `config.json` and calls
`createProxyConfig(configEnv(process.env, values))`, so the keys below come from
setup, not the process environment (D62). `config.setup` holds the setup state;
`applyConfig` re-applies everything when setup or Server Settings saves. Tests
call `createProxyConfig(env)` directly, without `setup`.

- **`TUNARR_URL`** is parsed by `parseTunarrUrl` into `origin`, `basePath`, `host` and an optional `authorization`. Userinfo becomes a Basic header and never appears in `host`. Missing → `target: null`; invalid → `configError` (fixed text, never echoing the value).
- **`TUNARR_TIMEOUT_MS`** defaults to 10000 and **`TUNARR_SAVE_TIMEOUT_MS`** to 30000.
- **`externalLogos`** comes from `LINEUP_EXTERNAL_LOGOS` (anything but `false` turns it on).
- **`fetchImpl`** and **`fetchExternalImage`** are optional overrides for tests.

### Allowed routes (`matchRoute`)

| Route | Methods | Upstream |
| --- | --- | --- |
| `/api/tunarr/health` | GET | `GET /api/channels`. Responds `{status:'connected', tunarrHost, channelCount}` |
| `/api/tunarr/channels` | GET | `GET /api/channels` (must be an array) |
| `/api/tunarr/channels/:id/programming` | GET, POST | `GET` / `POST /api/channels/:id/programming`. GET answers `slimProgramming` of Tunarr's reply with a weak `ETag` and `Cache-Control: private, no-cache`; `If-None-Match` that matches gets `304`. See *Loading large channels* |
| `/api/tunarr/channels/:id/lineup` | GET | `GET /api/channels/:id/lineup?from=&to=` |
| `/api/tunarr/channels/:id/schedule` | GET | `GET /api/channels/:id/schedule` (materialized: slots carry show, custom-show, channel and list names) |
| `/api/tunarr/channels/:id/schedule-preview` | POST | `GET …/programming`, then `POST /api/channels/:id/schedule-slots` (random) or `/schedule-time-slots` (time) with the merged schedule. Generates only; saves nothing |
| `/api/tunarr/programs/:id/artwork/:type` | GET | `GET /api/programs/:id/artwork/:type?fallbackArtworkTypes=<other types>` |
| `/api/tunarr/channels/:id/recreate` | GET, POST | `server/recreateChannel.ts`, because Tunarr can't drop a slot schedule. GET (`findRedirectsTo`) reads `GET /api/channels` and each other channel's `…/programming`, and returns `{ redirects: [{ id, number, name }] }` for those whose lineup items or redirect slots point here. POST (`recreateChannel`), under `withChannelLock`: version check (412), `GET /api/channels/:id`, then `POST /api/channels` `{type:'new'}` with the old channel's fields minus `NOT_SAVEABLE` on a free number, `POST …/programming` on the new channel with the old lineup (`keep`, zero-length items dropped) or nothing (`empty`), `DELETE` the old channel, and `PUT` the new one back to the old number. A failure before the delete removes the new channel. Returns `{ id, number, name, previousId, numberError? }` |
| `/api/tunarr/channels/:id/logo` | GET | `GET /api/channels/:id`, then the logo (see *Channel logos* below). Only a `v` query parameter (cache buster, `[a-z0-9]{0,16}`) is accepted. `204` when there is no usable logo |

### Request pipeline (`handleTunarrApi`)

0. **Setup:** `matchSetupRoute` routes go to `handleSetupRoute` (below). While `config.setup.needed()`, every other path answers `503 setup_required` (health: `{status:'setup_required', error}`); `nodeAdapter` repeats this for uploads and playback, which skip the proxy.
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
   - **`recreate`:** the body is exactly `{ lineup: 'keep' | 'empty' }` (`validateRecreate`) and needs `If-Match`, else `428`.
7. **No target:** `503` (`not_configured` or `invalid_config`). Health uses `{status:'not_configured', error}`.
8. **Upstream call:** `fetchUpstream`, shared by `callTunarr` (JSON) and `fetchArtwork` (images).

### Setup and server configuration (`server/setup.ts`, D62)

Same pipeline as Lineup's own routes (method allowlist, Origin check, no query, JSON bodies).

| Route | Methods | Notes |
| --- | --- | --- |
| `/setup` | GET | `{ needed }` only |
| `/setup/unlock` | POST | `{ code }` → the config view (prefill from an import) |
| `/setup/detect` | POST | `{ code }` → `{ found, tried }`: `GET /api/channels` at `detectCandidates()` (localhost, `tunarr`, `host.docker.internal`, the default gateway from `/proc/net/route`; port 8000; no scanning), 3 s each, through `callTunarr` |
| `/setup/test` | POST | `{ code, tunarrUrl }` → a `Probe`. `http://` is added when no scheme is typed. A working address also gets `compatibility` (`compatibilitySummary` of `detectCompatibility` against that address, not cached: version, its status, and how many capabilities are unavailable or degraded) |
| `/setup/finish` | POST | `{ code, tunarrUrl, account: { username, password }, ai?, media?, options? }`: `validateAccount`, `applyConnectionFields`, scrypt hash, `setup.save` (write `config.json`, then `applyConfig`) |
| `/server-config` | GET, PUT | After setup only. PUT takes the same fields plus `account: { currentPassword, username?, newPassword? }` (verified first, `403 wrong_password`) |
| `/server-config/detect`, `/server-config/test` | POST | As above, without the code |
| `/server-config/notify-test` | POST | `config.notifier.test()` (409 `notifications_off` without a usable address) |

- **Setup code:** 10 characters from an unambiguous alphabet, printed in the log (`setupBanner`), or `LINEUP_SETUP_CODE` (the desktop app). Case and dashes are ignored. Five wrong codes lock all code routes for 60 s (`429 setup_locked`). The code routes answer `409 already_set_up` afterwards.
- **Write-only values:** the config view returns Tunarr's address without userinfo (`credentials: true` says there was some), `keySet` instead of the AI key, the webhook's host only (`notifications: { set, host, events, includeNames, allowPrivate, problem, recent, catalog }`), and never the hash. Sending the shown address back keeps the saved one; leaving `apiKey` out keeps the key.
- **Validation:** Tunarr's address through `parseTunarrUrl`; AI provider `anthropic`/`openai`/none, a key for Anthropic, a model for OpenAI-compatible, an http(s) address, then `createAiConfig`; the media folder must be an absolute path to an existing directory that neither is nor contains, nor sits inside, the data or static folder; the Tunarr-side path must be a full path.
- **Applying:** `applyConfig` rebuilds `target` (clearing the programming cache when it moves), the media folder, the settings baseline (`setEnv`) and, through `applySettings`, the timeouts, logos, AI and scheduler.

### Conditional writes and slot schedules

`POST …/programming` runs inside `withChannelLock(channelId)`, a promise chain
per channel within this process:

1. **Version check.** `GET` the channel's programming and compute `programmingVersion(lineup, schedule)`. If it differs from `If-Match`, the response is `412 lineup_changed` and nothing is posted.
2. **Manual saves.** `POST {type:'manual', lineup, append:false}` with the items unchanged.
   - **`startTime`** (the advanced planner, D67) is Lineup's too and never forwarded: refused with `keepOnAir`, beyond a year ahead, or on a channel with a slot `schedule`. After the save the proxy sets the channel's start time to it (`setChannelStartTime`); a failure there leaves the save and says so in `startTimeError`.
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
| 404 with Tunarr's own "Route METHOD:/api/… not found" body (`routeMissing`), on `/api/…` paths | 501 | `tunarr_unsupported` (this Tunarr doesn't have the route) |
| Other 404 | 404 | `not_found` |
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

`nodeAdapter.send` writes string or byte bodies with `content-length` (none for
`204`/`304`). `sendCompressed` compresses JSON and text bodies of 1 KB or more
when the request's `Accept-Encoding` allows (Brotli quality 4, else gzip 6),
adding `Content-Encoding` and `Vary: Accept-Encoding`; `LINEUP_COMPRESSION=off`
turns it off. `If-None-Match` is the one extra request header passed to the
handler. POST bodies are capped at `MAX_BODY_BYTES` (20 MiB, else `413`).

### Loading large channels

Measured on a real 20,816-item channel: Tunarr answers with 7.8 MB, 63 % of it
full metadata for each program (identifiers, artwork paths with media-server
tokens, summaries) that the desk never shows; nothing compressed it.

- **Slim, not partial.** The browser still gets the whole lineup: manual saves
  send every item back untouched (invariant 3), drafts are positions into it
  (invariant 5) and `programmingVersion` hashes it (invariant 4). Only
  `programs` is reduced, by `slimPrograms` (title, type, year, show, season,
  episode, artist, album, rating, for every program the lineup plays, uncapped
  up to `MAX_LINEUP_ITEMS`), and `startTimeOffsets` is dropped. 7.8 MB → 2.8 MB
  → 210 KB gzip / 106 KB Brotli. A server-side day window was considered and
  rejected: the editor needs every item anyway, so it would add a second data
  model for at most ~100 KB more.
- **Cache and invalidation.** `createProgrammingCache` shares one Tunarr read
  among requests for a channel that arrive while it's in flight. By default
  nothing is kept after that (`LINEUP_PROGRAMMING_CACHE_MS=0`), so a change
  made in Tunarr's own UI is never shown as current; with a TTL, results are
  kept that long. Every write runs under `withChannelLock`, which bumps the
  channel's generation when it starts and ends: entries and in-flight reads from
  another generation are never reused, so a Lineup save is always followed by
  the saved lineup. The browser revalidates with `If-None-Match` (the body's
  SHA-1 as a weak ETag) and gets `304` when nothing changed: the companion still
  reads Tunarr, but nothing is downloaded. `private` keeps shared proxies from
  storing it.
- **Time limits and cancellation (browser).** Health, channels and the day's
  guide: 30 s; programming: 90 s (covering the body, which is streamed for
  progress). Opening a channel aborts the previous channel's programming and
  guide requests; changing day aborts the previous guide; unmounting aborts
  everything and bumps the request counters so late answers are dropped.
  The companion keeps its own upstream limits (`TUNARR_TIMEOUT_MS`), and a read
  the browser abandoned still finishes there (it may be shared).
- **Drafts in parallel.** `loadProgramming` starts `draftStore().get` with the
  download and waits for it at most `DRAFT_WAIT_MS` (1.5 s) from the start, or
  the download's length if longer. A draft that's later is applied when it
  arrives if nothing was edited meanwhile (`applyLateDraft`), otherwise the new
  edits win with a notice; until then `draftPending` stops the draft effect from
  writing over it. The stores bound themselves too: an IndexedDB call that
  doesn't answer in 4 s (`LOCAL_DRAFT_TIMEOUT_MS`) switches to memory for the
  visit (`persistent` false, so `beforeunload` warns unless the companion keeps
  a copy), the companion's draft routes get 6 s, and after they fail they're
  tried again 30 s later instead of never.
- **Rendering.** A day with more than 200 rows mounts a window
  (`lib/rowWindow.ts`) that stays put until the cursor leaves it, then
  re-centres; **Show earlier/later programs** buttons move it by 100 and keep
  the row that stayed on screen in place (`scrollAnchor`, with
  `overflow-anchor:none` so browsers don't adjust twice). Totals, the day strip,
  hour logs and the lineup check still use the whole day. The guide no longer
  dims the timeline while it loads.
- **States.** `loadState` drives the empty timeline: *Connecting*,
  *Downloading (x of y)*, *Preparing*, with **Cancel**; *Loading cancelled* and
  errors offer **Try again**; *No programming yet* for an empty channel.

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
| `/filler-folders/sync` | POST | `syncFillerFolders` (one run per server at a time). 1) If no local source reads the media folder's role folders, creates them and adds them as one local source (`Lineup media folder`, `other_videos`); Tunarr scans it on its own. 2) Re-reads every followed list whose library's `lastScannedAt` is newer than the link's `builtAt` and isn't scanning; a list deleted in Tunarr (404) is unfollowed and its library ignored. 3) Makes a list for each enabled, unfollowed, unignored library with a role: an upload role folder (`Station IDs (folder)`), a pending folder (its stored name), or a library whose name passes `folderRole` (whole words of the last path segment). A library found empty is not searched again until its next scan (in memory). Each step checks the compatibility report first and is left out on its own when its part is `unavailable`; with no fresh report the sync awaits `compatibility(config)` (the check already running, or a new one), so the first pickup after a start, or a direct client, never writes ahead of the check: adding the upload folder (`media-sources`/`create`), reading a folder (`library-search`), making a list (`filler-lists`/`create`), refreshing one (`filler-lists`/`edit`); with `media-sources` itself unavailable nothing is read. The rest runs; an `unchecked` part, or a check that fails outright, is tried. Returns `{ connected, created, updated, errors, skipped }` (`skipped`: each left-out step once, with the reason). `POST /filler-lists/from-library` (`buildFromLibrary`) refuses the same way before reading. Needs `TUNARR_URL`. |
| `/filler-folders/add` | POST | `{ path, role }`: adds a local source for the folder (checked by `validateMediaSourceAdd`) and records its library as pending, so the next sync after Tunarr's scan makes its list. Needs `TUNARR_URL`. |
| `/media-folder/:role/:file` | DELETE | Deletes the file. Upload (PUT) is handled by `nodeAdapter` (above). `:role` is a filler role; `:file` must pass `mediaFileName` (one segment, video extension, no leading dot or reserved characters) |
| `/media-folder/:role/:file/move` | POST | `{ role }`: moves the file to another role folder without overwriting |
| `/ai` | GET | `{ enabled, provider, model }`, or `{ enabled: false, message }` saying what to set |
| `/ai/template` | POST | `{ prompt (≤ 2000 chars), channelId?, includeLibrary, baseTemplate? }`. `gatherContext` reads smart collections, custom shows and filler lists, and optionally the library (shows and movies via `POST /api/programs/search`, up to 600 and 300) and the channel's programming (a most-aired summary). `callModel` sends `SYSTEM_PROMPT` plus `buildUserMessage`; the model must call `propose_schedule` (`PROPOSAL_SCHEMA`). `resolveProposal` converts blocks, keeps role sources only when the id is in the catalog, drops suggestions `rulesToFilter` rejects, picks lists only from known ids, and validates the result with an `ai-…` id. Provider errors become `ai_auth`, `ai_rate_limited`, `ai_timeout`, `ai_unreachable` or `ai_invalid`. |

Further Lineup routes (owner decision 2026-10-19, D50–D52):

| Route | Methods | Behaviour |
| --- | --- | --- |
| `/channels/:id/snapshots` | GET, POST | List the channel's snapshots (summaries); POST reads Tunarr's programming and takes one now (needs `TUNARR_URL`) |
| `/channels/:id/snapshots/:snapshotId` | GET, DELETE | One snapshot with its lineup and slim programs; delete it |
| `/drafts` | GET | Draft summaries `{ channelId, version, updatedAt, dirty }` |
| `/drafts/:channelId` | GET, PUT, DELETE | The draft (or `null`); PUT checks it with `validateDraft` |
| `/scheduled` | GET, POST | `{ enabled, message?, changes }` (summaries); POST a plan `{ group, changes }` checked by `validatePlan` (503 when `LINEUP_SCHEDULER` is off). A change already due runs at once. |
| `/scheduled/:id` | DELETE | Cancels a pending change and the rest of its plan |
| `/ai/review` | POST | `{ channelName, summary (≤ 40,000 chars), issues (≤ 100) }` → `callModel` with `REVIEW_PROMPT` and the `review_schedule` tool → `resolveReview` |
| `/station-ids` | GET | `{ [channelId]: programId[] }` from `station-ids.json` (`server/stationIdStore.ts`, D54) |
| `/station-ids/:channelId` | PUT | `{ programIds }` (UUIDs, deduplicated, up to 200; up to 500 channels) checked by `validatePicks`; an empty list drops the channel. Picks follow a recreated channel to its new id. |
| `/control-room` | GET | `controlRoomSummary`. Needs Tunarr's address. See *Control Room* below |
| `/control-room/check` | POST | `{ channelIds }` (1–25 valid channel ids, deduplicated) → `{ diagnostics }` from `checkChannels` |
| `/schedule-library` | GET, POST | Summaries; save a lineup (`validateLibraryEntry`) |
| `/schedule-library/:id` | GET, PUT, DELETE | The lineup; edit name, description and tags; delete (409 `schedule_in_use` while a calendar entry uses it) |
| `/calendar` | GET, POST | `{ enabled, message?, entries }` (`entryView`); create after `checkCalendar` (409 `calendar_conflict` with the conflicts). The check, the save and the reconcile run under `withCalendarLock`; the reply is `201` with the entry and `reconciled` (with a `warning` when reconciling failed: the entry is saved, so sending it again would make a second one, and the scheduler holds calendar changes until it can reconcile) |
| `/calendar/preview` | POST | `checkCalendar` without saving (`id` to check an edit against the others) |
| `/calendar/:id` | PUT, DELETE | Replace (an occurrence on air keeps its plan; armed ones not started are cancelled if no longer right and armed again by the scheduler); remove (`endOccurrences` with `cancelArmed`, then the restores it brought forward run after the lock). Both run under `withCalendarLock` and answer `reconciled` (and `warning`) like a create |
| `/calendar/:id/end` | POST | `endOccurrences` without cancelling |
| `/batch/preview` | POST | `validateBatch` → `previewBatch`. See *Batch operations* below |
| `/batch/apply` | POST | `validateApply` (the batch plus `expect: { channelId: fingerprint }` for exactly its channels; a channel without a valid fingerprint, a fingerprint for another channel, numbers or an import mapping that don't match the channels: `400 invalid_request`, nothing recorded or written) → `202` and the record from `startBatch`. The desk sends only the channels the preview would change (`applyBody`) |
| `/batch/export` | POST | `{ channelIds }` (≤ 50) → a programming package |
| `/batches` | GET | `summarizeBatch` of each kept batch |
| `/batches/:id` | GET | The record, with `running` |
| `/batches/:id/rollback` | POST | `{ channelIds }` → `202` and the record from `startRollback` |
| `/compatibility` | GET | `compatibility(config)`: the cached report (5 min) or a fresh check. Without Tunarr's address, `notConfiguredReport` (`configured: false`). See *Compatibility* below |
| `/compatibility/refresh` | POST | The same, checked again now (`{}` body) |
| `/server-settings` | GET, PUT | `settingsView`: `{ editable: [{ key, label, group, help, kind, min?, max?, value, envValue, defaultValue, source }], fixed: [{ label, set }], restartNote }`. PUT `{ values: { KEY: value or null } }`: only keys in `EDITABLE_SETTINGS` (`server/settings.ts`), each checked by `validateSetting`; `null` drops the saved value. Saved values go to `settings.json` and `applySettings` puts them into the running config (timeouts, external logos, the scheduler on or off, the AI config rebuilt, the upload limit). Fixed settings (where the server starts: data folder, allowed hosts, listen address and port) are reported as set or not, never by value. `LINEUP_AI_MODEL` moved to `/server-config` (D62). Works without `TUNARR_URL`. |

Every programming POST (manual and schedule) takes a snapshot of Tunarr's current
programming after the version check and before the write; the recreate route takes one
first and moves the channel's snapshots to the new id afterwards.

### Compatibility (`server/compatibility.ts`, D63)

The companion decides what the desk may use; components never check Tunarr's
version themselves.

1. **Connection:** `GET /api/channels`. If it fails, every capability is
   `unknown` (connection `unavailable` when the route is missing) and nothing
   else is asked.
2. **Evidence**, four requests at a time, all reads: `GET /api/version` (only
   `tunarr` is kept, through `cleanVersion`; ffmpeg and Node versions are
   dropped), `GET /openapi.json` (`describedOperations`: `method path` with
   parameters as `{}`), and one probe per capability whose reply must have the
   shape the desk reads (`SHAPES`): the channel document and programming of the
   channel with the fewest programs, a 5-minute guide window, sessions, filler
   lists, custom shows, smart collections, media sources, transcode profiles,
   and one library search for one result in the first enabled library.
3. **Decision** (`decide`), per row of `CAPABILITY_MATRIX`:
   - each row declares its **required** routes (`ops`) and its **parts**
     (`parts`: one part of the feature with routes of its own, such as a
     manager's create, edit and delete, each with what won't work without it). A
     required route the API description (read successfully) doesn't list, and
     that the probe didn't just read, is definite evidence → `unavailable`,
     naming the route (for example Channel Settings when `PUT /api/channels/{id}`
     is missing even though reading works). Parts are decided from the
     description alone, never from a probe, since a read that worked says
     nothing about the writes (`decideParts`): listed → `available`, not listed
     → `unavailable` (that part is refused, the capability is `degraded` and
     reading stays on), no description → `unchecked` (also `degraded` when the
     read worked, saying the changes couldn't be checked and are tried when
     used). A capability with no required routes of its own (creating and
     deleting channels) is `unavailable` only when every part is. The report
     carries each capability's `parts` with their states;
   - a probe that answered → `available` (or `degraded` when a part is missing or unchecked);
   - a probe that got `tunarr_unsupported` → `unavailable`; a wrong shape or
     non-JSON → `degraded`; a timeout, refusal or other failure that may pass →
     `degraded` (still usable, never turned off on that alone); a probe with
     nothing to read (no channels, no library) → `untested`;
   - capabilities only proven by writing (manual saves, slot schedules) are
     decided from the API description: listed → `available`, not listed →
     `unavailable`, no description (older Tunarr) → `untested`, a description
     that failed to load → `degraded`;
   - HLS is never probed (a playlist request starts a stream in Tunarr): it is
     `available` while Tunarr reports live sessions, otherwise `untested`.
4. **Version:** `/api/version`, else the API description's `info.version`.
   Inside `VALIDATED_VERSIONS` (≥ 1.0.0, < 2.0.0) is `validated`; other
   numbers `unvalidated`; anything else (or none) `unknown`. The version only
   produces a warning: capabilities are always decided by the checks.
5. **Reasons** are Lineup's own sentences (`failureReason`), never upstream
   messages, so the report never names Tunarr's host, credentials, media-server
   addresses or tokens.

The desk loads the report once connected (`page.tsx` `compat`) and refuses a
feature only when its capability is `unavailable` (`refuse`/`gate`, which show
the reason as a toast; menu items stay focusable for the remote). The Save
button (and the slot editor's Save schedule) is disabled up front when its
capability is `unavailable`, reading "Saving unavailable", with the missing
route in the inspector's "Saving is off for this Tunarr" note. Gated:
saving (`manual-saves`), the slot editor (`slot-schedules`), the guide grid
(`guide`), viewer polling (`sessions`), Channel Settings, filler lists, custom
shows, smart collections, media sources, transcode profiles, the program bin
(`library-search`) and Watch Live (`hls-streaming`). Parts are refused one by
one (`partBlocked`, passed to the dialogs as `blocked`): the list managers,
Smart Collections, Media Sources (including signing in to Jellyfin or Emby),
Filler Folders and Transcode Profiles turn off the buttons of parts Tunarr's
API doesn't list and show a "Not on this Tunarr" note saying which and why;
New, Duplicate and Delete Channel (`channel-admin`) explain themselves when
chosen: New Channel is gated on `create` (an empty channel: `GET
/api/transcode_configs` for the default profile, then `POST /api/channels`),
Duplicate Channel on `copy` (`POST /api/channels`, then `GET` and `PUT
/api/channels/{id}` to give the copy its name and number), and the New
Channel dialog asks again whenever "Start from" changes, turning its final
button off with the reason; it reads the transcode profiles only for an
allowed empty channel, once. `POST /channels/create` refuses (`501
tunarr_unsupported`) before any Tunarr request when the cached report
(`cachedCompatibility`) shows the part it needs `unavailable`, so a client
can't leave a half-made copy; no report, an expired one or an `unchecked` part
is tried as before. Media repair doesn't offer Replace without `GET /api/programs/{id}`;
Server Settings → Compatibility lists what is "Partly turned off". A failed
or missing report refuses nothing.

### Control Room (`server/controlRoom.ts`, D64)

- **Summary** (`GET /control-room`): one `GET /api/channels` (required; its
  failure is the route's error), then together: one guide read for
  `[now, now + 3 h)` (`slimGuide`; now and next per channel), one sessions read
  (`viewerCounts`: counts only), and the scheduler's store (pending changes per
  channel, the next one's time). A failed guide or sessions read becomes that
  part's `{ status: 'error', message }` (Lineup's words, `failureReason`) and
  the channels still show; a capability the compatibility cache says is
  unavailable isn't read at all (`unsupported`).
- **Check** (`POST /control-room/check`): the channel list, the filler lists
  and a one-minute guide window once, then for each channel its programming and
  channel document, three channels at a time. Each programming reply is turned
  into findings at once (`channelFindings`) so at most three lineups are held.
  Loops are computed after the batch from this batch's redirects plus those kept
  from earlier checks of channels that still exist (`loopFindings`). A channel
  that fails, or that Tunarr no longer has, is `unknown` with the reason; the
  rest finish. Results are kept in memory per server (a restart forgets them).
  With programming unavailable, every channel is `unsupported` without a read.
- **The desk** polls the summary every 60 s only while the page is visible (and
  once when it becomes visible if stale), aborts reads on close, runs Check all
  in batches of 25 that Cancel stops between batches, and never starts a stream
  except through the opt-in stream check, which fetches the existing
  `/channels/:id/stream.m3u8` route once (the master playlist, no segments).

### Notifications (`server/notify.ts`, D68)

`config.notifier` is built from `LINEUP_NOTIFY_*` (config.json, set through
`/server-config` `notifications`) by `createProxyConfig` and again by every
`applySettings`. Senders call `notify(notice)`, which returns at once:

| Event | Sent from | Says |
| --- | --- | --- |
| `scheduled.applied` / `skipped` / `failed` / `missed` | `runOnce` (`scheduledNotice`) | that a scheduled change or calendar occurrence went in, was skipped, failed or was missed; never the reason (it can name Tunarr's host) |
| `save.conflict` | the programming POST answering 412 | that a save was refused because the channel changed |
| `channel.unhealthy` | `checkChannels`, when a channel becomes `error` | error and warning counts (dedupe 6 h per channel) |
| `media.missing` | `checkChannels` | how many programs are missing (dedupe 24 h per channel and count) |
| `guide.failed` | `controlRoomSummary` | Lineup's reason for the failed guide read (dedupe 1 h) |
| `batch.partial` | `runBatch` | outcome counts when any channel conflicted, failed, was blocked or skipped |

The payload is `{ schema, version, id, event, severity, at, summary, channel?: { id, number?, name? }, counts? }`; `summary` is the named sentence and `channel.name` is included only with `LINEUP_NOTIFY_NAMES=on`. Delivery runs one at a time from a queue; a stream check (client-side, opt-in) isn't reported.

### Schedule library and calendar (`server/calendar*.ts`, D66)

- **Library:** manual lineups saved apart from any channel (from the desk, a
  slot preview's materialized lineup, a package or a snapshot), items untouched,
  titles only. Slot schedules aren't kept: a schedule save must reuse its
  preview's seed (invariant 4), which can't happen unattended.
- **Entries:** a saved schedule, channels, a recurrence in an IANA time zone,
  exceptions (local start dates), a priority (1–9), how it starts, how it ends,
  and how long before each occurrence it's armed (15 minutes to 7 days; 6 hours
  by default). Saving needs a check: overlaps with another enabled entry on a
  shared channel are refused at the same priority; otherwise the lower
  occurrence is skipped on that channel when armed (`outranked`).
- **Arming** happens in `runOnce` before due changes, so it only runs while the
  scheduler is on, and an occurrence that's due runs in the same tick. Each
  armed occurrence is a normal two-change plan (`group: 'calendar'`,
  `calendarId`): the lineup change carries `expectVersion` read at arming time
  (an edit afterwards skips it), `startAt` for restart/position (the lineup is
  rotated for a position), and `notAfter` before the occurrence's end; the
  restore runs up to 7 days late (a restore missed while the companion was off
  is better late than never). `previousStart` (the channel's start time before
  the overlay) is recorded when the lineup goes in; the restore puts it back
  (`exact`) or moves it so the old lineup is as far into its cycle as when it
  was interrupted (`resume`, `resumedStartTime`). The browser can't send a
  `calendar` plan, `startAt` or a restore `mode` through `/scheduled`.
- **Occurrence records** (armed, outranked, skipped, with the reason) are kept
  per entry, so an occurrence is armed once. Each plan also carries its
  `occurrence` (key, start, end, and `calendarRevision` of the entry it was
  armed from).
- **Re-arming** (`reconcileCalendar`) runs first on every tick, and again under
  the calendar's lock right before each due calendar change goes in
  (`calendarGuard`). An occurrence that hasn't started
  (its lineup change is still pending) and is no longer right has its plan
  cancelled with the reason and its record forgotten, and the arming that
  follows plans it again or records it as outranked: its entry was edited,
  turned off or removed, the channel was taken out of it, the occurrence no
  longer exists, or an entry that outranks it overlaps it (`outranks`: the
  higher priority; equal priorities, which saving refuses but can still meet,
  go to the older entry, then the lower id). Outranked occurrences whose winner
  is gone, off or lower are armed again if they haven't started. Occurrences on
  air are never touched: an edit applies from the next one. The calendar
  routes run the same check right after saving, under the same lock.
- **One calendar lock** (`withCalendarLock`, in-process): calendar edits hold it
  while they check, save and reconcile; arming holds it while it commits a plan
  (only if the entry still has the revision it read, isn't outranked and has no
  record for that occurrence yet, so an edit landing while Tunarr was being read
  is planned from on the next run instead); the scheduler holds it while it
  reconciles and applies a due calendar change. An edit therefore lands either
  before a change goes in (which is then cancelled, if it's no longer right) or
  after (the occurrence has started and is left alone). Lock order is the
  calendar's, then the channel's; nothing takes them the other way round.
- **Failing closed.** If reconciling fails (the calendar or `scheduled.json`
  can't be read or written), the scheduler applies no calendar change that
  tick: it stays `pending`, marked `held` with a message, and so does anything
  due after it on the same channel (so nothing goes in out of order); changes
  on other channels go on, since reconciling only ever touches calendar plans.
  It's tried on the next tick, never marked failed for this; one whose
  `notAfter` passes while held is skipped saying so. A calendar edit whose
  reconcile fails is still saved and answers success with `reconciled: false`
  and a `warning`, so nobody saves it twice.
- **What invalidates an armed plan** (`calendarRevision`): the entry's name
  (labels and notifications carry it), schedule, recurrence, zone, exceptions,
  start, end and lead time. Shortening the lead (a day to 15 minutes) cancels
  what was armed early, and it's armed again only inside the new window.
  Whether the entry is on, its channels and its priority are checked per
  channel, so changing them re-plans only the channels they affect.
- **The snapshot a restore needs** must be on disk (written and read back as
  the version it replaces) before an occurrence's lineup goes in; otherwise
  the occurrence fails and nothing is written. A restore whose snapshot went
  missing fails visibly instead of passing as done.
- **Existing overlays** made with Save as Seasonal Overlay are unchanged
  one-time plans in `scheduled.json`; nothing was migrated or lost.

### Batch operations (`server/batch.ts`, D65)

Every batch is: preview → apply → report → optional rollback, per channel.

- **Preview** reads each picked channel (three at a time): the channel
  document for settings batches, programming (plus the channel document for
  repair airings) for lineup batches. It answers each channel's status
  (`ready`, `unchanged`, `blocked` with the reason), the field changes as text
  (`shown`: list and profile names, seconds, on/off) or a lineup summary, and
  `expect`: `settingsVersion` (a `programmingVersion` of just the touched
  fields) or the programming version. Renumbering is checked against every
  channel's final number (`renumberProblems`); a transcode profile must exist;
  a channel with a slot schedule is blocked for repair and import, because a
  manual save would detach it.
- **Apply** runs in the background (`startBatch`; one batch per server; the
  client polls `/batches/:id`). It names exactly the channels it changes, each
  with its preview's fingerprint; one missing or invalid refuses the whole
  apply before a record is created (it never quietly changes fewer channels). For each channel: `withChannelLock`, a fresh
  read, the `expect` check (else `conflict`, nothing written), then
  - settings: `validateChannelSettings` again, merged onto Tunarr's copy minus
    `NOT_SAVEABLE`, `PUT`, read back; the old values of the touched fields and
    the new fingerprint go in the record;
  - lineups: the same plan recomputed from the fresh read (`repairLineup` or the
    package's lineup, zero-length items dropped), a snapshot that must succeed
    (a batch doesn't go ahead without it), a manual `POST`, read back; the
    snapshot id and the new version go in the record.
  A failure is that channel's; when Tunarr stops answering (`tunarr_unreachable`,
  `tunarr_timeout`) the rest are `skipped` with the reason instead of each
  waiting out a timeout. The record is saved after every channel; a batch cut
  short by a restart reads back as skipped.
- **Renumbering** (`planRenumber`, `moveNumbers`) never puts two channels on one number: a
  channel whose new number is still held by another channel in the batch waits;
  a cycle parks one channel on a spare number first (`spareNumber`: just above
  the highest number in use or wanted when that is at most 99,999, else the
  highest free one below; never a number any channel has or is moving to). The
  whole order is planned before the first write; a cycle with no free number
  in 1–99,999 blocks every channel with nothing moved. It goes in as a whole: a
  channel changed or deleted since the preview stops all of it before anything
  moves (that channel is a `conflict`, the rest `skipped`, with "Preview
  again"), so with CH 1 ↔ CH 2 previewed and CH 2 deleted, CH 1 stays put.
  Before every `PUT`, under the channel's lock, it reads the channel list again
  and compares it with what the batch expects at that step (including its own
  moves and spare numbers): a batch channel elsewhere, or the target number
  taken, is an outside change (`RenumberConflict`), and nothing more is moved.
  Tunarr has no transaction across channels, so moves already done stay done
  and are reported as such; a channel left on a spare number is `failed` with
  where it is (rollback is offered, conditionally); the rest are `skipped`.
  Nothing is moved back blindly. A failure says which channel was left on
  which number.
- **Rollback** (`startRollback`) takes chosen channels with a change: under the
  lock, only if the touched fields still have the fingerprint the batch left
  (settings) or the programming still has the version the batch saved (lineups);
  otherwise `conflict`. Settings get their old values; lineups get the snapshot,
  after a snapshot of the current state, as a manual save. Renumbering rolls
  back through `moveNumbers`.
- **Media repair**: `missingPositions` finds content items whose program has no
  details in Tunarr's programming reply; the preview groups them by program
  across channels with positions and the next three airings (`nextAirings`).
  Decisions per program: `ignore`, `remove`, `flex` (same length, so later
  items keep their times) or `replace` with `{ id, duration }` picked from the
  library. The browser sends only the program's id: preview and apply both look
  it up with `GET /api/programs/:id` (`resolveReplacements`, `canonicalProgram`:
  the id must match, it must be a playable program rather than a show or
  season, and its length is Tunarr's), and a program Tunarr doesn't have is a
  `409 replacement_unavailable` in the preview or `blocked` at apply, with
  nothing written. The replacements' lengths are part of each channel's
  `expect` (`repairExpect`), so one whose length changed since the preview is
  a conflict. Every other item is the same object, in order.
- **Packages** (`server/programmingPackage.ts`): export reads each channel's
  programming; import validates the file and maps each packaged channel onto a
  channel here, then follows the lineup path above.

### Watching routes (`server/watch.ts`)

Tried after the content routes; GET only, Origin check, and no query except on `/guide`.

| Route | Upstream and rules |
| --- | --- |
| `/guide?from&to` | ISO date-times, at most 24 hours (`validateGuideRange`) → `GET /api/guide/channels?dateFrom&dateTo` → `{ from, to, channels: [{ id, number, name, programs: [{ start, stop, type, title, detail, id?, fillerListId?, redirectTo? }] }] }` (`slimGuide`; Tunarr's reply carries full metadata and can be several MB) |
| `/sessions` | `GET /api/sessions` → `{ [channelId]: { viewers, streams } }` for live sessions only; addresses and user agents dropped |
| `/redirects` | Every channel's programming, four at a time → `{ edges: [{ from, to }] }` (lineup redirects and redirect slots) |
| `/channels/:id/stream.m3u8` | `GET /stream/channels/:id.m3u8?mode=hls` (30 s timeout), rewritten by `rewritePlaylist` |
| `/channels/:id/hls/:file` | `:file` must match `STREAM_FILE`; `GET /stream/channels/:id/hls/:file`. Playlists are rewritten; other parts must be video/audio types, ≤ 64 MB |

`rewritePlaylist` resolves every URI line and `URI="…"` attribute against the upstream
playlist and allows only `TUNARR_URL`'s origin and base path with `/stream/channels/<this
id>/hls/<STREAM_FILE>` or `/stream/channels/<this id>.m3u8`; anything else makes the whole
playlist a 502 `stream_unexpected`.

### Scheduler (`server/scheduler.ts`)

`createProxyConfig` creates it with `enabled` from `LINEUP_SCHEDULER` (`on`, `true`, `1`);
`server/main.ts` and the Vite dev plugin call `start()`. Every 30 s `runDue` takes the
pending changes that are due, oldest first. Past `notAfter` (default `at` + 12 h) a change
is skipped as missed. Otherwise `applyChange` runs under `withChannelLock`: read Tunarr's
programming, check the change's condition (`lineup`: version equals `expectVersion`;
`patch`: `findPatch` locates the identities being removed; `restore`: the version equals
the `appliedVersion` its `lineup` change left; `premiere`: the channel has no slot schedule,
and `premierePlacement` (`server/premiere.ts`) finds, in the lineup Tunarr has now, the
boundary at or before `startsAt` in the pass on air, with a flex gap up to it, or the end of
the program on now if it runs into `startsAt`), take a snapshot, save a manual lineup
(zero-length items dropped), read back and record `appliedVersion` and `snapshotId`. A
premiere then moves the channel start (`setChannelStartTime`, `server/content.ts`, shared
with the desk's keep-on-air save) so what's on air keeps its time; if that fails the save
stands and the message says so. Its `notAfter` defaults to `startsAt`, so a premiere that
didn't go in before it starts is missed rather than added late.
A failed condition marks it `skipped` with the reason and skips the plan's pending
restores; Tunarr unreachable retries next tick until `notAfter`.

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

- The mount effect calls `checkHealth()`, which maps the response to `connected`, `setup_required`, `not_configured`, `unreachable` or `unavailable`. `setup_required` shows `SetupWizard` over the live desk (no connection dialog); it can switch to demo data, and **Sign in** reloads the page once setup is done. The wizard reads a `#setup=CODE` the desktop app opens it with and removes it from the address.
- If connected, it loads channels (sorted by number), picks one with `pickChannel` (an open channel, then `?channel=<id>` if it exists, then the last one opened, then the first; an unknown id gets a notice), then `loadProgramming`, then `loadGuide` for the local day. Opening a channel remembers it and, when the address has a `channel` parameter, updates it with `history.replaceState` (path and other parameters kept).
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
| Program bin | `A`, Edit menu, ▦ Program Bin | `ProgramBin` → `arrangePrograms` → `placeArranged(arranged, where)` → `insertAt` (as Insert, with `PlaceWhere`: `'end'` inserts at `lineup.length`; `{ index, near }` inserts at a row's position on the pass around its airing; an exact time prepends the gap's flex). `startFor` also returns `gap` and `moved` (the start is `MOVED_MS` or more from where the spot airs now), which the bin shows as a warning. Time slots: `placeInTimeSlots` → `placeInSlots(lineup, startWith, arranged.units, plan)`, one edit. Choose spot sets `placing`; Enter on a row calls `placeAtCursor`. A drag sets `binDrag` (a promise of the arranged items, since a dragged show loads as it moves) and rows show `drop-before` / `drop-after`. |
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

**Reset Channel** (`confirmResetChannel`) is the same conditional save with `lineup: []`, sent with `base.version` after a confirmation. On success it closes the slot editor, deletes the channel's draft and reloads without `rebase`, so the edit list starts fresh. A 412 uses `showConflict`. On a channel with a slot schedule, the confirmation first loads `channelRedirects` (`withRedirectNote`) and offers two actions: **Reset and remove schedule** (`recreateWithoutSchedule(…, 'empty')`, the `recreate` route) and **Empty lineup only** (the empty save, `ConfirmDialog.alternate`), which Tunarr refills at its next regeneration (D48). After a recreate the desk deletes the old id's draft and reloads the channel list on the new id.

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
   - **Detach to manual lineup** (`detachToManual`), which recreates the channel with Tunarr's current lineup and no schedule (`recreateWithoutSchedule(…, 'keep')`), after naming the channels that redirect to it
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
- **An AI provider** (Anthropic, or an OpenAI-compatible API such as OpenAI or Ollama), only when configured, called by `server/ai.ts`. On a real server, the artwork route returned `image/jpeg` for program UUIDs; the raw `artwork[].path` values in programming pointed at Plex on `127.0.0.1:32400`. Versions and capabilities are detected read-only by `server/compatibility.ts` (D63).
- **Hosting the preview** is up to whoever deploys it (for example `wrangler deploy` on the `dist/` build). No deploy pipeline is in the repo.
- **Google Fonts** (Geist via `next/font/google`) are used by the hosted build only.

## 9. Persistence

- **Tunarr** holds all channel data. The companion stores, in `LINEUP_DATA_DIR`: the batch-operation record (`batches.json`, D65); the schedule library and calendar (`schedule-library.json`, `calendar.json`, D66); its configuration from setup (`config.json`, mode 0600: Tunarr's address, the account's scrypt hash, AI, the media folder, tuning values; D62), saved templates (`templates.json`), filler-list roles and folder links (`filler-roles.json`), picked station IDs (`station-ids.json`), server settings changed from the desk (`settings.json`), snapshots (`snapshots/<channel>.json`), shared drafts (`drafts/`) and scheduled changes (`scheduled.json`); plus the video files users upload to the media folder (`LINEUP_MEDIA_DIR`, when set). In memory it keeps channel locks and the logo cache.
- **The browser** keeps per-channel drafts (unsaved order and edit list) in IndexedDB (database `tunarr-lineup`, store `drafts`, key `channelId`). Each draft is tied to the programming version it was made against and is dropped once that version is gone.
  - If IndexedDB is unavailable, fails or doesn't answer within 4 s, an in-memory store is used for the rest of the visit and `draftStore().persistent` is false unless the companion keeps the drafts.
  - Drafts are also written to the companion (`sharedDraftStore` over `companionDrafts`), and a load takes the newer copy, so they follow the user between devices. Without the companion's draft routes (hosted preview) they stay per browser.
- **Per-viewer conveniences** in `localStorage`: the last channel opened (`tunarr-lineup-last-channel`, checked against the channel list before use), the lineup check's settings per channel (`lineup-check:<id>`) and the skin (`tunarr-lineup-skin`, one of the `lib/skins.ts` ids), wrapped in try/catch. The skin is never sent to the companion or Tunarr and isn't a server setting (`server/settings.ts`); without storage it applies for the visit only.
- **Not persisted:** slot-schedule drafts and demo edits live only in React state.

## 10. Authentication

**Always on after setup (D62).** `server/auth.ts` implements HTTP Basic against
the account in `config.json`: the password is kept as a salted scrypt hash
(N=2^15, r=8, p=1) and checked with `timingSafeEqual`. Basic sends the password
with every request, so a successful check is remembered by a SHA-256 digest of
hash, user and password (at most 64), not re-derived each time. `createLineupServer`
takes `auth` as a function (`setup.auth()`), so finishing setup or changing the
password applies at once. Before setup there is no account; the setup code
guards the wizard instead, and every other route answers `503`. The desktop app
also passes `LINEUP_APP_KEY`, accepted as user `lineup-desktop` so its window
signs in by itself (Electron's `login` event, own origin only). `/healthz`
stays open.

Cross-site writes are refused independently of sign-in: by the Origin check,
and by the JSON content type, which forces a CORS preflight the server never
approves.

**DNS rebinding.** The Origin check alone can't stop a page whose own host name
was re-pointed at the companion: Origin and Host then both carry the attacker's
name. With sign-in (always, after setup) the check isn't needed: the browser has
no credentials for the rebound name, so it gets `401`. During setup it is
skipped too, since only the code-checked routes answer. Only a server built
without setup (tests) and without a password uses `server/hosts.ts`: IP
addresses, `localhost` and the names in `LINEUP_ALLOWED_HOSTS` (`.domain`
matches subdomains, `*` turns the check off).
`x-forwarded-host` is never used for this check, since a same-origin page can
set it. Optional basic auth to Tunarr itself comes from userinfo in Tunarr's
address.

## 11. Environment configuration

Since D62 the keys in `CONFIG_KEYS` (`TUNARR_URL`, the timeouts, logos, the
scheduler, `LINEUP_AI_*`, `LINEUP_MEDIA_*`) and the account come from
`config.json`, set in the setup wizard. The environment supplies them only once,
on the first start without a `config.json` (`importEnv`; `LINEUP_PASSWORD` and
`LINEUP_USERNAME` become the account, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` become
`LINEUP_AI_API_KEY`), and is ignored for them afterwards (the log lists any
still set). The table names them by the keys the modules read.

| Variable | Read by | Purpose |
| --- | --- | --- |
| `TUNARR_URL` | `createProxyConfig` (via `bootCompanion`) | Upstream Tunarr base URL (server-side only) |
| `TUNARR_TIMEOUT_MS`, `TUNARR_SAVE_TIMEOUT_MS` | `createProxyConfig` | Upstream timeouts |
| `LINEUP_EXTERNAL_LOGOS` | `createProxyConfig` | `false` stops fetching channel logos from public sites |
| `LINEUP_COMPRESSION` | `createProxyConfig` → `nodeAdapter`, `server/app.ts` | `off` stops compressing JSON and static files (default on) |
| `LINEUP_PROGRAMMING_CACHE_MS` | `createProgrammingCache` | How long a channel's programming read is reused (default 0: only shared while in flight) |
| `LINEUP_DATA_DIR` | `createProxyConfig` → the stores and the scheduler | Lineup's data folder (default `./data`, `/data` in Docker) |
| `LINEUP_SCHEDULER` | `createProxyConfig` → `createScheduler` | `on` saves scheduled changes when due (default off) |
| `LINEUP_MEDIA_DIR`, `LINEUP_MEDIA_TUNARR_DIR`, `LINEUP_MEDIA_MAX_MB` | `createMediaFolder` | The media folder as Lineup sees it (uploads off when unset), as Tunarr sees it (default: the same), and the upload size limit (default 4096 MB) |
| `LINEUP_NOTIFY_URL`, `LINEUP_NOTIFY_EVENTS`, `LINEUP_NOTIFY_NAMES`, `LINEUP_NOTIFY_PRIVATE` | `readNotifySettings` (via `createNotifier`) | The webhook (off when unset), its events (comma-separated; a default set when unset), names opt-in (`on`), the private-network exception (`on`). Set from Server Settings |
| `LINEUP_AI_PROVIDER`, `LINEUP_AI_API_KEY` (or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`), `LINEUP_AI_MODEL`, `LINEUP_AI_BASE_URL`, `LINEUP_AI_TIMEOUT_MS` | `createAiConfig` | AI assistant provider (off when unset) |
| `LINEUP_PASSWORD`, `LINEUP_USERNAME` | `importEnv` (`createAuthConfig`) | Imported once as the account |
| `LINEUP_ALLOWED_HOSTS` | `createHostPolicy` | Host names answered without sign-in (servers without setup), besides IPs and `localhost` |
| `LINEUP_SETUP_CODE`, `LINEUP_APP_KEY` | `bootCompanion` | A fixed setup code instead of a printed one, and the desktop window's key (both set by the desktop app) |
| `PORT` (3000), `HOST` (`0.0.0.0`), `STATIC_DIR` | `server/main.ts` | Listen address and UI directory |
| `NEXT_PUBLIC_SITE_URL` | `app/layout.tsx` | Hosted `metadataBase` (default `http://localhost:3000`) |
| `WRANGLER_*`, `MINIFLARE_REGISTRY_PATH` | `vite.config.ts` | Hosted dev tooling |
| `PLAYWRIGHT_CHANNEL`, `CI` | `playwright.config.ts` | Browser choice and retries/reporting for e2e |

The keys in `EDITABLE_SETTINGS` (`server/settings.ts`) can be overridden from
Setup → Server Settings…; saved values in `settings.json` win over the setup
values and are applied at startup and on every save (`applySettings`).

Only `LINEUP_PUBLIC_`-prefixed variables can reach the companion client
bundle (`envPrefix`); none are used.

## 12. Build and deployment

- **Companion image** (`Dockerfile`):
  1. A `node:22-alpine` build stage runs `npm ci --ignore-scripts` and `npm run build:local`.
  2. The runtime stage copies only `dist-server/` and `dist-local/` and runs as `USER node`.
  3. It has a `HEALTHCHECK` on `/healthz` and starts with `CMD node dist-server/main.js`.

  Nothing is baked in: settings come from the setup wizard into `/data/config.json`.
- **`docker-compose.example.yml`:** Tunarr plus Lineup (the published `ghcr.io/augustosc-eu/tunarr-lineup` image, or `build: .`) on a shared network, with no settings: the wizard finds Tunarr at `http://tunarr:8000`. Comments cover the setup code (`docker logs`), importing old variables, the shared `/media/lineup` upload volume, the amd64-only Tunarr image, and binding to `127.0.0.1`.
- **Hosted:** `vinext build` with the `cloudflare()` plugin → `dist/`.
- **Desktop** (`desktop/`, D58): `npm run build:desktop` runs `build:local`, then electron-builder in `desktop/`. The app holds `main.mjs` and `lineupEnv.mjs`; `dist-server/`, `dist-local/` and a `{"type":"module"}` `package.json` go to `resources/companion/` (`extraResources`), outside the asar. At launch `main.mjs`:
  1. reads `<userData>/lineup.env` (written commented-out on first run) and picks the port: `PORT` from the file, else the last one used (default 47300) if free, else any free port, kept in `desktop.json` because drafts and the skin are stored per origin;
  2. forks the companion with `utilityProcess` (Electron's Node, no separate runtime) with `HOST=127.0.0.1` unless the file sets `HOST`, `LINEUP_DATA_DIR=<userData>/data` unless set, `STATIC_DIR`, and this launch's `LINEUP_APP_KEY` and `LINEUP_SETUP_CODE` (D62); output goes to `<userData>/logs/lineup.log`. Other variables in an older `lineup.env` reach the companion only for its one-time import;
  3. waits for `/healthz`, then loads `http://127.0.0.1:<port>/#setup=<code>` in a `BrowserWindow` with `contextIsolation`, `sandbox`, no Node integration and no preload. Navigation off that origin is refused and `http(s)` links open in the system browser; permission requests other than fullscreen and clipboard writes are denied. The `login` event answers the companion's own Basic challenge only, as `lineup-desktop` with the app key.

  Its menu (File → Open Settings File…, Restart Lineup Server, Show Data Folder, Show Server Log; Edit; View) is hidden on Windows and Linux until Alt. A single-instance lock focuses the open window. On macOS closing the window leaves the server (and scheduler) running; quitting stops it with SIGTERM.
- **Android app** (`android/`, D60): one APK, `minSdk` 24, `targetSdk` 36, launcher and Android TV (leanback, banner, no touchscreen needed). Only the `INTERNET` permission; cleartext allowed for LAN `http`; `allowBackup` off.
  1. `SetupActivity` normalizes the typed address with `ServerAddress.normalize` (http/https, host, optional port, no user info, path, query or fragment; a bare host gets `http://` and port 3000; default ports dropped), checks `GET <origin>/healthz`, and saves the origin (`Prefs`, private storage). It is the companion's address, never Tunarr's.
  2. `MainActivity` loads `<origin>/` in a WebView with JavaScript and DOM storage on (drafts, skin), file and content access off, no JavaScript interface, no multiple windows. `shouldOverrideUrlLoading` keeps only same-origin URLs (`ServerAddress.isSameOrigin`) and sends other `http(s)` links to the browser. Basic auth is answered for that host only, from a remembered sign-in once per load, then by asking. File inputs (media uploads) use the system picker; element fullscreen uses `onShowCustomView`; other permission requests are denied. Downloads (blob exports) aren't supported and say so.
  3. Keys: Back (the `OnBackInvokedCallback` from Android 13, the `KEYCODE_BACK` key before) sends Escape to the page, or leaves fullscreen or the error screen; `CHANNEL_UP/DOWN` become `PAGE_UP/DOWN`; Menu opens Reload / Change server address / Quit. A launcher shortcut (`res/xml/shortcuts.xml`) and the error screen also reach setup. Edge-to-edge insets are padded from Android 11 (`Insets`).

  Version: `versionName` is the root `package.json` version, `versionCode` `YEAR*10000 + MONTH*100 + N`. Release signing comes from `ANDROID_KEYSTORE` (a PKCS#12 file) and the password/alias variables; without them, release builds use the debug key.
- **Installable web app** (D59): `public/manifest.webmanifest` (standalone, `start_url` `/`, icons including a maskable one), linked from `local/index.html` with `crossorigin="use-credentials"` so it loads behind sign-in, and from `app/layout.tsx` metadata, plus Apple touch icon and web-app meta tags. `server/app.ts` serves `.webmanifest` as `application/manifest+json`; the CSP is unchanged (`manifest-src` falls back to `default-src 'self'`). No service worker, so nothing is cached offline.
- **CI** (`.github/workflows/ci.yml`):
  - **`checks` job:** `npm ci`, lint, typecheck, `npm test`, both builds, `playwright install chromium`, `test:e2e`, and the report as an artifact on failure.
  - **`android` job:** Gradle wrapper validation, JDK 21, `./gradlew testDebugUnitTest lintDebug assembleDebug` in `android/`, reports as an artifact on failure.
  - **`docker` job:** image build, then curls `/healthz` until the container answers.
- **Desktop release** (`.github/workflows/desktop.yml`): on the same published release (or by hand: with a tag it attaches to that release, without one it only builds the chosen branch), a matrix of macOS, Windows and Linux runners runs `build:local` and `npm run dist` in `desktop/`, keeps them as run artifacts (14 days) and, with a tag, `gh release upload`s the `.dmg`, `.zip`, `.exe`, `.AppImage` and `.deb` files. Unsigned unless electron-builder's signing secrets are set.
- **Android release** (`.github/workflows/android.yml`): on the same published release (or by hand, with or without a tag), validates the Gradle wrapper, decodes `ANDROID_KEYSTORE_BASE64` to a temporary file (removed afterwards), runs `testDebugUnitTest assembleRelease` (AGP 9 only makes unit-test tasks for the debug build type), renames the APK `Tunarr-Lineup-<version>-android.apk`, keeps it as an artifact and attaches it with a tag. Without the secret it warns and signs with a debug key.
- **Release** (`.github/workflows/release.yml`): publishing a GitHub release `vYEAR.MONTH.N` (for example `v2026.10.3`, no leading zero on the month) builds the multi-arch image with QEMU and Buildx, pushes it to GHCR as `:YEAR.MONTH.N`, `:YEAR.MONTH` and `:latest`, then runs the pushed image and curls `/healthz`. It can also be run by hand for an existing tag; a hand run doesn't move `:latest`. Notes come from `CHANGELOG.md`.

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
  - `programmingCache.test.ts` (slim programming, ETag/304, shared reads, the optional TTL and invalidation by writes, compression over real HTTP, size and time budgets on a synthetic 5,000-item channel), `loading.test.ts` (client phases, cancellation and timeouts, hanging IndexedDB and companion draft stores, row window, `?channel=` and the last channel), `pageLoading.test.tsx` (the desk with hanging or slow draft stores, empty/small/5,000-item channels, quick switching, Cancel and Try again, late drafts, day changes, unmounting, the channel in the address).
  - `skins.test.ts`: skin ids and the Platinum fallback, `public/skin-init.js` run in a `node:vm` sandbox (valid, unknown, throwing storage), and the stylesheet: each skin overrides only tokens `:root` defines, every `var()` used is defined, only Broadcast is dark. The `appearance` block in `page.test.tsx` covers the dialog (View menu and phone sheet, arrows and Enter, Done and Escape, saving at once, restore after remount, unknown values, storage that throws or is missing).
  - `epg.test.ts` (entries, checks, a well-formed escaped XMLTV preview parsed with `DOMParser`).
  - `notify.test.ts` (address rules (public on HTTPS 443 even with the private option, private-only for http or other ports, mixed answers refused), URL checks, pinned lookups, redirects, timeouts, retries, dedupe, the payload, and events from the scheduler, refused saves, batches and the Control Room without addresses or reasons); `setup.test.ts` (write-only address, re-checked exception, test route) and `setupWizard.test.tsx` (the Notifications section).
  - `planner.test.ts` (determinism, weights, orders, limits, dayparts, warnings, 150 generated plans against every invariant, timing, saving with `startTime`, the airing limit never passed off as complete, exact daypart boundaries incl. a clock change) and `plannerDialog.test.tsx` (preview, stale preview, saving exactly the previewed items, refusals).
  - `calendar.test.ts` (zones, clock changes, recurrences, validation, conflicts, priority, arming and restoring with the scheduler, restart, re-arming on calendar changes (priority added, changed, winner off or removed, idempotency, an occurrence on air untouched, the tie-break), failing closed (a reconcile that fails holds a stale plan with nothing written and lets it go once it can, an edit or new entry saved while reconciling fails answers `reconciled: false`, an edit landing between arming and applying cancels instead, an edit sent while an occurrence goes in waits for it), the revision (lead time and name invalidate, started occurrences untouched), routes) and `calendarDialog.test.tsx` (save, schedule yearly, refused overlap, priority, the unreconciled warning).
  - `batch.test.ts` (validation, previews, conflicts, Tunarr going down mid-batch, applies that name a channel without a valid fingerprint (refused whole, nothing recorded or written, renumbering included), renumbering swaps and cycles (spare numbers inside 1–99,999 near the top of the range, refused before writing with none free, a spare taken meanwhile), outside changes before or between moves, media repair with replacements checked in Tunarr, packages, conditional rollback, the record) and `batchDialog.test.tsx` (the dialog through the real routes: group change and rollback, repair needing an updated preview, Back).
  - `controlRoom.test.ts` (health rules, loops across checks, summary parts failing independently, bounded concurrency, the stream check) and `controlRoomDialog.test.tsx` (the dialog by keys alone); `page.test.tsx` opens it with `O` and acts on another channel once it loads.
  - `compatibility.test.ts` (the matrix's decisions (required routes missing from the description → unavailable even when reading works, a part's route missing → that part refused and the capability degraded, a successful read never vouching for writes, a missing `DELETE` on every manager, channel creation off only when none of it is listed, a description that failed to load leaving writes unchecked, timeouts → degraded), versions, Tunarr without `/api/version` or `/openapi.json`, partial degradation, Tunarr down, read-only and address-free reports, cache, refresh, shared runs, the diagnostics file); `settingsDialogs.test.tsx` covers the Compatibility panel (including "Partly turned off") and the managers turning off parts they can't do, and `page.test.tsx` the desk refusing only unavailable features.
  - `watch.test.ts` (guide, sessions, stream rewriting and refusals, redirect graph), `scheduler.test.ts` (plans, patches, overlays, skips, cancel, the snapshot an overlay's restore needs: nothing written without it, a missing one failed, a changed channel skipped; calendar changes held by their guard with what follows on the channel, never applied without one, skipped when their time runs out while held, not applied when cancelled while waiting), `companionStores.test.ts` (snapshots, shared drafts, media playback ranges, AI review), `tvRemote.test.ts` (remote keys, CH±, number entry, retry waits, now/next), `deskTools.test.ts` (lineup check, alignment, marathons, air-once patches, week log, guide grid, browser draft sync, lineup files). Tests that build a full config use a temporary `LINEUP_DATA_DIR` (`tests/tempData.ts`).
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
  - `skins.spec.ts`: picking each skin by keyboard, checked through computed styles (desktop, selection, `color-scheme`); persistence across a reload; `skin-init.js` applying the skin with the app bundle blocked; Escape keeping the pick; the desk, guide grid, week view and Watch Live (OSD, cable guide focus and ↓, remote) under every skin without horizontal overflow; and the phone Menu sheet.
  - `large-channel.spec.ts`: synthetic channels from `e2e/syntheticChannel.mjs` (added to the fake with `/__test/large`; `/__test/delay` slows its programming) at 5,000 and 20,000 items, a day of short spots and a throttled 1.6 Mbit/s link; prints `[perf]` JSON and checks budgets for bytes on the wire, time to open, mounted rows, heap, channel and day switches.
  - `operations.spec.ts`: the guide preview (listing, a flex-title check, an XMLTV download without addresses); notifications (loopback refused even with the private exception, a write-only public address, a test failing cleanly on DNS, turning off); the advanced planner (a show, a day, a seed, preview, save checked in the fake); the schedule library and calendar (save, yearly entry, refused overlap, kept after a reload, remove); batch operations by keyboard (group change, rollback, Recent batches), media repair after `/__test/forget-program`, and a package exported and imported; also Compatibility in Server Settings (diagnostics without the address or password; a route the fake Tunarr drops with `/__test/missing-routes` refuses only its feature) and the Control Room by remote (check all, filters, actions, Back) at 1920×1080 and phone width. The fake also answers `/api/version` and `/openapi.json`.
  - `tools.spec.ts`: viewer counts without addresses, the guide grid by remote, watching through the companion only, the lineup check and snapshot restore, the week view export, and a planned/cancelled dated save. The fake also serves `/api/guide/channels`, `/api/sessions` and `/stream/channels/…`. Each test clears the companion's shared drafts first.

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
