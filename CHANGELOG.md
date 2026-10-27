# Changelog

All notable changes to Tunarr Lineup are listed here. Versions are
`YEAR.MONTH.N`: the year and month of the release (no leading zero), and N
counting that month's releases from 1, so 2026.10.3 is October 2026's third
release. Any release may change behavior; this list says how. 0.1.0 and 0.2.0
were renamed 2026.10.1 and 2026.10.2.

## [Unreleased]

## [2026.10.23] - 2026-10-27

### Fixed

- **Custom-show slots and play order:** Tunarr plays a custom show only in order, shuffled or as an ordered shuffle; asked to play one chronologically or alphabetically, its scheduler fails with HTTP 500 ("Tunarr didn’t accept this schedule"), although its API description lists those orders. A programming template whose role is chronological or alphabetical (the music templates' Countdown, News) now plays a custom show given that role in its own order, the slot editor no longer offers those orders for custom shows, and a schedule that still has one is refused with what to change before anything reaches Tunarr.

## [2026.10.22] - 2026-10-27

### Added

- **Local videos** (Setup → Local Videos…): music videos and downloaded videos that aren't in Plex, Jellyfin or Emby. **Make folder** creates a named folder under `music-videos/` or `videos/` in Lineup's media folder to upload, play and delete videos in; **Add folder** adds a folder already on the Tunarr server. Each folder is its own Tunarr library and can keep a **custom show** of its videos, made after Tunarr's first scan and refreshed after every newer one (other videos in file-name order, "Part 2" before "Part 10"; music videos by artist, then title). These folders are never taken for filler lists.
- **Music-video blocks in the program bin:** clean titles for loose videos ("Abba – SOS", not "Abba - SOS (Official Video) [1080p]"), **Group by artist** with **+ All** per artist (artists read from "Artist - Title" file names, or the media server's), **Shuffle, artists apart** (no artist again within up to 3 videos, across passes too), **Fill a length** instead of a number of passes, and breaks or flex time after **every N** programs.

### Changed

- A local folder's library is listed by its folder name, not the path Tunarr names it after.

## [2026.10.21] - 2026-10-26

### Changed

- **Tunarr 2026.10.4:** Tunarr's dated releases (2026.9 and 2026.10) now count as validated; Compatibility used to call every current Tunarr "not validated" because it only knew 1.x.
- **Movie slots on Tunarr 2026.10.4 and later:** that release removed movie slots (movies go in a custom show, and Tunarr converts existing ones itself). Lineup reads this from Tunarr's API description: the slot editor and programming templates stop offering "Movies", a template's saved "Movies" choice is left for you to pick again, a schedule that still has a movie slot says what to change and offers **Make the custom show in Tunarr** (only when you choose it: the custom shows Tunarr's own upgrade makes, one per play order, from the channel's movies and any you add, with those slots changed to play them and their times, commercials and links kept), and the companion refuses it in plain words instead of passing on Tunarr's error. Compatibility shows Slot schedules as Limited, with why. Older Tunarr keeps movie slots.
- The e2e fake Tunarr can stand in for Tunarr 2026.10.4 (`/__test/release`), with a browser test for movie slots there.

## [2026.10.20] - 2026-10-26

### Added

- **Compatibility** (Setup → Server Settings): Tunarr's version, whether it's one Lineup was validated against, and every capability the desk uses, decided by read-only checks (Tunarr's own API description for saves; live streams are never started to check them). A feature this Tunarr doesn't offer (a route answering "no such route", or a required route missing from its API description, such as channel settings that can be read but not saved) explains itself and its Save is turned off up front; managers are checked action by action (create, edit, delete, scan, refresh, sign in, new and deleted channels), so a missing write turns off just that button, with why, and reading keeps working; a timeout, an error or an API description that fails to load never turns anything off; the rest keeps working. **Export diagnostics** saves the report without Tunarr's address or credentials. Test Connection shows the version too.
- **Control Room** (View → Control Room, `O`): every channel at once (now and next, viewers, guide, scheduled changes, last check), with checks on request that find missing programs, items with no length, bad or looping redirects, breaks from deleted lists, flex time with no filler and guide drift; filters, actions per channel, and an opt-in stream check.
- **Batch operations** (Channel → Batch Operations…): filler settings, group title, transcode profile, numbers (never two channels on one number, and stopped, never overwriting, if Tunarr changes mid-way) and options across channels, previewed per channel, applied channel by channel only where nothing changed since the preview (an apply missing any channel's preview is refused whole, never cut short; swaps pass through a spare number inside 1–99,999, or are refused before anything moves), reported, and rolled back by choice; **Repair Missing Media…** (remove, keep the time as flex, or replace with a library program, checked in Tunarr and saved with Tunarr's length); **programming packages** to export and import lineups.
- **Schedule library and calendar** (File → Save to Schedule Library…, Schedule Library & Calendar…): saved lineups put on channels once, every year or every week, in a chosen time zone, with exceptions, priorities and conflicts checked before saving; each occurrence is planned shortly before it starts and steps aside if the channel was edited, is planned again when the calendar changes before it starts (its name and lead time included; the higher priority always wins), never goes in while the calendar can't be checked (it waits, and a save says so instead of failing), needs a saved snapshot before it goes in if it will restore, and ends by restoring exactly, resuming, or keeping.
- **Advanced planner** (Edit → Advanced Planner…): seeded, weighted rotations between shows, custom shows and picked programs, by airtime or by count, with episode order, season blocks, repeat limits, cooldowns and dayparts (exact to the minute in the chosen zone); the previewed plan is saved exactly, starting at its chosen time, and a plan cut short by the 50,000-program limit is shown as incomplete and can't be saved.
- **Notifications** (Setup → Server Settings): optional messages to one webhook for scheduled changes, refused saves, unhealthy channels, missing media, guide failures and partial batches; HTTPS on port 443 to public addresses (a private-network address, with http or another port, only when allowed and only when it resolves to private addresses alone), the address write-only, and no names unless opted in.
- **Guide preview** (View → Guide Preview (XMLTV)…): the hours ahead as guide apps will list them, checked for holes, overlaps and unreadable entries, with an XMLTV preview to download. Tunarr still serves the real guide.

### Changed

- A Tunarr route that doesn't exist now answers `501 tunarr_unsupported` instead of "not found".
- A manual save may carry a `startTime` (used by the planner).

### Fixed

- A renumbering whose preview included a channel since deleted in Tunarr now moves nothing (it used to renumber the others, so one half of a swap could go in).
- Duplicate Channel is checked on its own (copying needs Tunarr to read and save the copy too), the New Channel dialog turns its button off when “Start from” picks something this Tunarr can't do, and the Lineup server refuses such a channel before writing anything. Duplicate Channel no longer reads transcode profiles; the dialog reads them once, when an empty channel is chosen and allowed.
- Filler-folder pickup no longer calls routes the compatibility check found missing: each step (adding the upload folder, reading a folder, making or refreshing a list) is left out on its own, the rest still runs, and Filler Folders says what was left out. The first pickup after a start waits for the compatibility check (or the one already running) instead of going ahead without it.

## [2026.10.19] - 2026-10-25

### Fixed

- Watch Live on iPhones and iPads: full screen now works (older iPads use the prefixed call, and an iPhone opens the picture in its own video player), and the remote's `−`/`+` mute and unmute there, since those devices set the volume only with their own buttons.
- Turning the volume all the way down now silences the picture.

## [2026.10.18] - 2026-10-25

### Fixed

- The 2026.10.17 Docker image and desktop app weren't built (its lock file didn't match its dependencies). This release has the same changes, plus the updates below.

### Changed

- Updated Vitest (4.1.12), undici (7.30.1) and zod (4.6.7) for security fixes.

## [2026.10.17] - 2026-10-25

### Added

- **Setup wizard.** A fresh Lineup needs no environment variables: open it, type the setup code from the server's log (`docker logs tunarr-lineup`), and the wizard finds Tunarr (or you type its address and test it), asks for a user name and password, and optionally sets up AI, the upload folder and scheduled changes. Everything is kept by the server in `config.json` in its data folder. The desktop app opens the wizard with its code already filled in.
- **Server Settings covers everything.** Tunarr's address, the AI provider, key, model and address, the upload folder and the sign-in can now be changed from **Setup → Server Settings…** while the server runs. Keys and passwords are never shown again.

### Changed

- **Sign-in is always on.** Lineup asks for the user name and password from setup on every device. The password is stored only as a salted hash. The desktop app's own window signs in by itself.
- **Environment variables are read once.** On the first start with this version, `TUNARR_URL`, `LINEUP_PASSWORD`, the `LINEUP_AI_*` and `LINEUP_MEDIA_*` variables and the other settings are copied into `config.json` and ignored after that; the log lists any still set. An install with `TUNARR_URL` and `LINEUP_PASSWORD` keeps working without the wizard; one without a password opens the wizard with Tunarr's address filled in. `HOST`, `PORT` and `LINEUP_DATA_DIR` still come from the environment.
- The AI model moved from the tuning settings to the AI section of Server Settings (a model saved there is moved).
- Updated Next.js (16.4.3), Vite (8.3.5) and the desktop app's Electron (44.9.1).

## [2026.10.16] - 2026-10-24

### Changed

- **Large channels open much faster, especially on phones and remote connections.** The Lineup server now sends only the program details the desk shows, compresses its answers, and lets the browser skip downloading a channel that hasn't changed. A 20,000-item channel goes from 7.8 MB to about 110–210 KB. Long days show 200 rows at a time; arrow keys move through all of them, and **Show earlier/later programs** pages through. The programming answer no longer includes Tunarr's full program metadata or `startTimeOffsets`.
- **The desk opens on the last channel you used**, or the one named in the address (`?channel=<id>`).

### Fixed

- **Loading never gets stuck.** A browser whose saved-draft storage doesn't answer (seen in Safari), a slow companion draft copy, or a stalled connection no longer leaves the desk on "Loading" forever: the lineup shows, drafts restore when they arrive, and every load has a time limit, a **Cancel** button while it runs, and **Try again** after.
- Switching channels quickly cancels the previous channel's download instead of finishing it in the background.
- Rows stay usable while the day's guide is still loading.

## [2026.10.15] - 2026-10-24

### Added

- **Desktop app for macOS, Windows and Linux.** Tunarr Lineup in its own window, with the Lineup server built in: no Docker or Node needed. Set your Tunarr address in **File → Open Settings File…** and choose **File → Restart Lineup Server**. Releases include a `.dmg` for Apple silicon and Intel Macs, a Windows installer and portable `.exe`, and a Linux AppImage and `.deb`. Set `HOST=0.0.0.0` and a password there to use the same desk from a TV, iPad or phone.
- **Android app for phones, tablets and Android TV.** Install `Tunarr-Lineup-<version>-android.apk` from the release, type your Lineup server's address (for example `http://192.168.1.50:3000`) and the desk opens full screen. Works with a TV remote: Back closes what's open, CH± change channel, Menu offers Reload, Change server address and Quit. Exports aren't available in the app yet.
- **Install the desk on iPad, Android and TV browsers.** Add it to the home screen (Safari: Share → Add to Home Screen; Chrome: Install app) and it opens full screen with its own icon. Android installs from an `https` address; plain `http` makes a shortcut.

### Fixed

- **Watch Live fits a phone.** The dialog fills the screen without scrolling: the picture stays on top and a compact remote sits below it, with the number pad beside the arrows and the volume and channel buttons on one line. With the guide open, the guide gets the height and the arrows, Back and CH± stay on screen. Turned sideways, the remote sits beside the picture.

## [2026.10.14] - 2026-10-21

### Fixed

- **Menus open over dialogs.** With Watch Live or any other dialog open, the **File**, **Edit**, **View** and other menus now open on top of it instead of behind it.
- **Close boxes look right in every skin.** The close box drew its × twice, clipped and off-centre. It now shows one centred × that is a little larger and easier to hit. In **Platinum** it stays an empty Mac OS 9 close box, now with a raised bevel.

## [2026.10.13] - 2026-10-20

### Added

- **Appearance: four skins.** **View → Appearance…** (also in the phone Menu sheet) restyles the whole desk, Watch Live, the cable guide and the remote included: **Platinum** (the Mac OS 9 look, still the default and unchanged), **Classic Windows** (a Windows 95/98-style teal desktop, gray 3D chrome and navy title bars), **Modern Studio** (light, neutral, restrained blue) and **Broadcast Console** (a dark control room: cyan selection, amber times, red for on air). Arrows move between them, OK/Enter or Space picks one, and it applies at once. The choice is kept in this browser only, never on the Lineup server or in Tunarr, and is applied before the page paints, so a reload doesn't flash Platinum.

## [2026.10.12] - 2026-10-20

### Fixed

- **Day toolbar fits a narrow lineup.** With the Program Bin open, the search field, program count and the Program Bin and Check buttons no longer break their labels over two lines: the search field shrinks to fit, and the two buttons stay together, wrapping to their own right-aligned row when space runs out.

## [2026.10.11] - 2026-10-20

### Added

- **Program bin: premieres.** At a time… → Add to the lineup: **Just before they start** schedules the programs instead of adding them now: the Lineup server adds them shortly before they start, exactly on time and keeping what's on air in place, so none of them airs earlier, however short the channel's loop. Listed in File → Scheduled Changes. Needs `LINEUP_SCHEDULER=on`.
- **Program bin: Slot schedule….** Puts picked shows into the channel's time-slot schedule at a time on chosen days (each show back to back, in episode order that continues from airing to airing). What was on picks up again after them, linked so it continues too. Opens the slot schedule editor with the result to preview and save.

## [2026.10.10] - 2026-10-20

### Added

- **Program bin: Shuffle shows, episodes in order.** A play order that mixes the picked shows at random (spread evenly) while each show's seasons and episodes stay in order.
- **Program bin: time slots.** **In time slots…** places the picked programs in a recurring slot (a first day, a time, the days of the week), a set number per slot or as many as fit until a time, continuing the order slot after slot. Each slot starts on time; what was airing moves later.

### Changed

- **Program bin: At a time… starts exactly then** by default, with open airtime filling up to it (or, if you choose, when the program airing then ends).
- **Program bin: warns when the spot moves.** On a lineup that has already repeated, adding a long block lengthens every pass that has aired, so the start could land days from the time chosen and that time could show part-way through the block (a show seeming to start on its last season). The tray now says so and suggests **Keep what's on air in place**.

## [2026.10.9] - 2026-10-19

### Added

- **Program bin** (`A`, Edit → Program Bin, or ▦ Program Bin above the lineup): browse the library as posters beside the lineup, pick movies, episodes or whole shows, and set how they air (as picked, in episode order or shuffled; several passes; flex or a commercial break after each program, optionally opened by station IDs). Place them after or before the selection, at the end or at a time; choose the spot with ↑ ↓ and OK; or drag a poster (or everything picked) onto a row of the schedule.

### Fixed

- The picks listed in the library browser are numbered 1, 2, 3… again instead of 0.

## [2026.10.8] - 2026-10-19

### Added

- **Server Settings** (Setup → Server Settings…): change the Lineup server's settings that aren't about security without editing `.env` or restarting: Tunarr timeouts, loading logos from public sites, scheduled changes on or off, the AI model and timeout, and the largest upload. Each shows where its value comes from (.env, saved here, or the default); saved values apply at once, are kept in the data folder (`settings.json`) and win over `.env` until **Use .env value**. The Tunarr address, keys, password, allowed hosts and folders stay in `.env`, and the dialog only says whether each is set.
- **Individual station IDs** (Channel Settings → Commercials): pick single station IDs for a channel, in addition to the IDs named for it and its ticked lists. Insert → Station ID and the break tools use them. An ID picked for a channel is only that channel's, even if its name says otherwise; two channels can share one. Picks are kept by Lineup (`station-ids.json`), so Tunarr doesn't air them in flex time; tick a list for that.

### Fixed

- **Keys always reach what's on screen**: a key pressed the moment a dialog or preview appeared could go to what was there before (Escape closed the slot editor instead of discarding its preview).

## [2026.10.7] - 2026-10-19

### Fixed

- **Watch live keeps playing**: channels no longer loop on "No signal · retrying" in Chrome. Chrome now says it can play live streams itself, but its player dropped Tunarr's channels after a few seconds or refused some outright; Lineup now always uses its own player (hls.js) where it can, and the browser's only on devices that can't run it. Subtitled channels play their subtitles.

## [2026.10.6] - 2026-10-19

### Fixed

- **The desk fits the screen**: on desktop and TV the Programming window now ends above the bottom of the screen, with its bottom edge, shadow and resize box visible, and the channels, lineup and selected program each scroll inside it instead of running off the bottom. Phones still scroll the page.

## [2026.10.5] - 2026-10-19

### Watching like a cable box

- **A sturdier player**: a stream that fails is retried on its own with a growing wait (five tries, with a countdown and **Retry now**); one with no picture after 45 s or stuck buffering for 20 s is restarted; it retries when the network comes back, and plays muted (and says so) when the browser blocks sound.
- **Tuning like a cable box**: CH± (or ↑ ↓) go up and down the dial by number, digits tune directly, `R` / **LAST** goes back, and `I` / **INFO** shows the channel banner with what's on, its progress and what's next. `M` mutes, `+`/`−` change volume, `F` goes full screen. In the player, CH+ and PgUp now go to a higher channel number.
- **A remote beside the picture** with every one of those buttons, for a mouse or touch screen (below the picture on phones).
- **Cable guide** (`G` / **GUIDE** while watching): the on-screen guide of an early-2000s cable box, inside the picture. The channel keeps playing in a corner window beside the focused program's details; below, five channels and ninety minutes at a time. OK tunes.

## [2026.10.4] - 2026-10-19

### Seeing every channel

- **Guide grid** (`G`): every channel and three hours across, from Tunarr's guide, driven by the remote; OK opens a program in the desk. Group by network (group title).
- **Week view** (`W`): the channel's week as blocks, with **week and month program-log exports**.
- **Watch live** (`L`): play a channel in the desk. The stream comes through the companion, which rewrites Tunarr's HLS playlist and refuses anything that points elsewhere. Uploaded filler clips can be played in Filler Folders.
- **Viewer counts** on each channel (counts only).

### Catching mistakes

- **Check Lineup** (`C`, and a badge in the toolbar): missing programs, zero-length items, dead or self redirects, redirect loops, breaks from deleted lists, flex that shows the offline screen, repeats in a day or in a row, commercial minutes over a per-channel limit, mature ratings in family hours. Each jumps to where it airs. **Ask AI for a review** suggests changes (read-only).
- **Align Programs to Clock…**: programs start on :00/:30 (or every 15 or 60 minutes), every pass.

### Programming tools

- **Marathon…**: a season back to back on a date with breaks between episodes.
- **Copy Selection to Channel…**, **Simulcast Selection on Network…**, **Share Commercials With Network…**; the network is Tunarr's group title.
- **Halloween** and **Christmas** templates, meant as seasonal overlays.

### Safety over time

- **Snapshots**: the companion keeps each channel's lineup before every save, reset and scheduled change (last 15) in `LINEUP_DATA_DIR/snapshots`. Restore one as an edit, or export and import a lineup as a file.
- **Drafts follow you**: unsaved work is also kept on the companion (`LINEUP_DATA_DIR/drafts`), so it opens on any device.
- **Scheduled changes** with `LINEUP_SCHEDULER=on` (off by default): **Save Later…**, **Save as Seasonal Overlay…**, and **Air once** for events. Each goes in only if the channel is still as planned; otherwise it's skipped with the reason. **File → Scheduled Changes…** lists and cancels them.

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

[Unreleased]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.23...HEAD
[2026.10.23]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.22...v2026.10.23
[2026.10.22]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.21...v2026.10.22
[2026.10.21]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.20...v2026.10.21
[2026.10.20]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.19...v2026.10.20
[2026.10.19]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.18...v2026.10.19
[2026.10.18]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.17...v2026.10.18
[2026.10.17]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.16...v2026.10.17
[2026.10.16]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.15...v2026.10.16
[2026.10.15]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.14...v2026.10.15
[2026.10.14]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.13...v2026.10.14
[2026.10.13]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.12...v2026.10.13
[2026.10.12]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.11...v2026.10.12
[2026.10.11]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.10...v2026.10.11
[2026.10.10]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.9...v2026.10.10
[2026.10.9]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.8...v2026.10.9
[2026.10.8]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.7...v2026.10.8
[2026.10.7]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.6...v2026.10.7
[2026.10.6]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.5...v2026.10.6
[2026.10.5]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.4...v2026.10.5
[2026.10.4]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.3...v2026.10.4
[2026.10.3]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.2...v2026.10.3
[2026.10.2]: https://github.com/augustosc-eu/tunarr-lineup/compare/v2026.10.1...v2026.10.2
[2026.10.1]: https://github.com/augustosc-eu/tunarr-lineup/releases/tag/v2026.10.1
