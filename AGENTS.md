# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex) working in this repository.
Read this first; read the docs below before non-trivial changes.

- `docs/PRODUCT.md`: what Tunarr Lineup is, who uses it, terminology, intended behavior
- `docs/ARCHITECTURE.md`: how the code actually works (entry points, data flow, proxy, build)
- `docs/DECISIONS.md`: decisions already made and the evidence for them
- `README.md`: end-user setup (Docker, local Node, environment variables)

## What this is

A Mac OS 9–styled web editor that reorders the existing programming of
[Tunarr](https://tunarr.com) channels. It ships as two targets built from one
React page (`app/page.tsx`):

- **Local companion** (supported for real use): `server/` (dependency-free Node HTTP
  server plus a narrow `/api/tunarr/*` proxy) serving a Vite build of the page.
  Configured by `TUNARR_URL`. Docker: `Dockerfile`, `docker-compose.example.yml`.
- **Hosted preview**: Vinext (Next.js App Router on Vite) deployed via OpenAI Sites
  (`vite.config.ts`, `app/layout.tsx`). It has no proxy, so only demo mode works there.

## Commands

```sh
npm install
npm run lint          # eslint (next core-web-vitals + typescript)
npm run typecheck     # tsc for the app and for server/
npm test              # vitest run (tests/)
npm run build         # hosted preview build (vinext) -> dist/
npm run build:local   # companion build -> dist-local/ (UI) + dist-server/ (server)
TUNARR_URL=http://localhost:8000 npm run dev:local    # companion dev server on :3000
TUNARR_URL=http://localhost:8000 npm run start:local  # run the built companion
```

Before declaring work done, run `lint`, `typecheck`, `test`, `build` and
`build:local`. Both builds must keep working; they use different Vite configs.

## Invariants (do not break without explicit approval)

1. **The browser never contacts Tunarr.** It calls only same-origin `/api/tunarr/*`.
   Never put `TUNARR_URL` or any Tunarr address in client code. Only the `LINEUP_PUBLIC_`
   env prefix is exposed to the client (`vite.local.config.ts`). Never add a
   user-entered URL workflow, wildcard CORS, or a generic proxy.
2. **The proxy stays an allowlist.** `server/tunarrProxy.ts` allows exactly five routes
   (`matchRoute`). Adding a route means validating its params and query, adding tests,
   and documenting it in `docs/ARCHITECTURE.md`. Keep the SSRF guards: fixed upstream
   origin, channel-ID regex, `redirect: 'manual'`, timeouts, no forwarded cookies or auth,
   the Origin check, and normalized JSON errors without stack traces.
3. **Only rearrange what exists.** The editor may reorder lineup items but must never
   add media or programming. Lineup item objects are passed through untouched on save
   (`buildManualSave`); never rebuild them from a subset of fields.
4. **Saves use Tunarr's manual payload** `{ "type": "manual", "lineup": [...], "append": false }`,
   then re-fetch programming and the visible day. Warn before saving a channel whose
   programming has a `schedule` (generated slot/time schedule).
5. **No silent demo fallback.** Live failures show errors; demo data appears only after
   the user picks "Use demo data". Keep demo mode visibly labeled.
6. **Server stays dependency-free.** The runtime Docker stage copies only `dist-server/`
   and `dist-local/`, with no `node_modules`. Use Node built-ins in `server/`, or update
   the Dockerfile deliberately.
7. **Preserve the Mac OS 9 visual treatment**: platinum chrome, striped title bars, 1px
   bevels. The interface is used on a TV, so keep text large and smooth. Size things in
   `rem` (the root scales with viewport width in `app/globals.css`); keep 1px hairlines
   in `px`; don't reintroduce `-webkit-font-smoothing:none` or sub-13px base type.

## Working rules

- **Treat any reachable Tunarr as real user data.** Read-only checks are fine. Never
  save programming to a real Tunarr unless the user asks. For write testing, use the
  test suite or a throwaway Tunarr container.
- **Match the surrounding style.** `app/page.tsx` uses compact, dense JSX and helper
  functions at module scope; `server/` and `lib/` use small typed functions with brief
  "why" comments. Use custom CSS classes in `app/globals.css`; Tailwind is imported
  but its utilities are essentially unused.
- **Put pure logic in `lib/`** (testable without React) and HTTP and validation logic
  in `server/tunarrProxy.ts` (framework-free and unit-testable). Keep `page.tsx` for UI
  state and rendering.
- **Add or update tests in `tests/`** for any behavior change. Proxy tests inject
  `fetchImpl`; UI tests mock `fetch` with a stateful fake companion (`tests/page.test.tsx`).
- **Don't edit generated or vendored output:** `dist*/`, `.next/`, `.vinext/`,
  `.wrangler/`, `next-env.d.ts`.
- **Don't change `.openai/hosting.json`** or the `sites()` / `cloudflare()` plugin setup
  in `vite.config.ts` unless the task is about hosted deployment.
- **Keep docs current.** When behavior, routes, env vars or commands change, update
  `README.md` and the relevant file in `docs/`.
- Commit or push only when asked.
