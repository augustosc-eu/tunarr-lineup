# Changelog

All notable changes to Tunarr Lineup are listed here. Versions follow
[Semantic Versioning](https://semver.org); until 1.0, minor versions may
change behavior.

## [Unreleased]

## [0.2.0] - 2026-10-07

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

## [0.1.0] - 2026-10-06

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

[Unreleased]: https://github.com/augustosc-eu/tunarr-lineup/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/augustosc-eu/tunarr-lineup/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/augustosc-eu/tunarr-lineup/releases/tag/v0.1.0
