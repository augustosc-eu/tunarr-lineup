# Product: Tunarr Lineup

## What it is

Tunarr Lineup is a focused **programming desk** for the **order of programs
already on a [Tunarr](https://tunarr.com) channel**. Tunarr builds live-TV-style channels
from a media library. Lineup shows a channel's schedule for any day and lets
the user move or swap programs, then saves the new order back to Tunarr.

It is not a library browser or a channel builder. It never adds media, creates
programming, or edits channel settings. The UI states this directly in the
sidebar: "No library clutter. This view only changes programs already
assigned to a channel." (`app/page.tsx`).

The interface imitates classic Mac OS 9: platinum window chrome, striped title
bars, bevelled buttons, Geneva/Charcoal-style type. The visual identity is
deliberate (see `docs/DECISIONS.md`).

## Who it serves

People who self-host Tunarr and want to rearrange an existing lineup. The
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

All of these are limited to items already in the lineup. A selection is one
program or a **block**: Shift-click, or Shift+↑/↓, selects a contiguous run.

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
- With unsaved changes, switching channels, switching between live and demo, or pressing **Check again** asks for confirmation.
- In live mode, leaving the page triggers the browser's unsaved-changes prompt.

### 4. Save

- **If the channel has a generated schedule,** a confirmation dialog explains that saving a manual lineup may detach the channel from its schedule.
- **Lineup first checks the channel hasn't changed elsewhere,** in Tunarr's own UI or by a regeneration, since it was loaded. If it has, nothing is saved; the user can **Reload from Tunarr** or **Keep my edits**.
- **The save sends the whole lineup** as a manual lineup. Zero-length items are left out, and the toast reports how many.
- **After a successful save,** the app re-reads programming and the visible day from Tunarr and refreshes the channel list.
- **On failure,** the error appears in a toast ("Not saved: …") and the unsaved changes are kept.

### 5. Export a program log

**File → Export Program Log…** downloads the visible day as CSV: date,
start, end, duration, type, title, detail and lineup position. If the lineup
has unsaved changes, the filename says `-unsaved`.

### 6. Drive it with a remote or keyboard

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

### 7. Demo mode

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
- **Conflict check window:** the check happens just before the write. Tunarr's API has no conditional save, so a change made in the instant between the check and the write would still be overwritten.

## Out of scope (as built)

The code does not implement:
- adding or removing programs
- editing channel settings or slot/time schedules (the warning names the schedule type and slot count, but slots can't be edited)
- library browsing
- user accounts or roles beyond the single optional password
- persistence of any Lineup-specific data (undo history is lost on reload)
