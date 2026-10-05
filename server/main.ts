// Entry point for the local companion server (see server/app.ts).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLineupServer } from './app.js';
import { createAuthConfig } from './auth.js';
import { createHostPolicy } from './hosts.js';
import { createProxyConfig } from './tunarrProxy.js';

const config = createProxyConfig(process.env);
const auth = createAuthConfig(process.env);
const hosts = createHostPolicy(process.env);
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const staticRoot = path.resolve(
  process.env.STATIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-local'),
);

const server = createLineupServer({ config, auth, staticRoot, hosts });

server.listen(port, host, () => {
  const tunarr = config.target ? config.target.host : config.configError ? 'invalid TUNARR_URL' : 'not configured (set TUNARR_URL)';
  console.log(`Tunarr Lineup listening on http://${host}:${port} · Tunarr: ${tunarr} · sign-in: ${auth ? `on (user "${auth.username}")` : 'off'}`);
  if (!auth && host !== '127.0.0.1' && host !== 'localhost') {
    console.log('Anyone who can reach this port can edit channel programming. Set LINEUP_PASSWORD to require sign-in.');
  }
  if (!auth && !hosts.any) {
    console.log(`Answering to IP addresses and localhost${hosts.names.length ? ` and ${hosts.names.join(', ')}` : ''}. Add other host names to LINEUP_ALLOWED_HOSTS.`);
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
