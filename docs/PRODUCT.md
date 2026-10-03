# Product: Tunarr Lineup

## What it is

Tunarr Lineup is a **programming desk** for [Tunarr](https://tunarr.com)
channels. Tunarr builds live-TV-style channels from media libraries. Lineup
shows a channel's schedule for any day and lets the user:
- arrange, insert and remove programs
- build and edit slot schedules
- add commercials and filler
- manage filler lists, custom shows and programming-related channel settings

Everything is saved through Tunarr's own API.

It works only with media Tunarr has already indexed. It doesn't add media
sources, scan libraries, change transcoding or streaming, or create and delete
channels. Those stay in Tunarr's own interface.

The interface imitates classic Mac OS 9: platinum window chrome, striped title
bars, bevelled buttons, Geneva/Charcoal-style type. The visual identity is
deliberate (see `docs/DECISIONS.md`).

## Who it serves

People who self-host Tunarr and program their channels like a broadcaster. The
repository owner runs it on a
**television** and views it from a distance, which shapes the typography
(`app/globals.css`: "about 24px on a 1080p TV viewed from the couch").

There is no multi-user model, no accounts, and no roles. Whoever can reach the
companion app can edit every channel's programming (see Constraints).

## Terminology

| Term | Meaning in this product |
| --- | --- |
| **Channel** | A Tunarr channel: `id`, `number`, `name`, `startTime`, `duration`, `programCount` (`Channel` in `lib/lineup.ts`). |
| **Lineup** | The ordered list of lineup items that a channel plays in a repeating **cycle**, starting from the channel's `startTime`. |
| **Lineup item** | One entry in a lineup. Types: `content` (a media program), `flex` (open airtime/filler slot), `redirect` (hand off to another channel), `custom` (an item from a custom show), `filler` (an item from a filler list). Items carry extra Tunarr fields that must be preserved. |
| **Programming** | Tunarr's response for a channel: `lineup`, a `programs` map (metadata keyed by program id), optional `schedule`, `startTimeOffsets`, etc. |
| **Program** | Metadata for a content item: title, show, season/episode, year, type. |
| **Guide** | Tunarr's time-stamped schedule for a date range (`/api/channels/:id/lineup`). Tunarr keeps a guide only for a window around the current time. |
| **Projection** | Lineup's own calculation of start times, made by walking the lineup cycle from `startTime`. Used where the guide has no data or disagrees with the lineup. |
| **Generated schedule** | A Tunarr slot or time schedule that generates the lineup. It appears as a `schedule` field on programming. |
| **Manual lineup** | A lineup saved as an explicit ordered list (`type: "manual"`). Lineup always saves this way. |
| **Live mode** | Reading and writing a real Tunarr through the companion. |
| **Demo mode** | Built-in sample channels (`lib/demoData.ts`). Never touches Tunarr. |
| **Companion** | The local Node app (UI + proxy) that runs beside Tunarr. |
| **Hosted preview** | The Vinext/OpenAI Sites deployment. Demo-only. |

## Core user journeys

### 1. Open the app and connect

On load the app checks `/api/tunarr/health`. The top bar status button and
the connection dialog reflect one of these outcomes:

- **Connected:** "Tunarr connected". Channels load, sorted by number, and the first one opens on today's date.
- **Not configured:** the dialog explains how to set `TUNARR_URL` on the server.
- **Unreachable:** the dialog shows the error and the Tunarr host it tried. It never shows credentials.
- **Unavailable:** the deployment has no companion, as in the hosted preview. The dialog says live mode needs the companion.

In every non-connected case the user can **Check again** or choose **Use demo data**.

### 2. Browse a channel's day

- **Pick a channel** in the sidebar.
- **Pick a day:** ← / Today / → buttons, or the date picker.
- **Read the timeline:** rows grouped into Morning, Afternoon, Evening and Late night.
  - Each row shows its start as `HH:MM:SS`, artwork (or a letter tile), title, detail, and duration as `H:MM:SS`.
  - The header shows the channel's item count and cycle length; a totals row shows airtime per item type for the day.
- **See what's on air:** on today's schedule, the program airing now is marked **ON AIR** with a red line at the current second, and the view opens scrolled to it. **Now** (or `N`) jumps there from any day.
- **Search** filters the visible day.
- **Selecting a row** shows the inspector with type, title, detail, start, end, lineup position (`#k of N`) and, when on air, the time left.
- **A yellow note** explains when times come from projection instead of Tunarr's guide: outside the guide window, guide not loaded, guide stale, or unsaved changes.
- **Guide-only rows** that Tunarr's guide contains but the lineup does not (for example padding flex) appear greyed out and can't be selected.

### 3. Rearrange

A selection is one program or a **block**: Shift-click, or Shift+↑/↓, selects a contiguous run.

- **↑ Earlier / ↓ Later** (inspector or Edit menu): slide the selection past its neighbour.
- **Pick up to slide** (OK/Enter on a row):
  - The selection is marked "moving"; ↑/↓ slide it, OK drops it, and Back cancels back to exactly where it was.
  - This is the main way to move things with a TV remote.
- **Move or swap…** (`M`):
  - **Start near time:** pick a time on the day to see "Will start HH:MM:SS (±offset)", then **Move**.
  - **Lineup position:** move the selection to position N.
  - **List:** a searchable list of the channel's other items (by title, detail or `#position`, showing up to 200 at a time) with **Move before** and, for single items, **Swap**.
- **Drag a row onto another row:** moves the dragged item, or the whole block if the dragged row is part of it, before the target.

Edits mark the lineup unsaved:
- Changed rows get a yellow edge.
- The Save button becomes "Save lineup".
- The **Edit list** in the inspector names each step. **Undo** and **Redo** step through it; **Revert all** discards everything.
- **Unsaved work is kept per channel** in the browser, along with its edit list. Switching channels, reloading or turning the TV off doesn't lose it; channels with unsaved work show "unsaved" in the list. If the channel was changed in Tunarr in the meantime, the stored work no longer applies and is dropped, with a notice.
- **Leaving demo mode** with unsaved demo edits asks first, because demo edits are not kept.

### 4. Save

- **If the channel has a generated schedule,** a confirmation dialog explains that saving a manual lineup may detach the channel from its schedule.
- **The companion first checks that the channel hasn't changed elsewhere** (in another Lineup session, Tunarr's own UI, or a regeneration) since it was loaded. If it has, nothing is saved; the user can **Reload from Tunarr** or **Keep my edits**.
- **After saving, the edit list continues,** so a save can be undone and saved again.
- **The save sends the whole lineup** as a manual lineup. Zero-length items are left out, and the toast reports how many.
- **After a successful save,** the app re-reads programming and the visible day from Tunarr and refreshes the channel list.
- **On failure,** the error appears in a toast ("Not saved: …") and the unsaved changes are kept.

### 4a. Insert, remove and change lengths

- **Insert…** (`I`, Edit menu, inspector): choose where (before or after the selection) and what:
  - **Programs from the library:** browse a media source and library, search, open a show or season, then add single items or **Add all**. Picks collect in a basket; **Insert N** adds them in order.
  - **Commercial break:** flex time of a set length, filled from chosen filler lists, with an optional repeat cooldown.
  - **Flex time** or a **redirect** to another channel, of a set length.
- **Remove** (`Delete`, Edit menu, inspector) takes the selection out of the lineup.
- **Length:** flex time, commercial breaks and redirects show a length editor in the inspector.
- **Saving:** inserted items are kept in the draft with their titles, and saved like any other edit. Tunarr validates that every program exists.

### 4b. Filler lists, custom shows and channel commercials

- **Lists → Filler Lists… / Custom Shows…:** create, rename, delete, and add or remove programs (custom shows can also be reordered). Filler lists are where commercials, bumpers and station IDs live. A filler list needs at least one program. Custom shows synced from a Plex playlist keep their sync.
- **Channel → Channel Settings…:** name, number, group, guide title for flex time, minimum guide entry length, lineup start time (shifts the whole schedule, with a warning), and **commercials during flex time** (filler lists with weight, share and cooldown; a repeat cooldown; and whether to hide the watermark during filler).

### 5. Edit or create a slot schedule

For channels Tunarr generates from a slot schedule (most of the owner's
channels use random slots), and for manual channels that should get one:

1. Open **Edit slot schedule…** (or **Create Slot Schedule…**) from the generated-schedule panel or the Channel menu.
2. Choose **Random slots** or **Time slots** (switching converts the slots), and set the schedule:
   - **Random:** how slots are picked (evenly, by weight, in order), pad style.
   - **Time:** repeat daily or weekly, late start allowed, running over.
   - **Both:** start-time padding, where flex goes, days to generate.
3. Adjust the slots:
   - **Sources:** any slot can play a show (from the library), movies, a custom show, a filler list, a smart collection, a redirect, or flex. **Add a slot that plays…** adds one.
   - **Random slots:** weight (with share, or "equal"), cooldown, length (programs or minutes), order; reorder, copy or remove.
   - **Time slots:** start time (and day, for weekly schedules), source, order, plus "shift every slot".
   - **Ads** on a show, movie, custom-show or smart-collection slot: filler lists playing before or after each program, at the slot's start or end, as fallback, or as **mid-roll breaks** (every N minutes, break length, a maximum count, only in programs longer than N minutes).
   - **Movie pool:** movie slots draw from the channel's movies; **Add movies…** adds more from the library. They're used on save; Tunarr's preview only uses movies already on the channel.

   Problems Tunarr would reject (overlapping start times, negative weights) are flagged per slot.
3. **Preview lineup** regenerates the lineup in Tunarr without saving and shows it in the timeline, with a pinned preview bar. Browse any day, then **Save schedule**, **Edit slots** or **Discard preview** (also Back).
4. **Save schedule** uses the preview's random seed and reports whether Tunarr's saved result matches the preview. The lineup's edit list starts fresh, because the lineup was regenerated.

**Detach to manual lineup** keeps today's lineup as a manual lineup and drops
the schedule.

### 6. Export a program log

**File → Export Program Log…** downloads the visible day as CSV: date,
start, end, duration, type, title, detail and lineup position. If the lineup
has unsaved changes, the filename says `-unsaved`.

### 7. Drive it with a remote or keyboard

| Remote / keyboard | Action |
| --- | --- |
| ↑ / ↓ | Move between programs |
| ← / → | Change day |
| CH+ / CH−, PgUp / PgDn | Change channel |
| OK / Enter | Pick up or drop |
| Back / Esc | Cancel a move, or close a dialog |
| `N` / `T` / `M` / `?` | Now / today / Move dialog / shortcuts |
| ⌘ or Ctrl + Z, Shift+Z (or Y), S | Undo, redo, save |

The menus can also be operated with the arrows, OK and Back.

### 8. Demo mode

- **Entering:** chosen explicitly. The labels change to "Demo mode", "DEMO CHANNELS" and "DEMO · …".
- **Sample data:** three sample channels, all showing the same sample lineup.
- **Saving:** only resets the in-memory baseline ("Demo changes saved for this session").
- **Leaving:** the connection dialog offers **Connect to Tunarr**.

## Intended behavior and product rules

- **Live and demo never mix.** A failed live request never switches to demo data.
- **What Tunarr returns is the source of truth.** After saving, the UI shows the re-fetched state, not the local copy.
- **Times are honest.** When times are projected rather than taken from Tunarr's guide, the UI says so.
- **Artwork comes through the companion** from Tunarr's artwork endpoint, never straight from Tunarr or the media server. Demo data uses coloured letter tiles.
- **Day boundaries use the browser's local time zone.**

## Constraints

- **Network topology:** Tunarr usually runs on a private address over HTTP. The browser therefore can't call it from an HTTPS hosted page, and real use requires the companion running where it can reach Tunarr (`README.md`).
- **Sign-in is optional:** without `LINEUP_PASSWORD`, anyone who can reach the companion's port can rewrite channel programming. With it, HTTP Basic sign-in protects everything but `/healthz`.
- **Tunarr API compatibility:** Lineup depends on Tunarr's `/api/channels`, `/api/channels/:id/programming` (GET/POST), `/api/channels/:id/lineup` and `/api/programs/:id/artwork/:type` endpoints and their payload shapes. The code doesn't detect Tunarr versions.
- **Generated schedules:** saving manually can detach a channel from its generated schedule. Tunarr may also regenerate over manual edits.
- **TV readability and remote operation:** text must stay large and anti-aliased, and every action must work without a mouse. The UI scales with viewport width.
- **Conflict check window:** the companion checks and writes under a per-channel lock, so two Lineup sessions can't overwrite each other. Tunarr's API has no conditional save, so an edit made in Tunarr's own UI in the milliseconds between check and write would still be overwritten.
- **Drafts are per browser:** unsaved work on the TV isn't visible from a laptop, and vice versa.

## Out of scope (as built)

The code does not implement:
- adding media sources, scanning libraries, or changing transcoding, streaming, watermarks or offline-screen settings
- creating or deleting channels
- per-season filters on show slots, time-slot per-slot padding/lateness overrides, slot iteration groups (existing ones are kept), and smart-collection authoring
- user accounts or roles beyond the single optional password
- syncing drafts between devices (drafts live in each browser), or persisting slot-schedule drafts across reloads
