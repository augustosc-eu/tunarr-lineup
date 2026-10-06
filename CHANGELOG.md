# Changelog

All notable changes to Tunarr Lineup are listed here. Versions follow
[Semantic Versioning](https://semver.org); until 1.0, minor versions may
change behavior.

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

[0.1.0]: https://github.com/augustosc-eu/tunarr-lineup/releases/tag/v0.1.0
