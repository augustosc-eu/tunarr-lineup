# Changelog

All notable changes to Tunarr Lineup are listed here. Versions are
`YEAR.MONTH.N`: the year and month of the release (no leading zero), and N
counting that month's releases from 1, so 2026.10.3 is October 2026's third
release. Any release may change behavior; this list says how. 0.1.0 and 0.2.0
were renamed 2026.10.1 and 2026.10.2.

## [Unreleased]

## [2026.10.3] - 2026-10-18

### Reset Channel, and Detach that really drops the slot schedule

- **Channel → Reset Channel…** empties a channel's lineup in Tunarr after asking. The channel's name, number, logo and settings stay.
- Tunarr can't remove a slot schedule from a channel, so on a scheduled channel Reset offers **Reset and remove schedule** (clears both for good) or **Empty lineup only** (Tunarr rebuilds the lineup from the schedule at its next library scan or start-time change).
- **Detach to manual lineup** now really drops the schedule. Before, Tunarr kept it and could regenerate over the detached lineup.
- Removing a schedule recreates the channel with the same number, name, logo and settings. It gets a **new internal Tunarr id**, and other channels' redirects to it become off-air time; the dialog names those channels before you confirm.

### Station IDs per channel

- **Channel Settings → Commercials → Station IDs** ticks the station-ID lists that belong to a channel. Tunarr airs them in the channel's flex time, and Lineup's ID tools on that channel draw only from them.
- An ID whose title holds a channel's whole name, word for word, belongs to that channel ("EL 7 ID.mp4" → El 7), with no tagging. A channel with none uses IDs named for no channel, never another channel's.
- **Insert → Station ID** places one of the channel's own IDs anywhere.

### Filler folders

- **Setup → Filler Folders…** turns folders of video files into filler lists with their role (Station IDs, Commercials, Promos, Bumpers, Other), automatically: when the desk loads and while the dialog is open, Lineup makes lists for folders named for a role (any Tunarr library: "Commercials", "station-ids"…) and for folders added with a role, and refreshes each list after every newer Tunarr scan. Lists deleted in Tunarr aren't made again. Other libraries get a one-time **Make filler list**.
- **Uploads:** with `LINEUP_MEDIA_DIR` set (and the same folder mounted into Tunarr, `LINEUP_MEDIA_TUNARR_DIR`), upload videos from the desk into one folder per role, move them between roles, or delete them. Lineup adds the folder to Tunarr itself. Uploads stream to disk, never overwrite, and are limited by `LINEUP_MEDIA_MAX_MB` (default 4096).
- The compose example shares a `lineup-media` volume between Tunarr and Lineup, so uploads work out of the box. With uploads off, the dialog shows the compose lines that turn them on.

## [2026.10.2] - 2026-10-07

Released as 0.2.0.

### Station IDs, commercials and flex time

- Filler lists have an **on-air role**: Station IDs, Commercials, Promos, Bumpers or Other. Lineup keeps the role in `LINEUP_DATA_DIR/filler-roles.json` (Tunarr's lists are not renamed); untagged lists get a guess from their name.
- **Lists → Station IDs…** and **Commercials…** open the filler lists by role. Spots show broadcast lengths (`:10`, `:30`) and each list its length mix.
- Commercial breaks can **open with a station ID**: the next ID in rotation airs first and its length comes out of the break, so programs keep their times. **Edit → Open Breaks With Station IDs** does it for every break in the lineup. Slots get **Add station IDs to breaks**.
- The day view reads like a **station log**: commercial breaks, flex time, station IDs, spots, promos and redirects have their own colour, tile and badge; filler Tunarr adds from slots keeps its kind and title; each hour opens with its airtime by kind and commercial minutes; a **day strip** shows the whole day.
- **View → Show Break Rundowns** (`B`) lists an estimated fill under each break (Tunarr picks the actual spots at air time).
- Insert pre-picks the commercial lists for a break; templates, channel settings and slot commercials use the stored roles.

### Phones, tablets and other screen sizes

- On phones, **Menu** opens every menu in one list (before, the menus were hidden), and the channels are a swipeable strip that keeps the current one in view.
- Below 1180px, Program Info is a sheet over the lineup: collapsed it shows the program with Earlier/Later, Move or swap, Insert and Remove; its title bar expands the details.
- Touch screens get larger buttons, a taller menu bar and close box, and inputs that don't zoom the page.
- Text scales with the smaller of width and height, so short wide monitors no longer get TV-size type. 1080p TVs are unchanged.

### Library browser

- Libraries and folders of up to 1,000 items are listed whole, in episode order taken from the number in each title (so "Capítulo 2" and "Chapter 2" sit together as episode 2), with **Order** for title (natural, 2 before 10) or release date.
- Search filters as you type, ignores accents, and matches numbers to the title's numbers: "capitulo 2" finds "Chapter 2 - …", not "Capítulo 20".
- The basket lists every pick with a remove button, and the edit list names what was inserted.

## [2026.10.1] - 2026-10-06

Released as 0.1.0.

First public release.

### Programming desk

- A Mac OS 9–styled desk for the channels on a Tunarr server, built to be
  driven from a TV remote (arrows, OK, Back, CH±) as well as a mouse and
  keyboard.
- On-air view, broadcast timecode, day totals and a CSV program log.
- Rearrange programs: earlier/later, drag and drop, block moves, move to a
  lineup position or to the slot nearest a start time.
- Insert programs from any indexed library (Plex, Jellyfin, Emby, local
  folders), commercial breaks, flex time and redirects, before or after the
  selection or at a date and time on any channel. The dialog shows when the
  items will air. An optional **Keep what's on air in place** moves the
  channel's start time on save so the current pass keeps its times.
- Channels open with the program on air selected.
- Step-by-step undo/redo with an edit list, kept per channel in the browser
  across reloads, and carried over a save.
- Conditional saves: every save names the version it replaces, and the
  companion refuses (nothing is written) if the channel changed meanwhile.

### Scheduling

- Create and edit random- and time-slot schedules from shows, movies, custom
  shows, filler lists, smart collections and redirects, with season filters,
  linked slots and per-slot commercials. Previews are saved exactly as shown.
- Programming templates: general formats and styles inspired by mainstream
  and music networks in Japan, Argentina, the US, Canada, Spain, the UK and
  Italy; your own saved templates; and AI-written templates (Anthropic or any
  OpenAI-compatible API, including a local Ollama).
- Events on a date: place a program, simulcast or off-air time at a date and
  time, replacing what was on or pushing it later.

### Tunarr setup

- Filler lists, custom shows and smart collections.
- Channels: create, duplicate, delete, settings, logos, watermark and
  streaming options.
- Media sources (addresses and tokens are write-only) and transcode profiles.

### Running it

- Docker image for amd64 and arm64 at `ghcr.io/augustosc-eu/tunarr-lineup`, a
  compose example, or Node 22.13+.
- A dependency-free companion server: the browser only talks to it, and it
  reaches Tunarr through a narrow allowlisted proxy. Optional HTTP Basic
  sign-in and host-name checks against DNS rebinding.

[Unreleased]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.3...HEAD
[2026.10.3]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.2...v2026.10.3
[2026.10.2]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.1...v2026.10.2
[2026.10.1]: https://github.com/augustosc-eu/tunarr-lineup/releases/tag/v2026.10.1
