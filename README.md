# Tunarr Lineup

A Mac OS 9–style programming desk for the channels on your
[Tunarr](https://tunarr.com) server. Pick a channel, jump to a date, then
rearrange what's already scheduled and save it back to Tunarr. Lineup only
rearranges items that are already in a channel; it never adds media or
programming. It is designed to be driven from a TV with a remote as well as
with a mouse and keyboard.

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
  - **Random slots:** change the source (one the schedule already uses), weight, cooldown, length and order; reorder, duplicate or remove slots.
  - **Time slots:** change start times and shift every slot at once.
  - **Preview lineup** shows the regenerated lineup in the timeline. **Save schedule** saves it with the preview's random seed and reports any difference from the preview.
- **Safe saving.**
  - **Conflict check:** every save says which version of the channel it was based on (`If-Match`). The companion checks that version and writes while holding a per-channel lock. If the channel changed in the meantime, nothing is saved.
  - **Remaining gap:** this fully closes the gap between Lineup sessions. Against edits made in Tunarr's own UI, it leaves a window of a few milliseconds (Tunarr has no conditional save of its own).
  - **Generated schedules:** channels driven by a slot or time schedule ask for confirmation first.
- **Program log.** **File → Export Program Log…** downloads the visible day as CSV.
- **Artwork** is loaded through the companion, so the browser never contacts Tunarr or your media server.
- **Pull-down menus** (File, Edit, View, Channel, Help) work with the mouse, the keyboard, or a remote.

## Architecture

The same React interface (`app/page.tsx`) ships in two ways:

| Target | What it is | Talks to Tunarr? |
| --- | --- | --- |
| **Local companion** (`server/`, `vite.local.config.ts`, `Dockerfile`) | A small Node server that serves the interface **and** a narrow same-origin proxy at `/api/tunarr/*`. Run it next to Tunarr. | Yes. This is the supported way to edit real channels. |
| **Hosted preview** (Vinext on OpenAI Sites, `vite.config.ts`) | The original hosted site. | No. It runs as a demo/preview only. |

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
| `GET /api/tunarr/programs/:id/artwork/:type` | `GET {TUNARR_URL}/api/programs/:id/artwork/:type` (image types only; `:id` must be a UUID; `:type` is `poster`, `thumbnail`, `landscape` or `banner`) |

The proxy is deliberately narrow (`server/tunarrProxy.ts`):

- The upstream origin comes only from `TUNARR_URL`. Nothing in a request can change it.
- Any other path or method is refused (`404 route_not_allowed`, `405 method_not_allowed`).
- Channel IDs must match `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. Unexpected query parameters are rejected.
- `from`/`to` must be ISO 8601 date-times, `to` must be after `from`, and the range is capped at 14 days.
- **Manual saves** must be `application/json` with `{"type":"manual","lineup":[…],"append":false}`, and every item needs a known type and a positive duration. Lineup items are forwarded unchanged, so Tunarr's own fields (flex filler config, redirect targets, custom-show and filler references, offsets…) survive.
- **Slot-schedule saves** (`{"type":"random"|"time","schedule":{"slots":[…]},"seed":[…]}`) can only use sources the channel's current schedule already uses.
  - Every other schedule setting comes from Tunarr's current copy.
  - The companion builds the program list itself from programs already on the channel, as Tunarr's own slot editors do; a `programs` list sent by the browser is ignored.
  - A channel's schedule type can't be switched.
- **Every save needs `If-Match: "<version>"`,** the version of the channel it was based on. Without it the response is 428; if the channel changed meanwhile, 412 `lineup_changed`.
- Writes from another site are blocked: the `Origin` must match the companion's host.
- Browser cookies, `Authorization` and hop-by-hop headers are never forwarded. Upstream redirects are not followed.
- Timeouts are 10 s for reads and 30 s for saves. Override them with `TUNARR_TIMEOUT_MS` and `TUNARR_SAVE_TIMEOUT_MS`.
- Errors come back as `{"error":{"code","message"}}`. Messages name the Tunarr host but never credentials, and never include stack traces.
- Artwork responses must be an image type (JPEG, PNG, WebP, GIF or AVIF) of at most 8 MB.

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
  - If the channel uses a generated slot or time schedule, Lineup asks for confirmation first, because saving a manual lineup can detach the channel from that schedule.
  - Leaving a channel with unsaved changes asks for confirmation. **Undo changes** restores the last loaded lineup.
- Artwork is fetched through `/api/tunarr/programs/:id/artwork/:type`; demo data uses letter tiles.

### Sign-in

The companion has no sign-in by default. Anyone who can reach its port can
edit your channels. Set `LINEUP_PASSWORD` (and optionally `LINEUP_USERNAME`,
default `lineup`) to require HTTP Basic sign-in for everything except
`/healthz`. Basic auth sends the password with every request, so use it on a
trusted network or behind HTTPS.

## Run with Docker Compose (recommended)

```sh
cp docker-compose.example.yml docker-compose.yml
# edit the Tunarr volume path / TZ, or drop the tunarr service if you already run it
docker compose up -d --build
```

Open **http://localhost:3000**. Tunarr itself stays at http://localhost:8000.

- The `lineup` container reaches Tunarr at `http://tunarr:8000` over the shared `tunarr` network, set with `TUNARR_URL` in the compose file.
- If Tunarr already runs in another compose project, attach the `lineup` service to that project's network and point `TUNARR_URL` at Tunarr's service name.
- The image has a healthcheck (`GET /healthz`).
- The published `chrisbenincasa/tunarr:latest` image is amd64-only. On Apple silicon, add `platform: linux/amd64` to the `tunarr` service.
- Lineup can rewrite channel programming. Publish it as `127.0.0.1:3000:3000` if it should only be reachable from the Docker host.

To build and run only the companion against an existing Tunarr:

```sh
docker build -t tunarr-lineup .
docker run -d --name tunarr-lineup -p 3000:3000 \
  -e TUNARR_URL=http://192.168.1.50:8000 tunarr-lineup
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
| `LINEUP_PASSWORD` | (none) | Turns on HTTP Basic sign-in |
| `LINEUP_USERNAME` | `lineup` | Sign-in user name |
| `STATIC_DIR` | `dist-local` | Directory holding the built interface |

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
- `lineup.test.ts`, `broadcast.test.ts`: reorder, block moves, move-to-time, timecode, day totals, CSV, undo history, artwork URLs, and save payload preservation for every lineup item type.
- `page.test.tsx`: live loading, date navigation, reorder → save → re-fetch, conflict detection, remote-key slide, block moves, menus, log export, and no silent demo fallback.
- `e2e/desk.spec.ts`: the real browser flow at 1920×1080 and phone width.
