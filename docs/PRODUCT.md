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
| **Hosted preview** | The Vinext build for a Cloudflare Workers runtime. Demo-only. |

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

A selection is one program or a **block**: Shift-click, or Shift+↑/↓, selects a contiguous run. A channel opens with the program on air selected. Until you pick a row on the day shown, the selection stays on what's on air (or the day's first program), so Insert and Remove always act on something you can see.

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

- **Insert…** (`I`, Edit menu, inspector) works on any channel, including an empty one or one generated from a slot schedule (saving warns first). Choose where and what:
  - **Where:** before or after the selection, or **At a time…**: a date and time on any day. A time snaps to the next program boundary (or, if you choose, the one before), because Tunarr can't cut a program short.
  - The dialog says when the new items will start before anything changes, and afterwards the desk goes to that day and selects them. The edit list records the time ("Inserted “…” at 20:30:00").
  - A manual lineup repeats from the channel's start time, so adding to it makes every pass longer. On a channel that has already repeated, that moves the programs around the insert too; the dialog says so, and the times shown are where things really air.
  - **Keep what's on air in place** (in the Insert dialog and the edit list, offered once the lineup has repeated and the channel has no slot schedule): when you save, the channel's start time moves so the program on now and the rest of its pass keep their times. Everything you see while editing already reflects it. Inserts later than the current pass still move what's around them, and the dialog says so. If Tunarr refuses the new start time, the lineup is still saved and the desk says the start time didn't move.
  - **Programs from the library:** browse a media source and library, search, open a show or season, then add single items or **Add all**. Picks collect in a basket; **Insert N** adds them in order.
  - **Commercial break:** flex time of a set length, filled from chosen filler lists, with an optional repeat cooldown.
  - **Flex time** or a **redirect** to another channel, of a set length.
- **Remove** (`Delete`, Edit menu, inspector) takes the selection out of the lineup.
- **Length:** flex time, commercial breaks and redirects show a length editor in the inspector.
- **Saving:** inserted items are kept in the draft with their titles, and saved like any other edit. Tunarr validates that every program exists.

### 4b. Filler lists, custom shows and channel commercials

- **Lists → Filler Lists… / Custom Shows…:** create, rename, delete, and add or remove programs (custom shows can also be reordered). Filler lists are where commercials, bumpers and station IDs live. A filler list needs at least one program. Custom shows synced from a Plex playlist keep their sync.
- **Channel → Channel Settings…** (tabs):
  - **General:** name, number, group, guide title for flex time, minimum guide entry length, lineup start time (shifts the whole schedule, with a warning), hidden channel, on demand.
  - **Logo & watermark:** logo address and corner, on-screen watermark (image, corner, size, margins, opacity, duration), and the offline screen.
  - **Streaming:** stream format, transcode profile, subtitles.
  - **Commercials:** filler lists that play during flex time (weight, share and cooldown), a repeat cooldown, and whether to hide the watermark during filler.
- **Lists → Smart Collections…:** saved searches built from rules (genre, type, rating, studio, people, tags, titles, audio language, year, length, season number, added or released in the last N days/weeks/months/years), match all or any, optional keywords, with a preview of how many programs match.

### 4c. Channels and Tunarr setup

- **Channel → New Channel… / Duplicate Channel…:** name, number (next free one by default), group, and the transcode profile (new) or the channel to copy (duplicate). Lineup switches to the new channel.
- **Channel → Delete Channel…:** asks first, then removes the channel from Tunarr and moves to a neighbouring channel.
- **Setup → Media Sources…:** add Plex (address and token), Jellyfin or Emby (address, user name and password; Tunarr signs in), or local folders; turn libraries on or off, refresh and scan them; remove sources. Addresses, tokens and folder paths are never shown back.
- **Setup → Transcode Profiles…:** resolution, codecs, bit depth, bitrates and buffers, hardware acceleration, threads, audio channels, sample rate, volume and loudness, error screen and audio, frame-rate and deinterlace options; duplicate or delete profiles.
- **Logos:** channel logos appear in the channel list and the schedule header. Channels without a usable logo show their number.

### 4d. Start from a programming template

**Channel → Programming Templates…** shows the gallery:

- **General:** general entertainment, kids & cartoons, movie channel, music videos, 24-hour news.
- **Inspired by mainstream networks:**
  - **Japan:** NHK General, NHK E-tele, Nippon TV, TBS, Fuji TV, TV Asahi, TV Tokyo, MTV Japan, Space Shower TV, MUSIC ON! TV, Music Japan TV
  - **Argentina:** Telefe, El Trece, TV Pública, América, El Nueve, TN
  - **United States:** ABC, CBS, NBC, FOX, The CW, PBS, Univision, Telemundo, ESPN, CNN, HBO, Nickelodeon, Disney Channel, Cartoon Network, Discovery, MTV (classic), VH1 (classic), CMT music, BET Jams, TCM
  - **Canada:** MuchMusic (classic)
  - **Spain:** La 1, La 2, Antena 3, Telecinco, Cuatro, laSexta
  - **United Kingdom:** BBC One, BBC Two, ITV1, Channel 4, Channel 5, The Box, Kerrang! TV
  - **Italy:** Rai 1, Rai 2, Rai 3, Canale 5, Italia 1, Rete 4, La7
- **My templates:** the user's saved ones, shared by every browser.

It can be filtered by country or searched. Each template shows a day plan (Mon–Fri, any single weekday that differs, Saturday and Sunday) with each block's ad level, and its market's commercial style.

1. Fill each role with a library show, movies, a custom show, an existing smart collection, or the suggested new smart collection (its match count is shown); or leave it out.
2. Pick the commercials and promos filler lists (likely ones are preselected by name).
3. Choose this channel or a new one. The schedule opens in the slot editor as a time-slot draft, to adjust, preview and save.

Templates follow a network's style; they are not its official schedule, and carry no logos.

**Your own templates:** **New template**, **Copy and edit…**, or **Save this channel's format** (a time-slot channel's schedule, with its sources pre-filled). The editor sets name and description, the day plan (every day; weekdays, Saturday and Sunday; or each day), blocks (start, role, ad level: none, light, standard, heavy), roles (name, hint, play order, a suggestion such as "TV episodes with show genre Drama"), the start-time grid, how late a block may start, and the commercial style (breaks inside programs, and where commercials and promos play).

**Ask AI…:** describe the channel ("a 90s Saturday-morning cartoon channel", "program this like Rai 1"), optionally using the library, what the channel plays now, and a template to start from. The AI writes a template, fills roles with the library's shows and collections where they fit, suggests smart collections for the rest, picks commercial lists, and notes what's missing. The draft can be saved, edited or applied; nothing changes until preview and save. It needs an AI provider configured on the Lineup server.

### 4e. Schedule an event on a date

**Edit → Schedule Event…** (`E`): pick a date and time and what airs (programs from the library, a simulcast of another channel, or off-air time). If a program is still on at that time, the event starts when it ends (or in its place). **Replace** takes off what would have aired and adds flex so everything after keeps its time; **Push** moves everything later. The preview shows the exact start and end, what is taken off, and when the lineup repeats (the event repeats with it). It becomes an edit in the edit list and is saved like any other. On slot-scheduled channels, regenerating the schedule removes it.

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
   - **Time slots:** start time (and weekday, Sunday to Saturday, for weekly schedules), source, order, plus "shift every slot".
   - **More** on a show, movie, custom-show or smart-collection slot:
     - **Seasons** (show slots): all, only some, or all but some, from the show's real seasons.
     - **Direction:** first to last, or last to first.
     - **Linked slots:** share one episode list with other slots playing the same source, so each picks up where the last stopped. In time-slot schedules a linked slot can rerun what the group played (then flex or new episodes when the reruns run out). Random-slot groups always continue, as Tunarr requires.
     - **Commercials:** filler lists playing before or after each program, at the slot's start or end, as fallback, or as **mid-roll breaks** (every N minutes, break length, a maximum count, only in programs longer than N minutes).
   - **Movie pool:** movie slots draw from the channel's movies; **Add movies…** adds more from the library. They're used on save; Tunarr's preview only uses movies already on the channel.

   Problems Tunarr would reject (overlapping start times, negative weights, linked slots with different sources or orders) are flagged per slot.
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
- **Artwork and logos come through the companion,** never straight from Tunarr, the media server or a logo's website. Demo data uses coloured letter tiles and channel numbers.
- **Day boundaries use the browser's local time zone.**

## Constraints

- **Network topology:** Tunarr usually runs on a private address over HTTP. The browser therefore can't call it from an HTTPS hosted page, and real use requires the companion running where it can reach Tunarr (`README.md`).
- **Sign-in is optional:** without `LINEUP_PASSWORD`, anyone who can reach the companion's port can rewrite channel programming. With it, HTTP Basic sign-in protects everything but `/healthz`.
- **Host names:** without sign-in, Lineup answers only to IP addresses, `localhost` and the names in `LINEUP_ALLOWED_HOSTS`, so other websites can't reach it through DNS rebinding.
- **Tunarr API compatibility:** Lineup depends on Tunarr's channel, programming, lineup, schedule, artwork, search, filler-list, custom-show, smart-collection, transcode-config and media-source endpoints and their payload shapes (see `docs/ARCHITECTURE.md`). The code doesn't detect Tunarr versions.
- **Generated schedules:** saving manually can detach a channel from its generated schedule. Tunarr may also regenerate over manual edits.
- **TV readability and remote operation:** text must stay large and anti-aliased, and every action must work without a mouse. The UI scales with viewport width.
- **Conflict check window:** the companion checks and writes under a per-channel lock, so two Lineup sessions can't overwrite each other. Tunarr's API has no conditional save, so an edit made in Tunarr's own UI in the milliseconds between check and write would still be overwritten.
- **Drafts are per browser:** unsaved work on the TV isn't visible from a laptop, and vice versa.

## Out of scope (as built)

The code does not implement:
- uploading logo or media files (logos are set by address), Plex OAuth sign-in (a token is entered), and Tunarr's global settings (FFmpeg, HDHomeRun, XMLTV)
- events that air once only (an event repeats with the lineup's cycle) or that cut into a program mid-way
- AI-written lineups that bypass preview (the AI only writes templates)
- time-slot per-slot padding/lateness overrides
- user accounts or roles beyond the single optional password
- syncing drafts between devices (drafts live in each browser), or persisting slot-schedule drafts across reloads
