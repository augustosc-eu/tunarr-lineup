@AGENTS.md

## Claude Code notes

- **To verify UI changes visually**, use the Claude in Chrome tools if they're connected.
  Otherwise drive headless Chrome with Playwright. The product is used on a TV, so check
  screenshots at 1920×1080 as well as a laptop size, and confirm there's no horizontal overflow.
- **Point browser checks at the companion** (`npm run dev:local` or `npm run start:local`),
  not `npm run dev`. The Vinext dev server has no `/api/tunarr` proxy and only shows the
  "Live mode unavailable" / demo path.
