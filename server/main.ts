// Entry point for the local companion server (see server/app.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineupServer } from './app.js';
import { bootCompanion, setupBanner } from './boot.js';

const staticRoot = path.resolve(
  process.env.STATIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-local'),
);
const { config, setup, store, hosts, notes } = await bootCompanion(process.env, staticRoot);
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const server = createLineupServer({ config, auth: () => setup.auth(), staticRoot, hosts });

server.listen(port, host, () => {
  config.scheduler?.start();
  const tunarr = config.target ? config.target.host : 'not set up yet';
  const account = setup.stored().account;
  console.log(`Tunarr Lineup listening on http://${host}:${port} · Tunarr: ${tunarr} · sign-in: ${setup.needed() ? 'after setup' : `user "${account?.username}"`} · settings: ${store.location}`);
  for (const note of notes) console.log(note);
  // The desktop app hands its window the code itself.
  if (setup.needed() && !process.env.LINEUP_SETUP_CODE) console.log(setupBanner(setup.code));
  if (config.scheduler?.enabled) console.log('Scheduled changes are on: due changes are saved to Tunarr every 30 seconds.');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { config.scheduler?.stop(); server.close(() => process.exit(0)); });
}
