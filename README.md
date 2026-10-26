# Tunarr Lineup

A TV-friendly, skinnable programming desk for the channels on your
[Tunarr](https://tunarr.com) server. It looks like classic Mac OS 9 (Platinum)
by default; **View → Appearance…** switches the whole desk to Classic Windows,
Modern Studio or Broadcast Console. Pick a channel and a date, then arrange,
insert and remove programs, build slot schedules, and add commercials and
filler, all saved through Tunarr's own API. It is designed to be driven from a
TV with a remote as well as with a mouse and keyboard.

![The Lineup programming desk at 1920×1080: channel list, the day's schedule with the program on air, and the selected program's inspector](docs/screenshot.png)

## Quick start

You need a running [Tunarr](https://tunarr.com) server. Run the companion next
to it; there is nothing to configure beforehand:

```sh
docker run -d --name tunarr-lineup -p 3000:3000 -v lineup-data:/data \
  ghcr.io/augustosc-eu/tunarr-lineup:latest
docker logs tunarr-lineup    # shows the one-time setup code
```

Open **http://localhost:3000** (or the machine's IP address) and follow the
[setup wizard](#first-start-the-setup-wizard): type the setup code, let it find
Tunarr (or type its address), and choose a user name and password. The image
runs on amd64 and arm64. To run Tunarr and Lineup together,
see [Run with Docker Compose](#run-with-docker-compose-recommended). Prefer an
app? There is a [desktop app](#desktop-app-macos-windows-linux) for macOS,
Windows and Linux, an [Android app](#android-app-phones-tablets-android-tv) for phones, tablets
and Android TV, and the desk [installs to the home screen](#ipad-android-and-tv-browsers-install-to-the-home-screen)
on iPad.

## First start: the setup wizard

Lineup keeps its own settings in `config.json` in its data folder
(`LINEUP_DATA_DIR`, `/data` in Docker), not in environment variables. On the
first start the desk opens a wizard:

1. **Setup code.** The server prints a one-time code in its log (`docker logs
   tunarr-lineup`, or the terminal it runs in). Until setup is done, only someone
   with that code can configure the server, so nobody else on your network can
   claim it. Five wrong codes lock the wizard for a minute.
2. **Tunarr.** Lineup looks in the usual places (`localhost:8000`,
   `tunarr:8000` in Docker Compose, `host.docker.internal:8000`, and the Docker
   host) and lists what answers; or type the address as the Lineup server reaches
   it, then **Test connection**. Only the Lineup server ever uses this address.
3. **Sign-in.** A user name and password (at least 8 characters). Sign-in is
   always on; the password is stored only as a salted scrypt hash.
4. **Extras (optional).** The AI assistant (provider, key, model, address), the
   upload folder, scheduled changes and public logos.

Afterwards the browser asks you to sign in. Change any of it later under
**Setup → Server Settings…**. API keys and passwords are never shown again; a
key you don't retype is kept.

`config.json` is written owner-only (`0600`); keep the data folder private, as
it holds the AI key and Tunarr's address. Delete `config.json` to run the
wizard again.

**Upgrading from environment variables.** On the first start with this
version, `TUNARR_URL`, `LINEUP_PASSWORD`, `LINEUP_USERNAME`, the `LINEUP_AI_*`
and `LINEUP_MEDIA_*` variables, the timeouts, `LINEUP_SCHEDULER` and
`LINEUP_EXTERNAL_LOGOS` are copied into `config.json` (the password as a hash)
and ignored from then on; the log says which. An install that already had
`TUNARR_URL` and `LINEUP_PASSWORD` skips the wizard. One without a password
opens the wizard with Tunarr's address filled in.

## Programming desk features

- **On-air view.** A red line marks the program on air now, timed to the second, and **Now** (or the `N` key) jumps to it.
- **Broadcast timing.** Start times are shown as `HH:MM:SS` and durations as `H:MM:SS`. The header shows the lineup size and cycle length, and the totals row shows airtime per item type for the day.
- **Moving programs:**
  - **Single moves:** ↑ Earlier / ↓ Later, drag and drop, or **Move or swap…**.
  - **Exact placement:** **Move or swap…** can also place the selection at a lineup position, or at the slot nearest a start time, with a preview of the exact resulting start.
  - **Block moves:** Shift-click or Shift+↑/↓ selects a block, which moves as one unit.
- **Remote control.**
  - **Arrows** move between programs. **OK/Enter** picks the selection up; **↑/↓** slide it, OK drops it, and **Back** cancels.
  - **← / →** change the day, and **CH+ / CH−** (or PgUp/PgDn) change the channel.
  - Press `?` for the full list.
- **Appearance.** **View → Appearance…** offers four skins for the whole desk, Watch Live, the cable guide and the remote included: **Platinum** (Mac OS 9, the default), **Classic Windows** (Windows 95/98 style), **Modern Studio** (light and contemporary) and **Broadcast Console** (a dark control room with amber times and red for on air). Arrows move between them and OK/Enter or Space picks one; it applies at once. The choice is kept in this browser's local storage (`tunarr-lineup-skin`), not on the Lineup server, and nothing is sent to Tunarr. A small same-origin script (`public/skin-init.js`) applies it before the page paints, so a reload doesn't flash Platinum first.
- **Phones and tablets.** The desk adapts to the screen. On narrow screens Program Info is a sheet over the lineup with Earlier/Later, Move or swap, Insert and Remove; tap its title bar for the details. On phones, **Menu** opens every menu in one list and the channels are a strip you can swipe.
- **Edit list.** Step-by-step undo and redo (⌘Z / ⇧⌘Z, or Ctrl+Z / Ctrl+Y). Changed rows are marked, and **Revert all** discards every edit.
  - Unsaved work and the edit list are kept per channel in the browser (IndexedDB) and on the Lineup server (`LINEUP_DATA_DIR/drafts`), so work started on the TV opens on a laptop. They survive switching channels, reloading the page and turning the TV off; the newer copy wins.
  - The edit list carries over a save, so a save can be undone and saved again.
  - Channels with unsaved work are marked "unsaved" in the channel list.
- **Slot schedules.** For channels Tunarr generates from a random-slot or time-slot schedule, **Channel → Edit Slot Schedule…** opens the slots.
  - **Random slots:** change the source, weight, cooldown, length and order; reorder, duplicate or remove slots.
  - **Time slots:** change start times and shift every slot at once.
  - **Preview lineup** shows the regenerated lineup in the timeline. **Save schedule** saves it with the preview's random seed and reports any difference from the preview.
- **Safe saving.**
  - **Conflict check:** every save says which version of the channel it was based on (`If-Match`). The companion checks that version and writes while holding a per-channel lock. If the channel changed in the meantime, nothing is saved.
  - **Remaining gap:** this fully closes the gap between Lineup sessions. Against edits made in Tunarr's own UI, it leaves a window of a few milliseconds (Tunarr has no conditional save of its own).
  - **Generated schedules:** channels driven by a slot or time schedule ask for confirmation first.
- **Full lineup editing.** **Edit → Insert…** (or `I`) adds, before or after the selection or at a date and time, on any channel:
  - programs from your libraries: movies, episodes, whole seasons or shows, other videos
  - commercial breaks (flex time filled from filler lists)
  - flex time
  - redirects to another channel

  **Program bin** (`A`, or **▦ Program Bin** above the lineup) shows your library as posters beside the lineup. Pick movies, episodes or whole shows, choose the order (as picked, episode order, shuffle, or shuffle shows with each show's episodes in order), how many passes and what airs after each program (flex or a commercial break, optionally opened by a station ID), then place them after or before the selection, at the end, exactly at a time, or in recurring time slots (say weekdays at 20:00, one episode or as many as fit until 21:00). A **premiere** (At a time… → Just before they start, with scheduled changes on in Server Settings) is added by the Lineup server shortly before it starts, so none of it airs earlier. **Slot schedule…** puts whole shows into the channel's time-slot schedule on chosen days, each airing continuing with the next episode, and opens the slot editor to preview it. Or choose the spot with ↑ ↓ and OK, or drag a poster onto a row of the schedule.

  **Remove** (or `Delete`) takes items out. Flex, breaks and redirects have an adjustable length in the inspector. Every edit is in the edit list and the stored draft. The dialog says when inserted items will air. Because a manual lineup repeats from the channel's start time, a longer lineup moves later passes; tick **Keep what's on air in place** to have the companion move the start time on save so the current pass keeps its times.
- **Guide grid.** **View → Guide Grid** (or `G`) shows every channel down the side and three hours across, like a cable box, from Tunarr's own guide. Arrows move between programs (paging at the edges), OK opens the program in the desk, `L` watches that channel. Tick **By network** to group channels by their group title.
- **Week view and longer logs.** **View → Week View** (`W`) shows the channel's week, Monday to Sunday, as blocks (episodes of a show merged, breaks folded in), projected from the lineup. Export the week or the month as a program log (CSV).
- **Watch live.** **Channel → Watch Live** (`L`, or **▶ Watch live** on the program on air) plays the channel in the desk. The stream comes through the Lineup server, which rewrites Tunarr's HLS playlist so the browser never contacts Tunarr. It works like a cable box: CH± or the digits tune, `R` goes back to the last channel, `I` shows the channel banner, and a remote beside the picture has the same buttons. Dropped streams are retried on their own. `G` opens an early-2000s style cable guide inside the picture, with the channel still playing in a corner window. Uploaded filler clips have a **Play** button in Filler Folders.
- **Control Room.** **View → Control Room** (`O`) shows every channel at once: what's on now and next, viewers, whether Tunarr's guide has it, scheduled changes waiting, and the last health check. **Check all** (or `C` for one channel) reads each channel's programming, three at a time, and reports programs Tunarr no longer has, items with no length, redirects to the channel itself, to a channel that's gone or round a loop, breaks filled from deleted lists, flex time with no filler, and Tunarr's guide disagreeing with a manual lineup. Filter by errors, warnings, watched or scheduled channels; open a channel in the desk, the guide, Watch Live, its lineup check, snapshots or scheduled changes. It refreshes every minute while the page is visible. A stream check (`S`) is opt-in: it asks for the playlist only, never video, though Tunarr starts the channel for a moment to answer.
- **Batch operations.** **Channel → Batch Operations…** changes many channels at once: copy one channel's filler settings, set the group title, the transcode profile, new numbers (never two channels on one number, even for a moment; Tunarr is read again before every move, and a change made there meanwhile stops the renumbering, with the record saying exactly which channels moved), or options (hidden, on demand, subtitles, stream format, guide). Pick channels (all, none, or a network), and the preview shows exactly what changes on each. Applying checks each channel again: one changed since the preview is left alone and reported as a conflict while the others go in, and there is no way to force it. Each channel's old values (or, for lineups, a snapshot) are kept, so **Roll back** puts chosen channels back, again only if they haven't changed since. **Recent batches** keeps the last 30 as a record.
- **Repair missing media.** **Channel → Repair Missing Media…** (or from the Control Room) finds programs Tunarr no longer has on the channels picked, with where and when each airs next. For each, leave it, remove it, keep its time as flex, or replace it with a program from the library (the Lineup server looks the program up in Tunarr and uses Tunarr's length; one Tunarr doesn't have, or whose length changed since the preview, is refused and nothing changes); the preview shows the result per channel, every other item stays exactly as it was, and channels generated from a slot schedule are never given a manual lineup.
- **Programming packages.** **File → Export Programming Package…** saves several channels' lineups as one versioned file (lineup items untouched, program titles only; no addresses, tokens, media paths or settings). **Import Programming Package…** validates it and puts each lineup on the channel you choose, through the same preview, snapshot and conditional save.
- **Guide preview.** **View → Guide Preview (XMLTV)…** lists the next 3–24 hours of a channel as guide apps will show them, from Tunarr's own guide, and checks it: holes and overlaps, entries too short to read, very long ones, untitled ones, and flex time listed under a generic title. **Download XMLTV preview** saves it as an XMLTV file to look at. Tunarr builds and serves the real guide; Lineup doesn't publish one of its own (see `docs/DECISIONS.md`, D69).
- **Who's watching.** The channel list and the guide show how many viewers each channel has right now (from Tunarr's sessions; counts only, never who).
- **Lineup check.** **View → Check Lineup** (`C`, or the ✓/⚠ badge in the toolbar) finds what a broadcaster catches before air, for the day or the next 7 days: programs Tunarr no longer has, items with no length, redirects to channels that are gone or to the channel itself, redirect loops across channels (on request), breaks filled from deleted lists, flex time with no filler (the offline screen), the same episode twice in a day or twice in a row, hours over your commercial limit, and mature ratings in family hours (both set per channel). Each finding jumps to where it airs. With AI set up, **Ask AI for a review** reads the week and the findings and suggests changes; it never edits.
- **Align programs to the clock.** **Edit → Align Programs to Clock…** pads a manual lineup so programs start on the hour, half hour or quarter hour, putting the time into the break before each program (or new padding from your commercial lists), and makes the whole cycle a whole number of steps so every pass lines up. One undoable edit.
- **Marathons.** **Edit → Marathon…** puts a season (or any run of programs) on a date, back to back with a commercial break between episodes, opening each break with a station ID if you like.
- **Across channels.** **Edit → Copy Selection to Channel…** copies the selected block to another channel (at a time, its start or its end); **Edit → Simulcast Selection on Network…** puts a redirect to this channel at the same time on every channel with the same group title (the network); **Channel → Share Commercials With Network…** gives them this channel's commercial settings. Each channel is saved with its own conditional save.
- **Snapshots.** The Lineup server keeps each channel's lineup as it was before every save, reset and scheduled change (the last 15). **File → Snapshots, Export and Import…** restores one into the desk as an edit, takes one now, or exports and imports a lineup as a file.
- **Scheduled changes** (turned on in setup or Server Settings): **File → Save Later…** saves the desk's lineup on a date; **File → Save as Seasonal Overlay…** puts a lineup (your edits, or a slot preview, such as the Halloween and Christmas templates) in on one date and brings the old one back on another; **Schedule Event → Air once** airs an event once and then puts back what it replaced. The Lineup server saves each one when it's due, only if the channel is as it was when planned; otherwise it's skipped and says why. **File → Scheduled Changes…** lists and cancels them.
- **Advanced planner.** **Edit → Advanced Planner…** works out a rotation between shows, custom shows and picked programs for 1 to 31 days: weights that share out airtime or the number of programs, episode order from S01E01 (or a chosen episode), a whole season at a time, or a seeded shuffle; repeat limits and the least time between repeats; dayparts and weekday/weekend rules in a chosen time zone. The preview shows each source's airings, airtime and share against its weight, genres and types, and warns when a source runs out, repeats, or a daypart has nothing to air. Daypart changes are exact to the minute in the chosen zone (clock changes included), and flex never runs into the next daypart. A plan is capped at 50,000 programs: one that reaches the cap before its end says so and can't be saved (plan fewer days, or use longer programs). Save replaces the channel's lineup with exactly what was previewed (the seed is in the message), conditionally and after a snapshot, and moves the channel's start time to the plan's start; or keep it in the schedule library. A plan is fixed: it doesn't follow the library afterwards.
- **Schedule library and calendar.** **File → Save to Schedule Library…** keeps the desk's lineup (or a slot preview) apart from any channel, with a name, description and tags. **File → Schedule Library & Calendar…** puts a saved schedule on channels once (a date or a range), every year (Halloween, Christmas over New Year, May the 4th) or every week, in an explicit time zone, with dates to skip and a priority. It starts as the cycle lands, from its first item, or from a chosen position (continuing an earlier occurrence's progress isn't offered: Tunarr keeps none for a manual lineup), and ends by restoring the old lineup exactly, resuming it where it was interrupted, or keeping the new one. **Check** shows the next occurrences and refuses an overlap with an entry of the same priority on a shared channel before anything is saved. Each occurrence is planned as an ordinary scheduled change a few hours before it starts (with scheduled changes on), against the channel as it is then: an edit after that makes it skip, never force. Adding, editing, turning off or removing an entry re-plans the occurrences that haven't started (a higher priority always wins an overlap; equal priorities that meet anyway go to the older entry), while one already on air is left alone. An occurrence that restores or resumes doesn't go in unless a snapshot of what it replaces has been saved first. Clock changes are handled: a time skipped by the clock moves forward, a repeated one takes the first.
- **Library browser.** Browse or search any media source and library Tunarr has indexed (Plex, Jellyfin, Emby, local folders), and drill into shows and seasons. Libraries of up to 1,000 items are listed in episode order (by the number in each title, whatever its language) and searched by number as you type: "capitulo 2" finds "Chapter 2". Picks are listed before you insert them.
- **Commercials and filler.**
  - **Setup → Filler Folders…** keeps station IDs, commercials, promos and bumpers as video files in folders, and Lineup picks them up by itself: the upload folder (one subfolder per role; upload, move or delete files from the desk), folders you add with a role, and any Tunarr library named for a role ("Commercials", "station-ids"). Each becomes a filler list with its role, and the list follows its folder after every Tunarr scan. See [Filler folders](#filler-folders) for the Docker setup.
  - **Lists → Filler Lists…** creates and edits filler lists (commercials, bumpers, station IDs). **Lists → Station IDs…** and **Commercials…** show them by on-air role, which Lineup keeps for each list. **Lists → Custom Shows…** manages custom shows.
  - Commercial breaks can open with a rotating station ID; **Edit → Open Breaks With Station IDs** adds one to every break. Each channel has its own IDs: name the file for the channel (`EL 7 ID.mp4`), or tick a list in Channel Settings → Commercials → **Station IDs**. **Insert → Station ID** places one of the channel's IDs anywhere, and the ID tools use only that channel's.
  - The day view reads like a station log: breaks, station IDs, spots, flex time and redirects are marked, each hour shows its commercial load, a day strip shows the whole day, and **View → Show Break Rundowns** (`B`) estimates each break's spots.
  - **Channel → Channel Settings…** sets which filler lists play during a channel's flex time (weights and cooldowns), plus the channel's name, number, group, guide flex title and start time.
  - Slots can carry their own commercials: before or after each program, at the start or end of the slot, or as mid-roll breaks inside programs.
- **Slot schedules.**
  - **Channel → Create / Edit Slot Schedule…** builds a random- or time-slot schedule from any source: shows from the library, movies, custom shows, filler lists, smart collections, or redirects to other channels.
  - You can change every schedule setting, convert between random and time slots, add movies to the movie pool, or **Detach to manual lineup**. Tunarr can't remove a schedule from a channel, so removing one (Detach, or Reset and remove schedule) makes a new channel with the same number, name, logo and settings and deletes the old one. The channel gets a new internal Tunarr id, and other channels' redirects to it become off-air time; Lineup names those channels before you confirm.
  - **More** on a slot sets which seasons a show slot plays (all, only some, or all but some), the play direction, and **linked slots**: slots of the same source that share one episode list, so the 8 pm slot picks up where the 6 pm slot stopped. In time-slot schedules a linked slot can instead rerun what the group played.
- **Programming templates.** **Channel → Programming Templates…** starts a schedule from a daypart plan:
  - **General:** general entertainment, kids & cartoons, movie channel, music videos, 24-hour news.
  - **Inspired by mainstream networks:**
    - **Japan:** NHK General, NHK E-tele, Nippon TV, TBS, Fuji TV, TV Asahi, TV Tokyo, MTV Japan, Space Shower TV, MUSIC ON! TV, Music Japan TV
    - **Argentina:** Telefe, El Trece, TV Pública, América, El Nueve, TN
    - **United States:** ABC, CBS, NBC, FOX, The CW, PBS, Univision, Telemundo, ESPN, CNN, HBO, Nickelodeon, Disney Channel, Cartoon Network, Discovery, MTV (classic), VH1 (classic), CMT music, BET Jams, TCM
    - **Canada:** MuchMusic (classic)
    - **Spain:** La 1, La 2, Antena 3, Telecinco, Cuatro, laSexta
    - **United Kingdom:** BBC One, BBC Two, ITV1, Channel 4, Channel 5, The Box, Kerrang! TV
    - **Italy:** Rai 1, Rai 2, Rai 3, Canale 5, Italia 1, Rete 4, La7

    Each follows the network's dayparts, weekday and weekend differences (single weekdays too, such as Monday-night football or Fuji's Monday drama) and its market's commercial pattern. They are styles, not official schedules, and use no logos.
  - **Filling it in:** each role ("Morning news", "Telenovela", "Prime drama"…) takes a show, movies (on Tunarr before 2026.10.4, which moved movies into custom shows), a custom show, an existing smart collection, or a new smart collection the template suggests (with its match count in your library). Choose a commercials list and a promos list. The result opens in the slot editor, for this channel or a new one, to preview and save.
  - **Ad levels per block:** every block is "no commercials", "light", "standard" or "heavy". Light spaces breaks out, heavy brings them closer and makes them longer, and "no commercials" keeps only promos.
- **My templates.** Save your own: **New template**, **Copy and edit…** a built-in one, or **Save this channel's format** (turns a time-slot channel's schedule into a template whose roles are pre-filled with that channel's sources). The editor covers name, day plan (every day, weekdays/Saturday/Sunday, or each day), blocks with ad levels, roles with suggestion genres, start-time grid, lateness and the commercial style. Saved templates live on the Lineup server (`LINEUP_DATA_DIR`), so the TV and every other browser see them.
- **AI programming.** **Ask AI…** in the template gallery writes a template from a prompt ("a 90s Saturday-morning cartoon channel", "program this like Rai 1"). It can use your library's show and movie titles and genres, what the current channel plays, and any template as a starting point. It fills roles with your actual shows and collections where they fit, picks commercial lists, and explains what your library lacks. You can save the result to My templates, edit it, or apply it, and nothing changes until you preview and save. See [AI setup](#ai-setup).
- **Events on a date.** **Edit → Schedule Event…** (or `E`) places a match, premiere or special at a date and time: programs from the library, a simulcast of another channel (a redirect), or off-air time. Tunarr can't cut a program short, so the event starts when the program on air ends (or in its place). **Replace** takes out what would have aired and pads with flex so everything after stays on time; **Push** moves everything later. The preview shows the exact start, what is taken off, and when the lineup repeats (the event repeats with it). On slot-scheduled channels the event lasts until the schedule is regenerated.
- **Smart collections.** **Lists → Smart Collections…** builds saved searches from rules (genre, studio, actor, year, length, added in the last N weeks…), previews how many programs match, and saves them for slots to play.
- **Channels.**
  - **Channel → New Channel… / Duplicate Channel… / Delete Channel…** (delete asks first).
  - **Channel → Reset Channel…** empties the channel's lineup in Tunarr after asking, and keeps the channel and its settings. For a channel with a slot schedule you choose: **Reset and remove schedule** clears both for good, or **Empty lineup only** keeps the schedule, and Tunarr rebuilds the lineup from it at the next library scan or start-time change.
  - **Channel → Channel Settings…** has tabs for General (name, number, group, start time, hidden, on demand), Logo & watermark (logo address, on-screen watermark, offline screen), Streaming (stream format, transcode profile, subtitles) and Commercials.
  - **Logos** show in the channel list and the schedule header. They are loaded by the companion, from Tunarr for uploaded logos or from the public site a logo links to. Channels without a usable logo show their number.
- **Setup.**
  - **Setup → Media Sources…** adds Plex (address and token), Jellyfin or Emby (address, user name and password; Tunarr signs in and keeps only a token) or local folders, turns libraries on or off, refreshes and scans them, and removes sources. Addresses and tokens are sent to Tunarr and never shown again.
  - **Setup → Transcode Profiles…** edits resolution, codecs, bitrates, hardware acceleration, loudness and error screens, and duplicates or deletes profiles.
- **Program log.** **File → Export Program Log…** downloads the visible day as CSV.
- **Artwork** is loaded through the companion, so the browser never contacts Tunarr or your media server.
- **Pull-down menus** (File, Edit, View, Channel, Lists, Setup, Help) work with the mouse, the keyboard, or a remote.

## Architecture

The same React interface (`app/page.tsx`) ships in two ways:

| Target | What it is | Talks to Tunarr? |
| --- | --- | --- |
| **Local companion** (`server/`, `vite.local.config.ts`, `Dockerfile`) | A small Node server that serves the interface **and** a narrow same-origin proxy at `/api/tunarr/*`. Run it next to Tunarr. | Yes. This is the supported way to edit real channels. |
| **Hosted preview** (Vinext on a Cloudflare Workers runtime, `vite.config.ts`) | A static demo you can deploy anywhere Workers run. | No. It runs as a demo/preview only. |

Why two targets: a page served over HTTPS from the internet cannot call a
private Tunarr address such as `http://localhost:8000`,
`http://192.168.1.50:8000` or `http://tunarr:8000`. The browser blocks it as
mixed content, a CORS failure, or a private-network request. A Cloudflare
Worker can't reach your LAN either. The fix is not to weaken browser security
but to put a backend on the same origin as the page, running where Tunarr is
reachable:

```
browser ──▶ http://<host>:3000            (Lineup companion: UI + /api/tunarr/*)
                     │
                     └──▶ Tunarr           (e.g. http://tunarr:8000, server side only)
```

The browser only ever requests the companion's own origin. Tunarr's address is
typed once in the setup wizard and kept by the server in `config.json`; the
companion is the only thing that uses it. It is not part of the client bundle or
the Docker image. The served page also sends a `connect-src 'self'` Content
Security Policy, so the browser could not reach Tunarr directly even by
accident.

### Proxy routes

`{tunarr}` is Tunarr's address from setup.

| Companion route | Tunarr API |
| --- | --- |
| `GET /api/tunarr/health` | `GET {tunarr}/api/channels` (reports reachability and channel count) |
| `GET /api/tunarr/channels` | `GET {tunarr}/api/channels` |
| `GET /api/tunarr/channels/:id/programming` | `GET {tunarr}/api/channels/:id/programming` |
| `POST /api/tunarr/channels/:id/programming` | `POST {tunarr}/api/channels/:id/programming` |
| `GET /api/tunarr/channels/:id/lineup?from=…&to=…` | `GET {tunarr}/api/channels/:id/lineup` |
| `GET /api/tunarr/channels/:id/schedule` | `GET {tunarr}/api/channels/:id/schedule` (slot schedule with show and collection names) |
| `POST /api/tunarr/channels/:id/schedule-preview` | `POST {tunarr}/api/channels/:id/schedule-slots` or `/schedule-time-slots` (generates a lineup; saves nothing) |
| `GET /api/tunarr/media-sources` | `GET {tunarr}/api/media-sources` (ids, names, types and enabled libraries only; addresses and accounts are dropped) |
| `POST /api/tunarr/library/search` | `POST {tunarr}/api/programs/search` (built from `{ mediaSourceId, libraryId?, text?, type?, parentId?, page?, limit? }`) |
| `GET /api/tunarr/programs/:id/descendants` | `GET {tunarr}/api/programs/:id/descendants` (every program in a show or season) |
| `GET`/`POST /api/tunarr/filler-lists`, `PUT`/`DELETE …/:id`, `GET …/:id/programs` | Tunarr's filler-list API |
| `GET`/`POST /api/tunarr/custom-shows`, `PUT`/`DELETE …/:id`, `GET …/:id/programs` | Tunarr's custom-show API (playlist sync settings are preserved on update) |
| `GET /api/tunarr/smart-collections` | `GET {tunarr}/api/smart_collections` |
| `GET`/`PUT /api/tunarr/channels/:id/settings` | `GET`/`PUT {tunarr}/api/channels/:id` (only programming-related fields can change; everything else is kept as Tunarr has it) |
| `GET /api/tunarr/channels/:id/logo?v=…` | The channel's `icon.path`: Tunarr-hosted logos (`/images/…`, whatever host they were saved under) from `{tunarr}`; other logos from their public site through a guarded fetch. `204` when there is no usable logo |
| `POST /api/tunarr/channels/create`, `DELETE /api/tunarr/channels/:id` | `POST {tunarr}/api/channels` (`new` with Tunarr's defaults, or `copy`), `DELETE {tunarr}/api/channels/:id` |
| `GET /api/tunarr/transcode-configs`, `PUT`/`DELETE …/:id`, `POST …/:id/copy` | Tunarr's transcode-config API (edits are an allowlist merged onto Tunarr's copy; the default profile and profiles in use can't be deleted) |
| `GET /api/tunarr/media-sources/manage`, `POST …/add`, `DELETE …/:id`, `POST …/:id/refresh`, `PUT …/:id/libraries/:libraryId`, `POST …/:id/libraries/:libraryId/scan` | Tunarr's media-source API (Jellyfin and Emby sign-in goes through Tunarr's `/api/jellyfin/login` / `/api/emby/login`; addresses, tokens, accounts and folder paths are never returned) |
| `POST /api/tunarr/smart-collections/create`, `POST …/preview`, `GET`/`PUT`/`DELETE …/:id` | Tunarr's smart-collection API and `POST /api/programs/search` for previews (rules are turned into Tunarr's filter by the companion) |
| `GET`/`POST /api/tunarr/templates`, `PUT`/`DELETE …/:id` | Lineup's own saved templates (`LINEUP_DATA_DIR/templates.json`); not Tunarr |
| `GET /api/tunarr/filler-roles`, `PUT`/`DELETE …/:id` | Lineup's own filler-list roles (`LINEUP_DATA_DIR/filler-roles.json`); not Tunarr |
| `GET /api/tunarr/station-ids`, `PUT …/:channelId` | Station IDs picked one by one for each channel (`LINEUP_DATA_DIR/station-ids.json`); not Tunarr |
| `GET /api/tunarr/control-room` | Every channel at a glance: `GET {tunarr}/api/channels`, one `GET {tunarr}/api/guide/channels` for the next three hours (now and next), `GET {tunarr}/api/sessions` (counts only) and Lineup's scheduled changes, plus the last checks. A failed guide or sessions read is reported and the rest still shows |
| `POST /api/tunarr/control-room/check` | `{ channelIds }` (up to 25): each channel's programming and channel document, three at a time, plus one filler-list and one one-minute guide read, turned into findings and kept in memory. A channel that fails is reported as not checked with the reason |
| `GET`/`POST /api/tunarr/schedule-library`, `GET`/`PUT`/`DELETE …/:id` | Lineup's own schedule library (`LINEUP_DATA_DIR/schedule-library.json`): lineups saved apart from any channel, with titles only. Deleting one the calendar uses is refused |
| `GET`/`POST /api/tunarr/calendar`, `POST …/preview`, `PUT`/`DELETE …/:id`, `POST …/:id/end` | Lineup's own calendar (`LINEUP_DATA_DIR/calendar.json`). `preview` checks an entry (next occurrences, conflicts, warnings) without saving; a same-priority overlap is `409 calendar_conflict`. Removing an entry ends what it has on now (its restore, still conditional) and cancels what it planned; `end` brings its restore forward |
| `POST /api/tunarr/batch/preview` | `{ operation, channelIds, params }`: reads each channel (`GET {tunarr}/api/channels/:id`, or its programming for repair and import) and answers what would change on each, with the fingerprint the apply checks against. Writes nothing |
| `POST /api/tunarr/batch/apply` | The previewed batch plus `expect` (each channel's fingerprint, for exactly the channels it names; one missing or invalid refuses the whole apply with nothing written). Starts it in the background (`202`) and records it in `LINEUP_DATA_DIR/batches.json`. Each channel: its lock, a fresh read, the fingerprint check (else conflict), a snapshot for lineups, then `PUT {tunarr}/api/channels/:id` (allowlisted fields merged onto Tunarr's copy) or a manual `POST …/programming`. One batch at a time (`409 batch_running`) |
| `GET /api/tunarr/batches`, `GET …/:id`, `POST …/:id/rollback` | The record (last 30) and selective rollback `{ channelIds }`, each channel only if it is still as the batch left it |
| `POST /api/tunarr/batch/export` | `{ channelIds }` (up to 50): each channel's programming as a versioned programming package |
| `GET /api/tunarr/compatibility`, `POST …/refresh` | What this Tunarr can do for Lineup: its version, whether its API description could be read, and each capability as available, answering unexpectedly, not available, not checked or unknown, with the reason. Read-only checks (`GET {tunarr}/api/version`, `GET {tunarr}/openapi.json`, one small `GET` per capability and one library search for one result), cached 5 minutes; `refresh` checks again. Never names Tunarr's address. Works before Tunarr is set up |
| `GET`/`PUT /api/tunarr/server-settings` | Server settings the desk may change (`LINEUP_DATA_DIR/settings.json`), and whether the others are set; values of addresses, keys and paths are never returned |
| `POST /api/tunarr/filler-lists/from-library` | Builds a filler list from everything Tunarr indexed in one library (`POST {tunarr}/api/programs/search`, then Tunarr's filler-list API) and follows that library from then on |
| `GET /api/tunarr/filler-folders`, `POST …/sync`, `POST …/add` | Automatic pickup: which lists follow which folders; `sync` adds the upload folder to Tunarr, makes lists for folders named for a role and refreshes followed lists after a newer scan; `add` adds a folder on the Tunarr server with a role (`POST {tunarr}/api/media-sources`) |
| `GET /api/tunarr/media-folder`, `PUT`/`DELETE …/:role/:file`, `POST …/:role/:file/move` | Lineup's media folder (chosen in setup): list, upload (raw video bytes, streamed to disk), delete and move files between role folders |
| `GET /api/tunarr/ai`, `POST /api/tunarr/ai/template` | Lineup's AI assistant: status, and a template from `{ prompt, channelId?, includeLibrary, baseTemplate? }`. Reads context from Tunarr (search, lists, channel programming) and calls the configured AI provider |
| `GET /api/tunarr/guide?from=…&to=…` | `GET {tunarr}/api/guide/channels` (every channel, up to 24 hours; reduced to times, titles and one line of detail) |
| `GET /api/tunarr/sessions` | `GET {tunarr}/api/sessions` (viewer and stream counts per channel; addresses and user agents are dropped) |
| `GET /api/tunarr/redirects` | Every channel's programming, for the redirect graph (loops) |
| `GET /api/tunarr/channels/:id/stream.m3u8`, `GET …/hls/:file` | `GET {tunarr}/stream/channels/:id.m3u8?mode=hls` and `/stream/channels/:id/hls/:file`. Playlists are rewritten to point at the companion; one naming anything but this channel's HLS files is refused. Segments only of video/audio types |
| `GET /api/tunarr/media-folder/:role/:file` | Plays a media-folder file back (byte ranges), for previews |
| `GET`/`POST /api/tunarr/channels/:id/snapshots`, `GET`/`DELETE …/:snapshotId` | Lineup's own snapshots (`LINEUP_DATA_DIR/snapshots`); `POST` takes one from Tunarr's current copy |
| `GET /api/tunarr/drafts`, `GET`/`PUT`/`DELETE …/:channelId` | Lineup's own shared drafts (`LINEUP_DATA_DIR/drafts`) |
| `GET`/`POST /api/tunarr/scheduled`, `DELETE …/:id` | Lineup's own scheduled changes (`LINEUP_DATA_DIR/scheduled.json`), saved to Tunarr by the scheduler |
| `POST /api/tunarr/ai/review` | The AI review of a week: `{ channelName, summary, issues }` to the configured provider; returns suggestions only |
| `GET /api/tunarr/programs/:id/artwork/:type` | `GET {tunarr}/api/programs/:id/artwork/:type` (image types only; `:id` must be a UUID; `:type` is `poster`, `thumbnail`, `landscape` or `banner`) |

The proxy is deliberately narrow (`server/tunarrProxy.ts`):

- The upstream origin comes only from the address saved in setup. Nothing in a proxied request can change it; it changes only through the setup routes below.
- Any other path or method is refused (`404 route_not_allowed`, `405 method_not_allowed`).
- Channel IDs must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Unexpected query parameters are rejected.
- `from`/`to` must be ISO 8601 date-times, `to` must be after `from`, and the range is capped at 14 days.
- **Manual saves** must be `application/json` with `{"type":"manual","lineup":[…],"append":false}`, and every item needs a known type and a positive duration. A planned lineup may add `"startTime"` (at most a year ahead, not with `keepOnAir`, not on a slot-scheduled channel): after the save the channel's start time moves there so the plan's first item airs then. Lineup items are forwarded unchanged, so Tunarr's own fields (flex filler config, redirect targets, custom-show and filler references, offsets…) survive.
- **Slot-schedule saves and previews** (`{"type":"random"|"time","schedule":{"settings":{…},"slots":[…]},"seed":[…],"extraPrograms":[…]}`) are validated by the companion.
  - It checks slot types, source ids, play orders, timing, weights, commercials and mid-roll breaks, and the settings allowed for the schedule type.
  - Settings Lineup doesn't edit keep Tunarr's current values.
  - The program pool is computed server-side from programs on the channel plus `extraPrograms`; a `programs` list sent by the browser is ignored.
  - Tunarr's own strict validation still runs.
- **Every save needs `If-Match: "<version>"`,** the version of the channel it was based on. Without it the response is 428; if the channel changed meanwhile, 412 `lineup_changed`.
- Writes from another site are blocked: the `Origin` must match the companion's host.
- Browser cookies, `Authorization` and hop-by-hop headers are never forwarded. Upstream redirects are not followed.
- Timeouts are 10 s for reads and 30 s for saves. Change them under **Setup → Server Settings…**.
- **Large channels.** A channel's programming reaches the browser with its whole lineup untouched but only the program details the desk shows (title, show, season, episode), compressed, and with an ETag so an unchanged channel isn't downloaded again. A 20,000-item channel that Tunarr sends as 7.8 MB arrives as about 110–210 KB. Long days mount 200 rows at a time; the window follows the cursor, and **Show earlier/later programs** moves it. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#loading-large-channels).
- Errors come back as `{"error":{"code","message"}}`. Messages name the Tunarr host but never credentials, and never include stack traces.
- A route this Tunarr doesn't have at all (Tunarr's own "Route … not found") comes back as `501 tunarr_unsupported`, not as "not found", so an older or newer Tunarr is told apart from a missing channel.
- Artwork responses must be an image type (JPEG, PNG, WebP, GIF or AVIF) of at most 8 MB.
- **Logos from public sites** (YouTube, TMDB…) are fetched by the companion only over HTTP(S) on ports 80/443, only when every address the host resolves to is public (no loopback, private, link-local, CGNAT/Tailscale or multicast ranges; the check is pinned to the connection), with at most 3 redirects (each re-checked), an image content type, 4 MB and 8 s. Results are cached in memory for an hour. Turn off **Load logos from public sites** (Server Settings) to stop this; channels then show logos only when Tunarr hosts them.

If Tunarr sits behind a reverse proxy with basic auth, you can put credentials
in Tunarr's address (`http://user:pass@host`). The server sends them as an
`Authorization` header and never shows them to the browser; Server Settings shows
the address without them.

### Setup routes

| Companion route | What it does |
| --- | --- |
| `GET /api/tunarr/setup` | `{ "needed": true/false }`, the only thing it says without the code |
| `POST /api/tunarr/setup/unlock`, `…/detect`, `…/test`, `…/finish` | The wizard. Each needs `{ "code" }`; they answer `409` once setup is done. `detect` asks the fixed places above for `/api/channels`; `test` asks a typed address and, when it answers, adds `compatibility` (its version and how many features are missing, from the same read-only checks as Server Settings); `finish` validates and saves everything |
| `GET`/`PUT /api/tunarr/server-config` | After setup, for the signed-in user: Tunarr's address, AI, the media folder, notifications, and the sign-in (changing it needs the current password). Keys, passwords, Tunarr's credentials and the webhook's path are write-only |
| `POST /api/tunarr/server-config/detect`, `…/test` | The same detection and test, after setup |
| `POST /api/tunarr/server-config/notify-test` | Sends a test notification to the saved webhook and answers how it went (never the address) |

Until setup is done every other route answers `503 setup_required` (uploads
included).

### Live mode vs demo mode

- On load, the interface calls `/api/tunarr/health`.
  - **Connected:** the status reads "Tunarr connected." and your channels load.
  - **Not set up yet:** the setup wizard opens.
  - **Unreachable:** the dialog shows the error and the host it tried.
  - **Hosted preview:** no companion server exists there, so live mode is reported as unavailable.
- Demo data appears only after you choose **Use demo data**. It is labeled "Demo mode" and "Demo channels", and it never reads from or writes to Tunarr. A failed live request never switches to demo data on its own.
- Date navigation uses Tunarr's `/lineup` guide for the requested day. Tunarr only keeps a guide for a window around the current time, and a guide can lag behind recent edits. Outside that window, or when the guide doesn't match the lineup, the day is projected from the lineup and a note says so.
- Saving sends the lineup back as a manual lineup, then re-reads the channel's programming and the visible day from Tunarr.
  - If the channel uses a generated slot or time schedule, Lineup asks for confirmation first. Tunarr keeps the slot schedule, but regenerating it (saving the slot schedule, or changing the channel's start time) replaces the edited lineup.
  - Leaving a channel with unsaved changes asks for confirmation. **Undo changes** restores the last loaded lineup.
- Artwork is fetched through `/api/tunarr/programs/:id/artwork/:type`; demo data uses letter tiles.

### Sign-in

Lineup can rewrite your channels, so it always asks for the user name and
password chosen in the setup wizard (HTTP Basic), for everything except
`/healthz`. Basic auth sends the password with every request, so use it on a
trusted network or behind HTTPS. Change the user name or password under
**Setup → Server Settings… → Sign-in**; it needs the current password, and every
browser then signs in again.

### Host names

Because sign-in is always on after setup, Lineup answers to any host name
(`http://nas.local:3000`, a reverse-proxy domain): the browser only sends the
password to the address you signed in on, which also stops DNS rebinding. During
setup any name works too, since only the setup-code routes answer. A server
started from tests or scripts without `config.json` and without a password
answers only to IP addresses, `localhost` and the names in
`LINEUP_ALLOWED_HOSTS` (comma-separated; `.example.com` also allows its
subdomains).

## Run with Docker Compose (recommended)

```sh
cp docker-compose.example.yml docker-compose.yml
# edit the Tunarr volume path / TZ, or drop the tunarr service if you already run it
docker compose up -d
```

Open **http://localhost:3000**. Tunarr itself stays at http://localhost:8000.

- Run `docker compose logs lineup` for the setup code. The wizard finds Tunarr at `http://tunarr:8000` over the shared `tunarr` network.
- If Tunarr already runs in another compose project, attach the `lineup` service to that project's network and type `http://<Tunarr's service name>:8000` in the wizard.
- The image has a healthcheck (`GET /healthz`).
- The published `chrisbenincasa/tunarr:latest` image is amd64-only. On Apple silicon, add `platform: linux/amd64` to the `tunarr` service.
- Lineup can rewrite channel programming. Publish it as `127.0.0.1:3000:3000` if it should only be reachable from the Docker host.
- Settings (`config.json`), saved templates and the rest are kept in the `lineup-data` named volume (`/data` in the container). Turn on **Ask AI…** in the wizard's extras or under Server Settings.

The compose file uses the published image (`ghcr.io/augustosc-eu/tunarr-lineup`, tags `latest`
or a version such as `2026.10.20`, or `2026.10` for the latest release of that month). To build it from source instead, replace
`image:` with `build: .` on the `lineup` service, or:

```sh
docker build -t tunarr-lineup .
docker run -d --name tunarr-lineup -p 3000:3000 -v lineup-data:/data tunarr-lineup
```

## Desktop app (macOS, Windows, Linux)

The desktop app is the companion and the desk in one window: it runs the Lineup
server on this computer (localhost only) and shows it, so there's no Docker or
Node to install. Download it from the GitHub release:

| System | File |
| --- | --- |
| macOS (Apple silicon / Intel) | `Tunarr-Lineup-<version>-mac-arm64.dmg` / `-mac-x64.dmg` |
| Windows (x64 / ARM) | `Tunarr-Lineup-<version>-win-x64.exe` / `-win-arm64.exe` installer, or `-win-portable.exe` |
| Linux (x64 / ARM) | `.AppImage` or `.deb` for `x86_64`/`amd64` and `arm64` |

On first launch the setup wizard opens with its code already filled in: let it
find Tunarr, choose a user name and password, and you're done. The app's own
window signs in by itself (with a key made for each launch); the password is for
other devices. Lineup's settings (`config.json`), saved templates and other data
live in the app's data folder (**File → Show Data Folder**); the server's output
is under **File → Show Server Log**. An older `lineup.env` with `TUNARR_URL` and
the rest is copied into `config.json` once.

- **Share it with a TV, iPad or phone:** set `HOST=0.0.0.0` and `PORT=3000` in
  the settings file (**File → Open Settings File…**), choose **File → Restart
  Lineup Server**, then open `http://<this computer's address>:3000` on the
  other device and sign in.
- **Scheduled changes** (turned on in the wizard or Server Settings) are saved while the app runs. On
  macOS closing the window keeps the app running; quit it to stop the server.
- **Unsigned builds:** unless the release was signed, macOS says the app can't
  be checked: Control-click it in Finder, choose **Open**, then **Open** again
  (or **System Settings → Privacy & Security → Open Anyway**). Windows
  SmartScreen: **More info → Run anyway**. AppImage: `chmod +x` it first.

To build it yourself (on each OS for its own installers; Linux packages also
build on macOS):

```sh
npm install && npm --prefix desktop install
npm run start:desktop      # build the companion and open it in the desktop shell
npm run build:desktop      # installers for this OS in desktop/release/
npm --prefix desktop run dist -- --linux AppImage   # extra arguments go to electron-builder
```

Publishing a GitHub release builds all three on their own runners
(`.github/workflows/desktop.yml`) and attaches the files to the release. To
build without a release, run **Actions → Desktop → Run workflow** with the tag
left empty; the files are kept as the run's artifacts for 14 days. Signing
uses electron-builder's usual secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, and
`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for macOS notarization).

## Android app (phones, tablets, Android TV)

One APK for Android phones, tablets and Android TV boxes, attached to each
GitHub release as `Tunarr-Lineup-<version>-android.apk`. It's a full-screen
window onto your Lineup server (Docker, Node or a shared desktop app); the
server keeps running there, so scheduled changes don't depend on the tablet.

1. Download the APK on the device (or copy it over) and open it. Android asks
   once to allow installing apps from that source.
2. Type your **Lineup server's** address, the one you'd open in a browser, for
   example `http://192.168.1.50:3000` (not Tunarr's address). Without `http://`
   and a port, port 3000 is assumed. The app checks the server answers first.
3. Sign in once with the user name and password from setup; **Remember on this device** keeps it.

- **Remote and keyboard:** Back works like Escape (closes what's open), CH± step
  channels, and the D-pad and OK drive the desk as in a browser. The remote's
  **Menu** key offers Reload, Change server address and Quit.
- **Change the server later:** long-press the app icon → **Change server**, the
  Menu key, or **Change server address** when it can't connect.
- **Not in the app yet:** exports (CSV, program logs) can't be saved; use a browser for those.
- **Updates** install over the old version when they're signed with the same key
  as the one you have (releases are; builds from forks or without the signing
  secrets aren't).

To build it yourself, install Android Studio (or a JDK 21 and the Android SDK)
and run `./gradlew assembleDebug` in `android/`; the APK lands in
`android/app/build/outputs/apk/debug/`. Releases build it with
`.github/workflows/android.yml`, signed with the keystore in the repository
secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; **Actions → Android → Run
workflow** with no tag builds one without a release.

## iPad, Android and TV browsers (install to the home screen)

The desk is an installable web app: open your companion's address (Docker, Node
or a shared desktop app) and add it to the home screen. It then opens full
screen, with its own icon, like an app; it is still the same desk, talking only
to that companion.

- **iPad / iPhone (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** ⋮ → **Install app** (or **Add to Home screen**).
  Chrome only installs from a secure origin: `https://…` (for example behind a
  reverse proxy or Tailscale Serve) or `localhost`. Over plain
  `http://192.168.…` it adds a shortcut that opens in Chrome instead.
- You sign in once when the installed app opens.

There is no offline mode: the desk needs its companion to reach Tunarr.

## Run locally with Node

Requires Node 22.13 or newer.

```sh
npm install

# Development: Vite dev server with the same /api/tunarr proxy and setup wizard built in
npm run dev:local      # http://localhost:3000; the setup code is printed here

# Production build + server
npm run build:local
npm run start:local    # http://localhost:3000
```

Nothing needs setting: the wizard does the rest. These environment variables
only say where and how the server runs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `LINEUP_DATA_DIR` | `./data` (`/data` in Docker) | Where Lineup keeps its own data: `config.json` (settings from setup), saved templates, filler-list roles, picked station IDs, server settings, snapshots, shared drafts and scheduled changes |
| `LINEUP_ALLOWED_HOSTS` | (none) | Only for a server without sign-in (no `config.json`, tests): extra host names it answers to, e.g. `nas.local,.home.example` (`*` for any) |
| `LINEUP_SETUP_CODE` | (random) | Use this setup code instead of printing a random one (at least 10 letters or digits). The desktop app sets it |
| `STATIC_DIR` | `dist-local` | Directory holding the built interface |
| `LINEUP_COMPRESSION` | `on` | Compress JSON and the interface's files (gzip, or Brotli over HTTPS). Set `off` if a reverse proxy in front already compresses |
| `LINEUP_PROGRAMMING_CACHE_MS` | `0` | Reuse a channel's programming read from Tunarr for this long. `0` reads Tunarr on every load, so changes made in Tunarr's own UI show at once; a few thousand helps a slow Tunarr, but such changes then take that long to appear. Lineup's own saves always show at once |

**Behind a reverse proxy, VPN or tailnet.** Nothing extra is needed: the desk
only calls its own origin. Leave compression on unless the proxy compresses
(nginx `gzip on`, Caddy `encode`), and don't let the proxy buffer or cache
`/api/tunarr/*` beyond what it's told: programming answers are
`Cache-Control: private, no-cache` and carry `Vary: Accept-Encoding`. A proxy
read timeout of at least 60 s covers a large channel over a slow link. The
desk is served from the root path; sub-path installs (`/lineup/`) aren't
supported yet.

**Setup → Server Settings…** changes everything from setup while the server
runs: Tunarr's address (with **Find Tunarr** and **Test connection**), the AI
provider, key, model and address, the media folder, and the sign-in. Below them
are the tuning settings: Tunarr's read and save timeouts, public logos,
scheduled changes, the AI timeout and the largest upload. Tuning values saved
there are kept in `settings.json` and win over the value from setup until you
press **Reset**. Where the server listens, its data folder and allowed host
names are set where it starts; the dialog only says whether each is set.

**Notifications** (in Server Settings, off until an address is saved) send a
small JSON message to one webhook (ntfy, Home Assistant, a chat integration…)
when a scheduled change goes in, is skipped, fails or is missed, a save is
refused because the channel changed, a Control Room check finds errors or
missing media on a channel, Tunarr's guide can't be read, or a batch finishes
with conflicts or failures; each event is chosen separately. The address is
write-only (only its host is shown again) and must be `https://` to a public
address on port 443; ticking **private network** allows private addresses,
and `http://` or another port only when every address the host resolves to is
private (a public destination stays `https://` on 443, and a name resolving to
both public and private addresses is refused), for a local service, but never
this machine, link-local (cloud metadata) or multicast. Every address the host resolves to is checked and pinned to the
connection, redirects aren't followed, and a delivery gives up after 8 seconds
and at most two retries. Messages (schema `tunarr-lineup.notification`,
version 1) carry the event, its severity, a sentence, the channel's id and
number, and counts; channel and change names only when **Include names** is
ticked; never Tunarr's address, error texts, viewers' addresses or programming.
**Send a test** shows how the last delivery went.

**Compatibility** (in Server Settings) shows Tunarr's version, whether it is
one Lineup was validated against (1.x, 2026.9 and 2026.10), and every capability the desk uses
(programming, saving, slot schedules, the guide, viewer counts, lists,
collections, media sources, library search, transcode profiles, channel
settings, live streams) with its state and why. The checks only read: saving
is checked against Tunarr's own API description, never by writing, and live
streams aren't started (they count as checked only while Tunarr is already
streaming). A feature Tunarr doesn't offer is refused in the desk with the
reason; everything else keeps working. "Doesn't offer" needs evidence: a route
answering "no such route", or Tunarr's API description leaving out a route the
feature requires (for example saving channel settings without
`PUT /api/channels/{id}`, even if reading them works); then Save is disabled
before any edit and the missing route is named. Managers are checked action
by action: a Tunarr whose API lists reading filler lists but not deleting them
keeps the Filler Lists window, with **Delete…** turned off and a note saying
why (Compatibility shows it as **Limited** and lists it under "Partly turned
off"); the same goes for creating, editing, copying, scanning, refreshing and
signing in to media servers, and for new, duplicated and deleted channels.
Those writes are only ever checked in the API description, never tried. A
timeout, an error or an API description that fails to load only marks the
feature as **Limited**, and it stays on. **Export diagnostics** downloads the
report as JSON, without Tunarr's address or any credentials, to share when
asking for help.

## Filler folders

**Setup → Filler Folders…** turns folders of video files into filler lists, without a button per list. Lineup checks when the desk opens and every few seconds while the dialog is open (a step this Tunarr doesn't offer, per Setup → Server Settings → Compatibility, is left out and the dialog says so):

- **Tunarr libraries named for a role** ("Commercials", "Station IDs", `/media/promos`, "bumpers"; whole words of the name) get a filler list with that role after their scan. Plex, Jellyfin, Emby and local libraries all count. Other libraries are listed under **Other libraries** with a one-time **Make filler list**.
- **Folders on the Tunarr server** can be added with a role (a path as Tunarr sees it, e.g. `/media/commercials`); their list appears after Tunarr's scan.
- **Followed lists stay in step:** after every Tunarr scan that's newer than the list, its programs are replaced with the folder's. Delete a list in Tunarr and Lineup stops following that folder for good (Make filler list follows it again).
- **The upload folder** lets you add files from the desk. It needs one folder both Lineup and Tunarr can reach, chosen as the media folder in setup or under Server Settings (it must already exist, and can't be Lineup's own data folder). `docker-compose.example.yml` already mounts a `lineup-media` volume at `/media/lineup` in Tunarr and Lineup; choose `/media/lineup`. For an existing compose file, the dialog shows these lines with a **Copy lines** button:

```yaml
services:
  tunarr:
    volumes:
      - lineup-media:/media/lineup
  lineup:
    volumes:
      - lineup-media:/media/lineup
volumes:
  lineup-media:
```

To keep the videos in a host folder you can browse (e.g. `./filler-media:/media/lineup` in both), make it writable by the Lineup container's user first: `sudo chown 1000:1000 filler-media`. If Tunarr sees the folder at a different path than Lineup, fill in **The same folder as Tunarr sees it**.

Lineup creates `station-ids`, `commercials`, `promos`, `bumpers` and `other-filler` inside it and adds them to Tunarr by itself. Uploading starts a scan, and each role's list follows. Uploads never overwrite a file and are written under a temporary name until complete. Anyone signed in to Lineup can upload.

## AI setup

The AI assistant is off until the Lineup server has a provider: choose one in
the wizard's extras or under **Setup → Server Settings… → AI programming
assistant**. The key is kept by the server and never shown again; the browser
never sees the key or the provider's address.

- **Anthropic:** provider Anthropic and an API key (`sk-ant-…`). The model
  defaults to `claude-sonnet-5-5`.
- **A local model with Ollama** (nothing leaves your network): provider
  OpenAI-compatible, address `http://localhost:11434/v1` (or
  `http://ollama:11434/v1` in Compose), model `llama3.1`, no key.

What is sent to the provider with each request:

- your prompt
- your list names (smart collections, custom shows, filler lists)
- if you tick them, your shows' and movies' titles, years, genres and episode counts (up to 600 shows and 300 movies), and the titles the current channel plays

Nothing is sent until you press **Write the schedule**. The reply must match a fixed template schema and is checked like any template: ids that aren't in your library are dropped, and invalid rules are removed. Small local models may need a few tries; larger models follow the schema more reliably.

## Hosted preview (Vinext)

```sh
npm run dev      # vinext dev
npm run build    # vinext build
```

This target has no Tunarr proxy. On load it reports "Live mode unavailable"
and points users to the local companion; sample data appears after choosing
**Use demo data**.

## Checks

```sh
npm run lint
npm run typecheck
npm test            # vitest: proxy, server, lineup logic, and interface behaviour
npm run build       # hosted preview build
npm run build:local # companion build
npm run test:e2e    # Playwright: built companion + fake Tunarr (needs build:local first)
```

For `test:e2e`, run `npx playwright install chromium` once, or set
`PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome. CI
(`.github/workflows/ci.yml`) runs every check above, plus a Docker build and
healthcheck.

Contributor and agent documentation: `AGENTS.md`, `docs/PRODUCT.md`,
`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

Tests live in `tests/`:

- `tunarrProxy.test.ts`: routing, SSRF guards, timeouts, unreachable Tunarr, error normalization, the artwork route, and header stripping over real HTTP.
- `server.test.ts`: static serving, path-traversal guards, CSP, and sign-in.
- `setup.test.ts`: `config.json` (the one-time import, owner-only file, hashed password), the setup code and its lockout, detection, the wizard and server-config routes, and sign-in over HTTP after setup.
- `setupWizard.test.tsx`: the wizard and Server Settings' connection sections through the real setup routes.
- `epg.test.ts`: the guide preview's entries and checks, and a well-formed, escaped XMLTV preview.
- `notify.test.ts`: webhook address rules (public on HTTPS 443 even with the private option; private, with http or other ports, only when allowed and only when every resolved address is private; mixed public/private answers refused; never loopback, link-local, metadata or multicast), URL checks, a pinned lookup, refused redirects, timeouts, capped replies, bounded retries, deduplication, the versioned payload without names unless opted in, and the events from the scheduler, refused saves, batches and the Control Room carrying no Tunarr address or reasons. `setupWizard.test.tsx` covers the Notifications section and `setup.test.ts` the write-only address.
- `planner.test.ts`, `plannerDialog.test.tsx`: the planner's determinism, weights by airtime and by count, episode order and chosen starts, season blocks, repeat limits and cooldowns, dayparts and weekends in a time zone, warnings, 150 generated plans checked for every invariant, a month's plan in under two seconds, saving with a start time (refused with keepOnAir or on a slot-scheduled channel), a plan cut short by the 50,000-program limit (never passed off as complete, refused in the dialog), exact daypart boundaries (08:03, a gap under the minimum flex, a daypart over midnight, another zone, a clock change), and the dialog saving exactly what it previewed.
- `calendar.test.ts`, `calendarDialog.test.tsx`: time zones and clock changes (skipped and repeated hours), yearly, weekly and one-time occurrences (Halloween, Christmas over New Year, May the 4th, 29 February), exceptions, validation (continuing progress refused with why), conflicts and priority, arming against the scheduler (skipped when the channel changed, restore exact vs resume, slot-scheduled channels left alone, outranked occurrences, a restart), re-arming when the calendar changes (a higher priority added at the same time or overlapping in part, a priority changed, the winner turned off or removed, twice without duplicates, an occurrence on air left alone, the tie-break), failing closed when the calendar can't be reconciled (nothing stale applied, the change kept pending and applied once it can be, edits answering `reconciled: false`, the races between an edit and a change going in), the lead time and name invalidating what was armed, the routes, and the dialog through the real routes. `scheduler.test.ts` covers the snapshot an overlay's restore needs (nothing written without it, a missing one reported as failed, a changed channel skipped) and calendar changes held while the calendar can't be checked.
- `batch.test.ts`, `batchDialog.test.tsx`: batch validation (operations, allowlisted fields, duplicate numbers, malformed packages and repairs), previews, partial success with a conflict, applies missing a channel's fingerprint refused with nothing written, Tunarr going down mid-batch, renumbering a swap and a cycle without a transient duplicate (spare numbers always inside 1–99,999, refused before writing when none is free), an outside change before the first move or between moves stopping the rest without overwriting it (with an honest partial record), media repair keeping every other item, replacements checked against Tunarr (a program it doesn't have, a forged length, one gone or changed between preview and apply), export without secrets and import, conditional rollback, one batch at a time, an interrupted batch, an unreadable record file, and the dialog through the real companion routes.
- `controlRoom.test.ts`, `controlRoomDialog.test.tsx`: the health rules (missing programs, lengths, redirects and loops across channels, deleted filler lists, flex with no filler, guide drift claimed only when certain), the summary with a failing guide or sessions, bounded concurrency, one failing channel not stopping the others, the stream check reading only the playlist, and the dialog driven by keys alone.
- `e2e/operations.spec.ts`: Compatibility in Server Settings (diagnostics without secrets, a missing route refusing only its feature), the Control Room by remote at TV and phone sizes, a batch group change with rollback, media repair, a package exported and imported, the schedule library and calendar, the advanced planner, notifications (write-only address, loopback refused, a clean failure), and the guide preview.
- `compatibility.test.ts`: the compatibility matrix (every state from every kind of evidence; a required route missing from the API description makes a readable capability unavailable, a part's route (a manager's create, edit or delete) only turns that part off, a successful read never vouches for writes, a description that fails to load never counts as a missing route, a timeout degraded), versions (validated, not validated, unrecognized, missing), Tunarr without a version route or API description, partial degradation, Tunarr down, no writes and no addresses in the report, caching and refresh, and the diagnostics file.
- `e2e/setup.spec.ts`: setting up a fresh server in the browser by keyboard, then signing in.
- `hardening.test.ts`: host-name checks (DNS rebinding), own-key validation, saved-template size limits, and templates without Tunarr's address.
- `lineup.test.ts`, `broadcast.test.ts`: reorder, block moves, move-to-time, timecode, day totals, CSV, undo history, artwork URLs, and save payload preservation for every lineup item type.
- `page.test.tsx`: live loading, date navigation, reorder → save → re-fetch, conflict detection, remote-key slide, block moves, menus, log export, no silent demo fallback, and the Appearance dialog (skins applied, saved, restored, and working without storage).
- `skins.test.ts`: skin ids and the Platinum fallback, `public/skin-init.js` in a sandbox, and that every skin only overrides tokens Platinum defines.
- `e2e/desk.spec.ts`: the real browser flow at 1920×1080.
- `e2e/responsive.spec.ts`: phone (Menu sheet, Program Info sheet, channel strip), tablet, laptop and ultrawide layouts.

## Releases

See [CHANGELOG.md](CHANGELOG.md). Publishing a GitHub release builds and pushes
the image for amd64 and arm64 (`.github/workflows/release.yml`) and attaches the
desktop apps (`.github/workflows/desktop.yml`) and the Android app
(`.github/workflows/android.yml`). Security
reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Tunarr Lineup is an independent companion for
[Tunarr](https://tunarr.com) and isn't affiliated with the Tunarr project.
