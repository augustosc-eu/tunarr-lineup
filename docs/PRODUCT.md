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

It works only with media Tunarr has already indexed. It can also set Tunarr up
(channels, media sources, transcode profiles; see 4c), show every channel's guide,
play a channel live, check a lineup for problems, keep snapshots, and save changes
on a date. Tunarr's global settings (FFmpeg, HDHomeRun, XMLTV) stay in Tunarr's
own interface.

By default the interface imitates classic Mac OS 9 (the **Platinum** skin):
platinum window chrome, striped title bars, bevelled buttons, Geneva/Charcoal-style
type. The visual identity is deliberate (see `docs/DECISIONS.md`). **View →
Appearance…** offers three other skins for the whole desk (see journey 7a).

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
- **Not set up:** a fresh server opens the setup wizard (D62): the setup code from the server's log, then Tunarr (found in the usual places or typed and tested), a user name and password, and optional AI, upload folder and options. **Use demo data** stays available from its first step.
- **Unreachable:** the dialog shows the error and the Tunarr host it tried. It never shows credentials.
- **Unavailable:** the deployment has no companion, as in the hosted preview. The dialog says live mode needs the companion.

In every non-connected case the user can **Check again** or choose **Use demo data**.

### 2. Browse a channel's day

- **Pick a channel** in the sidebar.
- **Pick a day:** ← / Today / → buttons, or the date picker.
- **Read the timeline:** rows grouped into Morning, Afternoon, Evening and Late night.
  - Each row shows its start as `HH:MM:SS`, artwork (or a letter tile), title, detail, and duration as `H:MM:SS`.
  - The header shows the channel's item count and cycle length; a **day strip** shows the whole day coloured by kind (programs, commercial breaks, station IDs, promos, flex time, redirects) with the on-air point, and totals per kind. Clicking a segment jumps to its row.
  - **Station-log rows:** commercial breaks, flex time, station IDs, commercials, promos, bumpers, filler and redirects each have their own colour, tile and badge (BREAK, FLEX, ID, SPOT, PROMO…), so open airtime is never mistaken for a program. Spots are recognised by the filler list they belong to and its role.
  - **Hour lines:** each clock hour opens with a summary: programs, commercials, IDs and flex time in that hour, and its total commercial minutes.
  - **Break rundowns:** **View → Show Break Rundowns** (or `B`) lists under each break the spots that could fill it, an ID first when the break has one, and any time left as flex. It is labeled as an estimate: Tunarr picks the spots when the break airs.
- **See what's on air:** on today's schedule, the program airing now is marked **ON AIR** with a red line at the current second, and the view opens scrolled to it. **Now** (or `N`) jumps there from any day.
- **Search** filters the visible day.
- **Selecting a row** shows the inspector with type, title, detail, start, end, lineup position (`#k of N`) and, when on air, the time left.
- **A yellow note** explains when times come from projection instead of Tunarr's guide: outside the guide window, guide not loaded, guide stale, or unsaved changes.
- **Guide-only rows** that Tunarr's guide contains but the lineup does not (slot filler, padding flex) can't be selected, but keep their kind and title, so slot commercials and flex time show where they air.

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
  - **Programs from the library:** browse a media source and library, search, open a show or season, then add single items or **Add all**. Picks collect in a basket that lists each one (with × to take it out); **Insert N** adds them in order, and the edit list names them.
  - **Order and search:** a library or folder of up to 1,000 items is listed whole, in **episode number** order when most titles carry a number (the first number in the title, so "Capítulo 2" and "Chapter 2" are both episode 2), otherwise by title in natural order (2 before 10). **Order** switches between episode number, title and release date. Search filters as you type, ignores accents, and matches numbers to the title's numbers: "capitulo 2" finds "Chapter 2 - …" but not "Capítulo 20". Bigger libraries page through Tunarr's own search.
  - **Commercial break:** flex time of a set length, filled from chosen filler lists, with an optional repeat cooldown.
  - **Flex time** or a **redirect** to another channel, of a set length.
- **Program bin** (`A`, Edit → Program Bin, or **▦ Program Bin** above the lineup; live mode only): the library as posters, docked beside the lineup while the channel list and Program Info step aside.
  - **Browse:** media source, library and search as in the library browser; OK on a show or season opens it, and the path goes back up. Cards show Tunarr's poster (stills for episodes), or the title's initial.
  - **Pick:** OK on a movie or episode picks it; **+ All** (or Space) picks everything in a show, season or album; **Pick all** picks the folder you're in. Picks are numbered on their cards and listed in the tray, where × takes one out. A program picked twice (say, a season and one of its episodes) airs once per pass.
  - **Set how they air:** order (as picked, episode order with each show kept together, shuffle, or **shuffle shows, episodes in order**: shows mixed at random, spread evenly, while each show plays its seasons and episodes in order), passes (1–20, a shuffle reshuffled each pass), and what airs after each program: nothing, flex time, or a commercial break of a set length from the lists tagged Commercials, optionally opened by the channel's station IDs in rotation.
  - **Place:** after or before the selection, at the end of the lineup, or at a date and time; the tray says when they start and end, and offers **Keep what's on air in place**. **At a time…** starts them exactly then by default: the program airing then moves after them and open airtime fills the gap (or choose to start when that program ends).
  - **In time slots…:** a first day, a time and the days of the week (say weekdays at 20:00). Each slot airs a set number of programs, or as many as fit until a time, continuing the order slot after slot. Each slot starts on time: what airs then moves later, with open airtime filling up to the slot. A manual lineup repeats, so slots keep their time only within one pass: placing stops where the lineup repeats (or, on a lineup that has repeated, after the first slot unless **Keep what's on air in place** is ticked), and the tray says how many didn't fit.
  - **Premiere:** with **At a time…**, **Add to the lineup: Just before they start** schedules them instead of adding them now. The Lineup server adds them shortly before the program they follow starts, exactly on time with open airtime filling the gap, keeping what's on air in place, so none of them airs earlier however short the lineup's loop. They're listed in **File → Scheduled Changes** until then. Needs scheduled changes on (setup or Server Settings), a manual lineup and no unsaved edits. Later, when the lineup comes round again, they repeat like anything else in it.
  - **Slot schedule…:** whole shows (picked with **+ All**) go into the channel's time-slot schedule: a start time, minutes for each show (several shows go back to back) and the days. Episodes play in order, each airing continuing where the last stopped (or shuffled). Slots that started inside the new window are replaced; what was on when it ends picks up again there, linked so a show carries on with its next episode. Choosing only some days makes a daily schedule weekly. A manual channel gets a new time-slot schedule (replacing its lineup) with open airtime around the shows; a random schedule must be converted to time slots first. The slot schedule editor opens with the result, to preview and save as usual.
  - **When the spot moves:** adding programs to a lineup that has already repeated lengthens every pass that has aired, so the spot chosen can move by days, and what airs at the chosen time may be part-way through the new programs. The tray warns when the start lands more than an hour from the spot chosen and suggests **Keep what's on air in place**. **Choose spot on schedule…** hands them to the lineup: ↑ ↓ choose the row, OK places them, Back cancels. Or **drag** any card, or the picked set by its ⠿ handle, onto a row: the top half of a row drops before it, the bottom half after. A dragged show loads as it moves.
  - Placing is one step in the edit list, saved like any insert. Back goes up a folder, then closes the bin.
- **Remove** (`Delete`, Edit menu, inspector) takes the selection out of the lineup.
- **Length:** flex time, commercial breaks and redirects show a length editor in the inspector.
- **Saving:** inserted items are kept in the draft with their titles, and saved like any other edit. Tunarr validates that every program exists.

### 4b. Filler lists, custom shows and channel commercials

- **Lists → Filler Lists… / Custom Shows…:** create, rename, delete, and add or remove programs (custom shows can also be reordered). Filler lists are where commercials, bumpers and station IDs live. A filler list needs at least one program. Custom shows synced from a Plex playlist keep their sync.
- **Setup → Filler Folders…** keeps filler as video files in folders, one per role (Station IDs, Commercials, Promos, Bumpers, Other), and picks them up by itself. Files can be uploaded into Lineup's media folder (when a media folder is chosen in setup or Server Settings; the Docker compose example mounts one at `/media/lineup`, and when it's off the dialog shows the compose lines to copy), moved between roles and deleted there; folders on the Tunarr server can be added with a role; and any Tunarr library named for a role ("Commercials", "station-ids") is found on its own. Each becomes a filler list with that role, and the list follows its folder after every Tunarr scan. A list deleted in Tunarr isn't made again.
- **Lists → Station IDs… / Commercials…** open the filler lists filtered by **on-air role** (Station IDs, Commercials, Promos, Bumpers, Other). Each list's role is kept by Lineup, not Tunarr, and is saved as soon as it's chosen; untagged lists show a guess from their name. Spots show broadcast lengths (`:10`, `:30`) and each list a length mix ("4 × :30").
- **Station IDs open commercial breaks.** Inserting a commercial break offers **Open with a station ID** (on when a station-ID list exists): the next ID in rotation airs first and its length comes out of the break. **Edit → Open Breaks With Station IDs** does the same for every break in the lineup that lacks one, as one undoable edit. In slots, **Add station IDs to breaks** adds the ID list before each program.
- **Each channel has its own station IDs.** An ID named for a channel belongs to it: "EL 7 ID.mp4" is El 7's, "EL109 ID B" is El 109's (the channel's whole name, word for word; letters and numbers may run together; the longest matching name wins). Channel Settings → Commercials → **Station IDs** can also give a channel whole lists (minus IDs named for other channels); a ticked list joins the channel's filler in Tunarr, which airs it in flex time. Below that, **Individual station IDs** picks single IDs for the channel (kept by Lineup, not Tunarr, so Tunarr doesn't air them in flex time); an ID picked for a channel is only that channel's, even if its name says otherwise, and two channels can share one. On a channel, **Insert → Station ID** lists its IDs to place one anywhere, and the ID tools (Open with a station ID, Open Breaks With Station IDs) use only them. A channel with none uses the IDs named for no channel, never another channel's.
- **Flex time** is Tunarr's: airtime the lineup leaves open (flex items, slot padding, breaks). Tunarr fills it from the channel's filler lists, or shows the offline screen; the day view marks it as FLEX.
- **Channel → Channel Settings…** (tabs):
  - **General:** name, number, group, guide title for flex time, minimum guide entry length, lineup start time (shifts the whole schedule, with a warning), hidden channel, on demand.
  - **Logo & watermark:** logo address and corner, on-screen watermark (image, corner, size, margins, opacity, duration), and the offline screen.
  - **Streaming:** stream format, transcode profile, subtitles.
  - **Commercials:** filler lists that play during flex time (weight, share and cooldown), a repeat cooldown, and whether to hide the watermark during filler.
- **Lists → Smart Collections…:** saved searches built from rules (genre, type, rating, studio, people, tags, titles, audio language, year, length, season number, added or released in the last N days/weeks/months/years), match all or any, optional keywords, with a preview of how many programs match.

### 4c. Channels and Tunarr setup

- **Channel → New Channel… / Duplicate Channel…:** name, number (next free one by default), group, and the transcode profile (new) or the channel to copy (duplicate). Lineup switches to the new channel.
- **Channel → Delete Channel…:** asks first, then removes the channel from Tunarr and moves to a neighbouring channel.
- **Channel → Reset Channel…:** asks first, then saves an empty lineup: every program, break, flex and redirect goes, and the channel's name, number, logo and settings stay. Unsaved edits and the edit list for the channel are dropped. Disabled when the lineup is already empty. On a channel with a slot schedule there are two choices:
  - **Reset and remove schedule** clears both for good. Tunarr can't remove a schedule from a channel, so Lineup makes a new channel with the same number, name, logo and settings and deletes the old one. Its internal Tunarr id changes, and the dialog names any channels that redirect to it, because Tunarr turns those redirects into off-air time.
  - **Empty lineup only** keeps the channel and its schedule. Tunarr rebuilds the lineup from the schedule at its next library scan or start-time change.
- **Setup → Media Sources…:** add Plex (address and token), Jellyfin or Emby (address, user name and password; Tunarr signs in), or local folders; turn libraries on or off, refresh and scan them; remove sources. Addresses, tokens and folder paths are never shown back.
- **Setup → Server Settings… → Compatibility:** Tunarr's version (with a warning when it isn't one Lineup was validated against, 1.x, or when Tunarr doesn't say), the connection, and each capability the desk uses: available, answering unexpectedly, not available, not checked, or unknown, each with the reason. The checks only read Tunarr; saving is checked against Tunarr's own API description, and live streams are never started to check them. **Check again** re-runs them (otherwise they're kept 5 minutes); **Export diagnostics** saves the report as JSON without Tunarr's address or credentials. **Test connection** in setup and Server Settings also shows the version and how many features would be missing.
- **Setup → Server Settings… → Notifications:** off until a webhook address is saved. Choose the events (a scheduled change went in, was skipped, failed or was missed; a save was refused because the channel changed; a Control Room check found errors; a channel plays programs Tunarr no longer has; the guide couldn't be read; a batch finished with conflicts or failures). The address must be `https://` to a public address on the standard port, unless **private network** is ticked (then private addresses work, and `http://` or another port too as long as the host resolves to private addresses only; a public one stays `https://` on 443; never this machine or link-local); it's never shown again, only its host. Messages are small JSON with the event, a sentence, the channel's number and counts; names only with **Include names**. **Send a test** reports how it went; recent deliveries are listed.
- **Features Tunarr doesn't offer fail closed:** choosing one (from a menu or its key) shows why instead of opening it; only that feature is refused. A check that failed, or that couldn't be made, refuses nothing.
- **Setup → Server Settings…:** everything from setup, applied at once: Tunarr's address (with **Find Tunarr** and **Test connection**), the AI provider, key, model and address, the upload folder, and the sign-in (needs the current password). Keys and passwords are never shown, only whether they're set. Below, the tuning settings (Tunarr timeouts, public logos, scheduled changes, the AI timeout, the largest upload) with where each value comes from (setup, saved here, or the default); saved values win until **Reset**. Where the server listens, its data folder and allowed host names only show as set or not.
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
   - **Movie pool:** movie slots draw from the channel's movies (Tunarr 2026.10.4 removed movie slots: there, "Movies" isn't offered, and a movie slot left in a schedule is refused with what to do: put the movies in a custom show. The editor offers **Make the custom show in Tunarr**, which, only when chosen, makes the custom shows Tunarr's own upgrade would, one per play order, from the channel's movies plus any added with **Add movies…**, and changes those slots to play them, keeping their times, commercials, links and weights; the schedule is then previewed and saved as usual); **Add movies…** adds more from the library. They're used on save; Tunarr's preview only uses movies already on the channel.

   Problems Tunarr would reject (overlapping start times, negative weights, linked slots with different sources or orders) are flagged per slot.
3. **Preview lineup** regenerates the lineup in Tunarr without saving and shows it in the timeline, with a pinned preview bar. Browse any day, then **Save schedule**, **Edit slots** or **Discard preview** (also Back).
4. **Save schedule** uses the preview's random seed and reports whether Tunarr's saved result matches the preview. The lineup's edit list starts fresh, because the lineup was regenerated.

**Detach to manual lineup** keeps today's lineup as a manual lineup and drops
the schedule. Tunarr can't remove a schedule from a channel, so this recreates
the channel with the same number, name, logo and settings (a new internal id),
and first names any channels that redirect to it.

### 5a. See every channel, the week, and what's playing

- **Guide grid** (View → Guide Grid, `G`): every channel down the side, three hours across, from Tunarr's guide. ← → move between programs (paging the window at its edges), ↑ ↓ change channel, PgUp/PgDn page channels, `N` goes to now, OK opens the program in the desk, `L` watches the channel, Back closes. **By network** groups channels by group title.
- **Week view** (View → Week View, `W`): Monday to Sunday as blocks, projected from the lineup (including unsaved changes and slot previews). ← → change day (and week at the edges), ↑ ↓ move through a day, PgUp/PgDn change week, OK opens that day in the desk. **Export week log…** and **Export month log…** download CSV.
- **Watch live** (Channel → Watch Live, `L`, or **▶ Watch live** on the program on air): the channel's stream in a player, through the companion, run like a cable box. It counts as a viewer in Tunarr.
  - **Tuning:** CH± (PgUp/PgDn, or ↑ ↓) go up and down the dial by number, wrapping round. Digits tune directly (they wait briefly for another digit only while a longer number could still match). `R` / **LAST** goes back to the previous channel.
  - **The banner** shows on every tune and with `I` / **INFO**: number, name, viewers, what's on with its progress, and what's next. OK shows or hides it too.
  - **Sound and screen:** `M` mutes, `+`/`−` change volume, Space plays/pauses, `F` (or a double-click) goes full screen. iPhones and iPads set the level only with their own buttons, so there `−` mutes and `+` turns the sound back on; an iPhone goes full screen in its own video player.
  - **Keeping it playing:** a stream that fails is retried with a growing wait (five tries), one with no picture after 45 s or stuck buffering for 20 s is restarted, and it retries straight away when the network comes back. If the browser blocks sound, it plays muted and says so.
  - **The remote** beside the picture has every button above, for a mouse or touch screen; below the picture on phones.
  - **The cable guide** (`G` / **GUIDE**): the on-screen guide of an early-2000s cable box, inside the picture. The picture keeps playing in a window at the top right, beside the focused program's details; below, five channels at a time and ninety minutes across. ← → move between programs and page the time (forward only, about half a day), ↑ ↓ move between channels, PgUp/PgDn or CH± page them, digits jump to a channel, OK tunes, Back closes it.
- **Viewer counts**: a red badge on each channel with viewers (rail and guide), refreshed every 30 seconds while the desk is visible.

### 5a′. Control Room

**View → Control Room** (`O`): every channel in one list, for running a whole station.

- **Each channel:** number and name, what's on now (with minutes left) and next from Tunarr's guide, viewers, scheduled changes waiting, and the last health check with its time. The status is **Not checked** until the channel is checked; it's never called healthy without a check.
- **Checks:** **Check all** (or `A` for the channels shown, `C` for one) reads each channel's programming, three at a time, and finds programs Tunarr no longer has, items with no length, redirects to the channel itself, to a channel that's gone or round a loop across channels, breaks filled from deleted filler lists, flex time with no filler (the offline screen), and Tunarr's guide showing a different program than a manual lineup has on air. One channel failing doesn't stop the others; it says why. Checks are kept until the Lineup server restarts.
- **Guide:** a channel with nothing in Tunarr's guide for the next three hours is a warning. If the guide or viewer counts can't be read, the list still shows and says which part is missing.
- **Stream check** (`S`, opt-in): asks for the channel's playlist, never video. Tunarr starts the channel for a moment to answer, so it only runs when asked.
- **Filters:** all, errors, warnings, watched, scheduled (`F` cycles them).
- **Actions** (OK or →): open the channel in the desk, the guide grid, Watch Live, its lineup check, snapshots, scheduled changes, check it, check its stream. Back steps out of the actions, then closes.
- It refreshes every minute while the page is visible, and not at all while it's hidden.

### 5a″. Guide preview

**View → Guide Preview (XMLTV)…**: pick a channel and 3, 6, 12 or 24 hours. It lists them as a guide app would (start, end, title, sub-title, category), from Tunarr's own guide, and checks them: time with nothing listed, entries that overlap, entries too short to read (under the channel's minimum guide entry), entries over six hours, untitled entries, and flex time listed under the channel's name (set a guide title for flex in Channel Settings). **Download XMLTV preview** saves the listing as XMLTV to inspect. It's a preview: Tunarr builds and serves the guide guide apps read, and Lineup doesn't change it.

### 5b. Check the lineup

**View → Check Lineup** (`C`, or the toolbar badge, which counts the day's problems and warnings): problems, warnings and notes for this day or 7 days. Each jumps to where it airs and selects the item. It finds:
- programs Tunarr no longer has; items with no length (left out on save)
- redirects to a channel that's gone or to the channel itself; redirect loops across channels (**Check redirect loops** reads every channel)
- commercial breaks filled from a deleted filler list; flex time on a channel with no filler lists (the offline screen); flex over 30 minutes in one stretch (a note)
- the same episode more than once in a day, and the same program twice in a row (breaks and IDs between don't count)
- clock hours over the commercial limit (default 18 minutes, per channel, can be turned off)
- mature ratings (TV-MA, R…, editable) inside family hours, when turned on for the channel

With AI set up, **Ask AI for a review** sends the next 7 days and the findings to the AI and shows its summary and suggestions. It changes nothing.

### 5c. Align, marathons, and other channels

- **Edit → Align Programs to Clock…**: pads the lineup so programs (longer than a set length) start every 15, 30 or 60 minutes, lengthening the break or flex before them or adding padding from chosen commercial lists, and pads the end so every pass lines up. One undoable edit; "Keep what's on air in place" applies as for inserts.
- **Edit → Marathon…**: a season or any run of programs on a date, with a break of N minutes between episodes (from chosen lists, optionally opening with a station ID). It's placed like an event (replace or push) and repeats with the lineup.
- **Edit → Copy Selection to Channel…**: the selected block, items unchanged, into another channel at a date and time, its start or its end, saved to that channel at once with its own version check.
- **Edit → Simulcast Selection on Network…**: each picked channel with the same group title gets a redirect to this channel for the block's length at its air time (replacing what it would air; a channel joins when its program on air ends).
- **Channel → Share Commercials With Network…**: gives the picked channels this channel's filler lists, repeat cooldown and watermark setting.

### 5d. Snapshots and files

**File → Snapshots, Export and Import…** lists the snapshots the companion took before each save, reset and scheduled change (newest first, 15 per channel). **Restore…** loads one into the desk as an edit; nothing reaches Tunarr until it's saved. **Take a snapshot now**, **Export to a file** (the lineup on screen, as JSON) and **Import a file…** (also loaded as an edit).

### 5d′. Batch operations, media repair and packages

**Channel → Batch Operations…** (also **Repair Missing Media…**, and **File → Export / Import Programming Package…**):

1. **What to do:** copy filler settings from a channel; change the group title; change the transcode profile; renumber channels; change options (hidden, on demand, subtitles, stream format, guide title for flex, minimum guide entry); repair missing media; export or import a programming package.
2. **Channels:** tick them, or **All**, **None**, or a network (group title). Channels with unsaved desk work are marked when a batch would change their lineup.
3. **Preview:** each channel says **Will change** (with every field's before → after, or the lineup's items and length before → after), **No change**, or **Blocked** with why (a number another channel keeps, a channel generated from a slot schedule, a channel Tunarr no longer has). Nothing is saved yet.
4. **Apply…** asks once more, then saves channel by channel. Each channel is read again first: if it changed since the preview it's left alone and reported as a **Conflict**, and the rest still go in. There is no way to force a conflict. If Tunarr stops answering, the channels not reached are **Not tried**.
5. **Report:** every channel's outcome and why. Tick channels and **Roll back** to put them back as they were, each only if it hasn't changed since the batch.
6. **Recent batches** lists the last 30 with their outcomes, and reopens any of them to roll back.

- **Renumbering** never puts two channels on the same number, even in the middle (a swap goes through a spare number). It goes in as a whole: if any of its channels changed since the preview, nothing moves. Tunarr is read again before every move; if someone changes a number there meanwhile, the rest stops (their change is never overwritten), and the report says which channels moved, which was left on a spare number (roll it back or fix it by hand) and which weren't tried. **Number them in order** fills consecutive numbers from a start.
- **Repair missing media:** the preview lists every program Tunarr no longer has on the channels picked, where it is (`#position` on each channel) and when it airs next. For each choose **Leave it**, **Remove**, **Flex (keep times)** or **Replace…** with a program from the library (the Lineup server looks it up in Tunarr and uses Tunarr's length; one Tunarr doesn't have is refused, and one that disappears or changes length before applying leaves the channel untouched); **Update preview** shows the result, and applying is only possible once the preview matches the choices. A snapshot of each lineup is kept first.
- **Packages:** a versioned JSON file of lineups (items exactly as in Tunarr, with program titles; no addresses, tokens, media paths or settings). Importing reads and checks the file in the browser, maps each lineup onto a channel (same id, else same number, by default), and goes through the same preview and apply. Tunarr refuses programs it doesn't index.

### 5d″. Advanced planner

**Edit → Advanced Planner…** (live, on the channel open in the desk):

- **Sources:** shows (all their episodes), picked programs, custom shows. Each has a **weight**, an **order** (episode order, a whole season at a time, or shuffled by the seed), where to **start** (S01E01 by default, or a season and episode), how many times a program may **air at most**, and the **hours before a repeat**.
- **Weights share out** airtime (a weight of 2 gets twice the hours) or programs (twice the airings, whatever their length). Shows alternate while each keeps its own episode order.
- **Dayparts:** parts of the day, on every day, weekdays or weekends, each with its own weights (0 keeps a source out), read in the plan's time zone.
- **Plan:** a start, 1–31 days, a zone and a **seed**. The same seed always gives the same plan; **New seed** tries another.
- **Preview:** each source's airings, airtime and share next to its weight's share; airtime by genre and type; warnings when a source runs out (repeat limit), goes round more than once, or a daypart has nothing to air (flex time); the airings themselves. Dayparts change at their exact minute in the plan's zone, clock changes included, and flex never runs into the next daypart (a gap shorter than five minutes before one is filled only up to it). A plan holds at most 50,000 programs: one that reaches that before its last day says **This plan is incomplete and can't be saved**, with where it stopped, and both saves are off.
- **Save to CH n…** replaces the channel's whole lineup with exactly what was previewed (nothing is worked out again) and moves its start time to the plan's start; it's a conditional save with a snapshot, refused with unsaved desk edits or on a slot-scheduled channel. **Save to the schedule library** keeps it for the calendar instead.
- A plan is a fixed lineup: it doesn't change when the library does. Plan again to include new episodes.

### 5e. Changes on a date

With scheduled changes on (setup or Server Settings):
- **File → Save Later…**: the desk's lineup (or a slot preview) is saved on a date and time.
- **File → Save as Seasonal Overlay…**: it goes in on one date, and the lineup it replaced comes back on another. The **Halloween** and **Christmas** templates are made for this: apply, preview, then save as an overlay.
- **Premiere** (program bin, **At a time…** → **Just before they start**): the programs go in shortly before they start, at whatever spot in the lineup airs then, keeping what's on air in place. Skipped if the channel runs on a slot schedule by then, or if it couldn't go in before it starts.
- **Schedule Event → Air once**: the event goes in shortly before it starts and what it replaced comes back when it ends. Only for "Replace what was on", and only when the desk has no unsaved edits.
- **File → Scheduled Changes…** lists waiting and recent changes on every channel, with why any was skipped, and cancels them.
- **File → Save to Schedule Library…** keeps the desk's lineup (or a slot preview) by name, with a description and tags, apart from any channel. **File → Schedule Library & Calendar…** lists them and the calendar:
  - **Repeat:** once (a date, or a date range, or from a date and kept), every year (start and end month, day and time; it may run past New Year), or every week (days and times; an end earlier than the start runs past midnight). Always in a chosen time zone. A date skipped by the clock (the hour clocks jump) moves forward; a repeated hour takes the first. 29 February falls on the 28th in other years.
  - **Skip dates**, **channels**, and a **priority**: two entries overlapping on a channel at the same priority can't be saved; otherwise the higher priority wins there and the other is skipped on that channel, even if the other was planned first. Adding, editing (its name and how early it's planned included), turning off or removing an entry plans again every occurrence that hasn't started (one already on air carries on unchanged). If equal priorities meet anyway, the older entry wins. If the Lineup server can't check what was planned against the calendar (its files can't be read or written), nothing from the calendar goes in until it can, and a save says so instead of failing, so it's never saved twice.
  - **How it starts:** as the cycle lands (like Save Later), from its first item at the start time, or from a chosen position. Continuing where the last occurrence stopped isn't offered (shown, with why): Tunarr keeps no episode progress for a manual lineup between activations.
  - **When it ends:** restore exactly (the old lineup and start time, so it carries on as if it had kept airing), resume (the old lineup picks up where it was interrupted), or keep (only for a one-time entry with no end).
  - **Check** lists the next occurrences in the entry's zone, conflicts and warnings, and is needed again after any change before saving.
  - Each occurrence is planned a few hours before it starts (six by default, adjustable) against the channel as it is then, and appears in Scheduled Changes; an edit to the channel after that skips it, and the old lineup comes back at the end only if nothing changed during it. An occurrence that restores or resumes goes in only after a snapshot of what it replaces has been saved; if one can't be, it fails and nothing changes. Channels generated from a slot schedule are skipped. **End now** brings the end forward; **Remove** ends what's on now and cancels what was planned. Nothing happens while scheduled changes are off.

Each change goes in only if the channel is as it was when planned (for an event: the programs it replaces are still there); otherwise it's skipped, never forced.

### 6. Export a program log

**File → Export Program Log…** downloads the visible day as CSV: date,
start, end, duration, type, title, detail and lineup position. If the lineup
has unsaved changes, the filename says `-unsaved`. The week view exports a week
or a month.

### 7. Drive it with a remote or keyboard

| Remote / keyboard | Action |
| --- | --- |
| ↑ / ↓ | Move between programs |
| ← / → | Change day |
| CH+ / CH−, PgUp / PgDn | Change channel |
| OK / Enter | Pick up or drop |
| Back / Esc | Cancel a move, or close a dialog |
| `N` / `T` / `M` / `?` | Now / today / Move dialog / shortcuts |
| `G` / `W` / `C` / `L` | Guide grid / week view / check lineup / watch live |
| `O` | Control Room (in it: ↑ ↓ PgUp PgDn, OK actions, `F` filter, `R` refresh, `C` check, `A` check shown, `S` stream) |
| While watching: CH± or ↑ ↓, digits, `R`, `G`, `I`, `M`, `+`/`−`, `F` | Change channel, tune by number, last channel, cable guide, info banner, mute, volume, full screen |
| ⌘ or Ctrl + Z, Shift+Z (or Y), S | Undo, redo, save |

The menus can also be operated with the arrows, OK and Back.

### 7a. Change the appearance

**View → Appearance…** (also in the phone **Menu** sheet) shows four skins as large
cards, each with a small preview:

- **Platinum** (default): the Mac OS 9 desk described above.
- **Classic Windows:** a Windows 95/98-style teal desktop, gray 3D chrome, navy title bars and square controls. No Microsoft logos or assets.
- **Modern Studio:** light neutral surfaces, restrained blue accents, soft shadows and modest rounding.
- **Broadcast Console:** a dark control room: charcoal panels, cyan selection, amber times and red for on air. The only dark skin.

A skin covers everything: menus, dialogs, the lineup, the program bin, the guide grid,
week view, the lineup check, and Watch Live with its banner, on-screen display, cable
guide and remote. Station-log colours (breaks, IDs, promos, flex), warnings, errors and
on-air red keep their meaning in every skin. Layout and behaviour don't change.

Arrows move between the cards, OK/Enter or Space picks one, and it applies and is saved
at once; **Done** or Back closes without undoing it. The choice belongs to the browser
(local storage), not the Lineup server or Tunarr, so a TV and a laptop can use different
skins. If the browser blocks storage, the skin still applies but isn't remembered.

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
- **Sign-in is always on after setup:** HTTP Basic with the account made in the wizard protects everything but `/healthz`; the password is kept only as a scrypt hash. Before setup, only someone with the setup code from the server's log can configure it.
- **Host names:** with sign-in, any name works (the browser only sends the password to the address it signed in on, which stops DNS rebinding). A server without setup and without a password answers only to IP addresses, `localhost` and the names in `LINEUP_ALLOWED_HOSTS`.
- **Tunarr API compatibility:** Lineup depends on Tunarr's channel, programming, lineup, schedule, artwork, search, filler-list, custom-show, smart-collection, transcode-config and media-source endpoints and their payload shapes (see `docs/ARCHITECTURE.md`). The companion detects Tunarr's version and, more importantly, which of these it actually offers, with read-only checks (Server Settings → Compatibility, D63); versions outside 1.x get a warning, not a block. A feature is turned off only on evidence that Tunarr lacks it (a route answering "no such route", or Tunarr's API description leaving out a route the feature requires); then its Save is disabled before any edit, with the missing route named. The same evidence turns off single actions of a manager (creating, editing or deleting lists, collections, sources or profiles; adding, scanning or refreshing sources; new and deleted channels) while the rest of it keeps working, and the dialog says which and why. A timeout, an error or an API description that fails to load never turns anything off.
- **Generated schedules:** saving manually can detach a channel from its generated schedule. Tunarr may also regenerate over manual edits.
- **TV readability and remote operation:** text must stay large and anti-aliased in every skin, and every action must work without a mouse. The UI scales with the viewport (width, capped by height), and phones and tablets get a compact layout with a Menu sheet and a collapsible Program Info sheet.
- **Conflict check window:** the companion checks and writes under a per-channel lock, so two Lineup sessions can't overwrite each other. Tunarr's API has no conditional save, so an edit made in Tunarr's own UI in the milliseconds between check and write would still be overwritten.
- **Drafts are shared through the companion:** unsaved work on the TV opens on a laptop (the newer copy wins). The hosted preview keeps drafts per browser.

## Out of scope (as built)

The code does not implement:
- uploading logo or media files (logos are set by address), Plex OAuth sign-in (a token is entered), and Tunarr's global settings (FFmpeg, HDHomeRun, XMLTV)
- events that cut into a program mid-way (an event airs once only through the scheduler, with scheduled changes on)
- a guide (XMLTV) served by Lineup, title or sub-title templates, and names for marathons, events or dayparts in the guide: Tunarr is the guide's authority and has no API for them (D69); Lineup previews and checks Tunarr's guide only
- slot schedules in the schedule library or calendar (a schedule save needs its preview's seed, so only manual lineups are kept and scheduled)
- batch changes to a slot schedule, or a manual lineup saved over one by a batch
- previewing a library program's video before inserting it (Tunarr has no per-program stream)
- AI-written lineups that bypass preview (the AI only writes templates)
- time-slot per-slot padding/lateness overrides
- user accounts or roles beyond the single optional password
- live merging of one channel's draft edited on two devices at once, or persisting slot-schedule drafts across reloads
