# Product: Tunarr Lineup

## What it is

Tunarr Lineup is a focused editor for the **order of programs already on a
[Tunarr](https://tunarr.com) channel**. Tunarr builds live-TV-style channels
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
- **Read the timeline:** rows grouped into Morning, Afternoon, Evening and Late night. Each row shows start time, a letter tile, title, detail and duration.
- **Search** filters the visible day.
- **Selecting a row** shows the inspector with type, title, detail, start and end.
- **A yellow note** explains when times come from projection instead of Tunarr's guide: outside the guide window, guide not loaded, guide stale, or unsaved changes.
- **Guide-only rows** that Tunarr's guide contains but the lineup does not (for example padding flex) appear greyed out and can't be selected.

### 3. Rearrange

Three ways, all limited to items already in the lineup:

- **↑ Earlier / ↓ Later** in the inspector: swap with the neighbouring lineup item.
- **Move or swap…**: a dialog listing the channel's other items, with **Move before** and **Swap**.
- **Drag a row onto another row**: moves the dragged item before the target.

Edits mark the lineup unsaved. The Save button becomes "Save lineup" and
**Undo changes** appears; undo restores the entire last-loaded lineup, not one
step. With unsaved changes, switching channels, choosing **Use demo data**,
or pressing **Check again** asks for confirmation; **Connect to Tunarr** from
demo mode does not. In live mode, leaving the page triggers the browser's
unsaved-changes prompt.

### 4. Save

- **If the channel has a generated schedule,** a confirmation dialog explains that saving a manual lineup may detach the channel from its schedule.
- **The save sends the whole lineup** as a manual lineup. Zero-length items are left out, and the toast reports how many.
- **After a successful save,** the app re-reads programming and the visible day from Tunarr and refreshes the channel list.
- **On failure,** the error appears in a toast ("Not saved: …") and the unsaved changes are kept.

### 5. Demo mode

- **Entering:** chosen explicitly. The labels change to "Demo mode", "DEMO CHANNELS" and "DEMO · …".
- **Sample data:** three sample channels, all showing the same sample lineup.
- **Saving:** only resets the in-memory baseline ("Demo changes saved for this session").
- **Leaving:** the connection dialog offers **Connect to Tunarr**.

## Intended behavior and product rules

- **Live and demo never mix.** A failed live request never switches to demo data.
- **What Tunarr returns is the source of truth.** After saving, the UI shows the re-fetched state, not the local copy.
- **Times are honest.** When times are projected rather than taken from Tunarr's guide, the UI says so.
- **Artwork is shown only when embedded** as a `data:image/` URI. Other artwork shows a coloured letter tile, because fetching remote artwork would make the browser contact Tunarr or a media server directly.
- **Day boundaries use the browser's local time zone.**

## Constraints

- **Network topology:** Tunarr usually runs on a private address over HTTP. The browser therefore can't call it from an HTTPS hosted page, and real use requires the companion running where it can reach Tunarr (`README.md`).
- **No authentication:** the companion has none. Anyone who can reach its port can rewrite channel programming. The compose example suggests binding to `127.0.0.1` where appropriate.
- **Tunarr API compatibility:** Lineup depends on Tunarr's `/api/channels`, `/api/channels/:id/programming` (GET/POST) and `/api/channels/:id/lineup` endpoints and their payload shapes. The code doesn't detect Tunarr versions.
- **Generated schedules:** saving manually can detach a channel from its generated schedule. Tunarr may also regenerate over manual edits.
- **TV readability:** text must stay large and anti-aliased. The UI scales with viewport width.

## Out of scope (as built)

The code does not implement: adding or removing programs, editing channel
settings, library browsing, multi-step undo, authentication, or persistence of
any Lineup-specific data. The menu bar items (File, Edit, View, Channel, Help)
are decorative and have no actions.
