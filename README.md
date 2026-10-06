# Tunarr Lineup

A Mac OS 9–style programming desk for the channels on your
[Tunarr](https://tunarr.com) server. Pick a channel and a date, then arrange,
insert and remove programs, build slot schedules, and add commercials and
filler, all saved through Tunarr's own API. It is designed to be driven from a
TV with a remote as well as with a mouse and keyboard.

![The Lineup programming desk at 1920×1080: channel list, the day's schedule with the program on air, and the selected program's inspector](docs/screenshot.png)

## Quick start

You need a running [Tunarr](https://tunarr.com) server. Run the companion next
to it and point `TUNARR_URL` at Tunarr's address as the container sees it:

```sh
docker run -d --name tunarr-lineup -p 3000:3000 \
  -e TUNARR_URL=http://192.168.1.50:8000 \
  -v lineup-data:/data \
  ghcr.io/augustosc-eu/tunarr-lineup:latest
```

Open **http://localhost:3000** (or the machine's IP address). The image runs on
amd64 and arm64. Lineup can rewrite your channels, so read [Sign-in](#sign-in)
before making it reachable by anyone else. To run Tunarr and Lineup together,
see [Run with Docker Compose](#run-with-docker-compose-recommended).

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
- **Edit list.** Step-by-step undo and redo (⌘Z / ⇧⌘Z, or Ctrl+Z / Ctrl+Y). Changed rows are marked, and **Revert all** discards every edit.
  - Unsaved work and the edit list are kept per channel in the browser (IndexedDB). They survive switching channels, reloading the page and turning the TV off.
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

  **Remove** (or `Delete`) takes items out. Flex, breaks and redirects have an adjustable length in the inspector. Every edit is in the edit list and the stored draft. The dialog says when inserted items will air. Because a manual lineup repeats from the channel's start time, a longer lineup moves later passes; tick **Keep what's on air in place** to have the companion move the start time on save so the current pass keeps its times.
- **Library browser.** Browse or search any media source and library Tunarr has indexed (Plex, Jellyfin, Emby, local folders), and drill into shows and seasons. Libraries of up to 1,000 items are listed in episode order (by the number in each title, whatever its language) and searched by number as you type: "capitulo 2" finds "Chapter 2". Picks are listed before you insert them.
- **Commercials and filler.**
  - **Lists → Filler Lists…** creates and edits filler lists (commercials, bumpers, station IDs). **Lists → Custom Shows…** manages custom shows.
  - **Channel → Channel Settings…** sets which filler lists play during a channel's flex time (weights and cooldowns), plus the channel's name, number, group, guide flex title and start time.
  - Slots can carry their own commercials: before or after each program, at the start or end of the slot, or as mid-roll breaks inside programs.
- **Slot schedules.**
  - **Channel → Create / Edit Slot Schedule…** builds a random- or time-slot schedule from any source: shows from the library, movies, custom shows, filler lists, smart collections, or redirects to other channels.
  - You can change every schedule setting, convert between random and time slots, add movies to the movie pool, or **Detach to manual lineup**.
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
  - **Filling it in:** each role ("Morning news", "Telenovela", "Prime drama"…) takes a show, movies, a custom show, an existing smart collection, or a new smart collection the template suggests (with its match count in your library). Choose a commercials list and a promos list. The result opens in the slot editor, for this channel or a new one, to preview and save.
  - **Ad levels per block:** every block is "no commercials", "light", "standard" or "heavy". Light spaces breaks out, heavy brings them closer and makes them longer, and "no commercials" keeps only promos.
- **My templates.** Save your own: **New template**, **Copy and edit…** a built-in one, or **Save this channel's format** (turns a time-slot channel's schedule into a template whose roles are pre-filled with that channel's sources). The editor covers name, day plan (every day, weekdays/Saturday/Sunday, or each day), blocks with ad levels, roles with suggestion genres, start-time grid, lateness and the commercial style. Saved templates live on the Lineup server (`LINEUP_DATA_DIR`), so the TV and every other browser see them.
- **AI programming.** **Ask AI…** in the template gallery writes a template from a prompt ("a 90s Saturday-morning cartoon channel", "program this like Rai 1"). It can use your library's show and movie titles and genres, what the current channel plays, and any template as a starting point. It fills roles with your actual shows and collections where they fit, picks commercial lists, and explains what your library lacks. You can save the result to My templates, edit it, or apply it, and nothing changes until you preview and save. See [AI setup](#ai-setup).
- **Events on a date.** **Edit → Schedule Event…** (or `E`) places a match, premiere or special at a date and time: programs from the library, a simulcast of another channel (a redirect), or off-air time. Tunarr can't cut a program short, so the event starts when the program on air ends (or in its place). **Replace** takes out what would have aired and pads with flex so everything after stays on time; **Push** moves everything later. The preview shows the exact start, what is taken off, and when the lineup repeats (the event repeats with it). On slot-scheduled channels the event lasts until the schedule is regenerated.
- **Smart collections.** **Lists → Smart Collections…** builds saved searches from rules (genre, studio, actor, year, length, added in the last N weeks…), previews how many programs match, and saves them for slots to play.
- **Channels.**
  - **Channel → New Channel… / Duplicate Channel… / Delete Channel…** (delete asks first).
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
                     └──▶ TUNARR_URL       (e.g. http://tunarr:8000, server side only)
```

The browser only ever requests the companion's own origin. `TUNARR_URL` is
read by the server at runtime. It is not part of the client bundle or the
Docker image. The served page also sends a `connect-src 'self'` Content
Security Policy, so the browser could not reach Tunarr directly even by
accident.

### Proxy routes

| Companion route | Tunarr API |
| --- | --- |
| `GET /api/tunarr/health` | `GET {TUNARR_URL}/api/channels` (reports reachability and channel count) |
| `GET /api/tunarr/channels` | `GET {TUNARR_URL}/api/channels` |
| `GET /api/tunarr/channels/:id/programming` | `GET {TUNARR_URL}/api/channels/:id/programming` |
| `POST /api/tunarr/channels/:id/programming` | `POST {TUNARR_URL}/api/channels/:id/programming` |
| `GET /api/tunarr/channels/:id/lineup?from=…&to=…` | `GET {TUNARR_URL}/api/channels/:id/lineup` |
| `GET /api/tunarr/channels/:id/schedule` | `GET {TUNARR_URL}/api/channels/:id/schedule` (slot schedule with show and collection names) |
| `POST /api/tunarr/channels/:id/schedule-preview` | `POST {TUNARR_URL}/api/channels/:id/schedule-slots` or `/schedule-time-slots` (generates a lineup; saves nothing) |
| `GET /api/tunarr/media-sources` | `GET {TUNARR_URL}/api/media-sources` (ids, names, types and enabled libraries only; addresses and accounts are dropped) |
| `POST /api/tunarr/library/search` | `POST {TUNARR_URL}/api/programs/search` (built from `{ mediaSourceId, libraryId?, text?, type?, parentId?, page?, limit? }`) |
| `GET /api/tunarr/programs/:id/descendants` | `GET {TUNARR_URL}/api/programs/:id/descendants` (every program in a show or season) |
| `GET`/`POST /api/tunarr/filler-lists`, `PUT`/`DELETE …/:id`, `GET …/:id/programs` | Tunarr's filler-list API |
| `GET`/`POST /api/tunarr/custom-shows`, `PUT`/`DELETE …/:id`, `GET …/:id/programs` | Tunarr's custom-show API (playlist sync settings are preserved on update) |
| `GET /api/tunarr/smart-collections` | `GET {TUNARR_URL}/api/smart_collections` |
| `GET`/`PUT /api/tunarr/channels/:id/settings` | `GET`/`PUT {TUNARR_URL}/api/channels/:id` (only programming-related fields can change; everything else is kept as Tunarr has it) |
| `GET /api/tunarr/channels/:id/logo?v=…` | The channel's `icon.path`: Tunarr-hosted logos (`/images/…`, whatever host they were saved under) from `TUNARR_URL`; other logos from their public site through a guarded fetch. `204` when there is no usable logo |
| `POST /api/tunarr/channels/create`, `DELETE /api/tunarr/channels/:id` | `POST {TUNARR_URL}/api/channels` (`new` with Tunarr's defaults, or `copy`), `DELETE {TUNARR_URL}/api/channels/:id` |
| `GET /api/tunarr/transcode-configs`, `PUT`/`DELETE …/:id`, `POST …/:id/copy` | Tunarr's transcode-config API (edits are an allowlist merged onto Tunarr's copy; the default profile and profiles in use can't be deleted) |
| `GET /api/tunarr/media-sources/manage`, `POST …/add`, `DELETE …/:id`, `POST …/:id/refresh`, `PUT …/:id/libraries/:libraryId`, `POST …/:id/libraries/:libraryId/scan` | Tunarr's media-source API (Jellyfin and Emby sign-in goes through Tunarr's `/api/jellyfin/login` / `/api/emby/login`; addresses, tokens, accounts and folder paths are never returned) |
| `POST /api/tunarr/smart-collections/create`, `POST …/preview`, `GET`/`PUT`/`DELETE …/:id` | Tunarr's smart-collection API and `POST /api/programs/search` for previews (rules are turned into Tunarr's filter by the companion) |
| `GET`/`POST /api/tunarr/templates`, `PUT`/`DELETE …/:id` | Lineup's own saved templates (`LINEUP_DATA_DIR/templates.json`); not Tunarr |
| `GET /api/tunarr/ai`, `POST /api/tunarr/ai/template` | Lineup's AI assistant: status, and a template from `{ prompt, channelId?, includeLibrary, baseTemplate? }`. Reads context from Tunarr (search, lists, channel programming) and calls the configured AI provider |
| `GET /api/tunarr/programs/:id/artwork/:type` | `GET {TUNARR_URL}/api/programs/:id/artwork/:type` (image types only; `:id` must be a UUID; `:type` is `poster`, `thumbnail`, `landscape` or `banner`) |

The proxy is deliberately narrow (`server/tunarrProxy.ts`):

- The upstream origin comes only from `TUNARR_URL`. Nothing in a request can change it.
- Any other path or method is refused (`404 route_not_allowed`, `405 method_not_allowed`).
- Channel IDs must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Unexpected query parameters are rejected.
- `from`/`to` must be ISO 8601 date-times, `to` must be after `from`, and the range is capped at 14 days.
- **Manual saves** must be `application/json` with `{"type":"manual","lineup":[…],"append":false}`, and every item needs a known type and a positive duration. Lineup items are forwarded unchanged, so Tunarr's own fields (flex filler config, redirect targets, custom-show and filler references, offsets…) survive.
- **Slot-schedule saves and previews** (`{"type":"random"|"time","schedule":{"settings":{…},"slots":[…]},"seed":[…],"extraPrograms":[…]}`) are validated by the companion.
  - It checks slot types, source ids, play orders, timing, weights, commercials and mid-roll breaks, and the settings allowed for the schedule type.
  - Settings Lineup doesn't edit keep Tunarr's current values.
  - The program pool is computed server-side from programs on the channel plus `extraPrograms`; a `programs` list sent by the browser is ignored.
  - Tunarr's own strict validation still runs.
- **Every save needs `If-Match: "<version>"`,** the version of the channel it was based on. Without it the response is 428; if the channel changed meanwhile, 412 `lineup_changed`.
- Writes from another site are blocked: the `Origin` must match the companion's host.
- Browser cookies, `Authorization` and hop-by-hop headers are never forwarded. Upstream redirects are not followed.
- Timeouts are 10 s for reads and 30 s for saves. Override them with `TUNARR_TIMEOUT_MS` and `TUNARR_SAVE_TIMEOUT_MS`.
- Errors come back as `{"error":{"code","message"}}`. Messages name the Tunarr host but never credentials, and never include stack traces.
- Artwork responses must be an image type (JPEG, PNG, WebP, GIF or AVIF) of at most 8 MB.
- **Logos from public sites** (YouTube, TMDB…) are fetched by the companion only over HTTP(S) on ports 80/443, only when every address the host resolves to is public (no loopback, private, link-local, CGNAT/Tailscale or multicast ranges; the check is pinned to the connection), with at most 3 redirects (each re-checked), an image content type, 4 MB and 8 s. Results are cached in memory for an hour. Set `LINEUP_EXTERNAL_LOGOS=false` to turn this off; channels then show logos only when Tunarr hosts them.

If Tunarr sits behind a reverse proxy with basic auth, you can put credentials
in `TUNARR_URL` (`http://user:pass@host`). The server sends them as an
`Authorization` header and never shows them to the browser.

### Live mode vs demo mode

- On load, the interface calls `/api/tunarr/health`.
  - **Connected:** the status reads "Tunarr connected." and your channels load.
  - **`TUNARR_URL` missing:** a dialog explains how to set it.
  - **Unreachable:** the dialog shows the error and the host it tried.
  - **Hosted preview:** no companion server exists there, so live mode is reported as unavailable.
- Demo data appears only after you choose **Use demo data**. It is labeled "Demo mode" and "Demo channels", and it never reads from or writes to Tunarr. A failed live request never switches to demo data on its own.
- Date navigation uses Tunarr's `/lineup` guide for the requested day. Tunarr only keeps a guide for a window around the current time, and a guide can lag behind recent edits. Outside that window, or when the guide doesn't match the lineup, the day is projected from the lineup and a note says so.
- Saving sends the lineup back as a manual lineup, then re-reads the channel's programming and the visible day from Tunarr.
  - If the channel uses a generated slot or time schedule, Lineup asks for confirmation first. Tunarr keeps the slot schedule, but regenerating it (saving the slot schedule, or changing the channel's start time) replaces the edited lineup.
  - Leaving a channel with unsaved changes asks for confirmation. **Undo changes** restores the last loaded lineup.
- Artwork is fetched through `/api/tunarr/programs/:id/artwork/:type`; demo data uses letter tiles.

### Sign-in

The companion has no sign-in by default. Anyone who can reach its port can
edit your channels. Set `LINEUP_PASSWORD` (and optionally `LINEUP_USERNAME`,
default `lineup`) to require HTTP Basic sign-in for everything except
`/healthz`. Basic auth sends the password with every request, so use it on a
trusted network or behind HTTPS.

### Host names

Without sign-in, the companion only answers when it's opened by IP address
(`http://192.168.1.20:3000`) or as `localhost`. This stops a web page on another
site from pointing its own host name at your machine and editing your channels
through your browser (DNS rebinding). To open Lineup by a name such as
`http://nas.local:3000` or a reverse-proxy domain, list it in
`LINEUP_ALLOWED_HOSTS` (comma-separated; `.example.com` also allows its
subdomains). With `LINEUP_PASSWORD` set, any name works, because the browser
only sends the password to the address you signed in on.

## Run with Docker Compose (recommended)

```sh
cp docker-compose.example.yml docker-compose.yml
# edit the Tunarr volume path / TZ, or drop the tunarr service if you already run it
docker compose up -d
```

Open **http://localhost:3000**. Tunarr itself stays at http://localhost:8000.

- The `lineup` container reaches Tunarr at `http://tunarr:8000` over the shared `tunarr` network, set with `TUNARR_URL` in the compose file.
- If Tunarr already runs in another compose project, attach the `lineup` service to that project's network and point `TUNARR_URL` at Tunarr's service name.
- The image has a healthcheck (`GET /healthz`).
- The published `chrisbenincasa/tunarr:latest` image is amd64-only. On Apple silicon, add `platform: linux/amd64` to the `tunarr` service.
- Lineup can rewrite channel programming. Publish it as `127.0.0.1:3000:3000` if it should only be reachable from the Docker host.
- Saved templates are kept in the `lineup-data` named volume (`/data` in the container). Add the AI settings from the compose file's comments to turn on **Ask AI…**.

The compose file uses the published image (`ghcr.io/augustosc-eu/tunarr-lineup`, tags `latest`
or a version such as `0.1.0`). To build it from source instead, replace
`image:` with `build: .` on the `lineup` service, or:

```sh
docker build -t tunarr-lineup .
docker run -d --name tunarr-lineup -p 3000:3000 \
  -e TUNARR_URL=http://192.168.1.50:8000 -v lineup-data:/data tunarr-lineup
```

## Run locally with Node

Requires Node 22.13 or newer.

```sh
npm install

# Development: Vite dev server with the same /api/tunarr proxy built in
TUNARR_URL=http://localhost:8000 npm run dev:local     # http://localhost:3000

# Production build + server
npm run build:local
TUNARR_URL=http://localhost:8000 npm run start:local   # http://localhost:3000
```

`dev:local` also reads `TUNARR_URL` from a `.env` / `.env.local` file. Only
the server sees it.

Server environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TUNARR_URL` | (none) | Tunarr base URL as seen from the server, e.g. `http://tunarr:8000` |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `TUNARR_TIMEOUT_MS` | `10000` | Upstream timeout for reads |
| `TUNARR_SAVE_TIMEOUT_MS` | `30000` | Upstream timeout for saves |
| `LINEUP_EXTERNAL_LOGOS` | `true` | Set to `false` to stop the companion fetching channel logos hosted on public sites |
| `LINEUP_DATA_DIR` | `./data` (`/data` in Docker) | Where saved templates are kept (`templates.json`) |
| `LINEUP_AI_PROVIDER` | (auto) | `anthropic` or `openai` (any OpenAI-compatible API, including Ollama) |
| `LINEUP_AI_API_KEY` | (none) | API key; `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` also work |
| `LINEUP_AI_MODEL` | `claude-sonnet-5-5` for Anthropic | Model name (required for OpenAI-compatible providers) |
| `LINEUP_AI_BASE_URL` | the provider's API | E.g. `http://ollama:11434/v1` for a local model |
| `LINEUP_AI_TIMEOUT_MS` | `180000` | How long to wait for the AI |
| `LINEUP_PASSWORD` | (none) | Turns on HTTP Basic sign-in |
| `LINEUP_USERNAME` | `lineup` | Sign-in user name |
| `LINEUP_ALLOWED_HOSTS` | (none) | Extra host names Lineup answers to without sign-in, e.g. `nas.local,.home.example` (`*` for any); IP addresses and `localhost` always work |
| `STATIC_DIR` | `dist-local` | Directory holding the built interface |

## AI setup

The AI assistant is off until the Lineup server has a provider. Everything is
configured on the server; the browser never sees the key or the provider's
address.

```sh
# Anthropic
LINEUP_AI_PROVIDER=anthropic LINEUP_AI_API_KEY=sk-ant-... npm run start:local
# A local model with Ollama (nothing leaves your network)
LINEUP_AI_PROVIDER=openai LINEUP_AI_BASE_URL=http://localhost:11434/v1 LINEUP_AI_MODEL=llama3.1 npm run start:local
```

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
- `server.test.ts`: static serving, path-traversal guards, CSP, and optional sign-in.
- `hardening.test.ts`: host-name checks (DNS rebinding), own-key validation, saved-template size limits, and templates without `TUNARR_URL`.
- `lineup.test.ts`, `broadcast.test.ts`: reorder, block moves, move-to-time, timecode, day totals, CSV, undo history, artwork URLs, and save payload preservation for every lineup item type.
- `page.test.tsx`: live loading, date navigation, reorder → save → re-fetch, conflict detection, remote-key slide, block moves, menus, log export, and no silent demo fallback.
- `e2e/desk.spec.ts`: the real browser flow at 1920×1080 and phone width.

## Releases

See [CHANGELOG.md](CHANGELOG.md). Publishing a GitHub release builds and pushes
the image for amd64 and arm64 (`.github/workflows/release.yml`). Security
reports: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Tunarr Lineup is an independent companion for
[Tunarr](https://tunarr.com) and isn't affiliated with the Tunarr project.
