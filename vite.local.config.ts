// Build and dev config for the local companion target (see README). Unlike
// vite.config.ts it has no Cloudflare runtime: the UI is a static bundle and
// /api/tunarr/* is answered by the Node proxy in server/.
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { AUTH_CHALLENGE, authorize } from './server/auth.js';
import { bootCompanion, setupBanner } from './server/boot.js';
import { hostRefusal, isAllowedHost } from './server/hosts.js';
import { handleNodeApiRequest, isTunarrApiPath } from './server/nodeAdapter.js';

function tunarrApi(env: Record<string, string>): Plugin {
  return {
    name: 'tunarr-lineup-api',
    // The same start as the companion (server/boot.ts): config.json, setup and sign-in.
    async configureServer(server) {
      const { config, setup, hosts, notes } = await bootCompanion(env);
      for (const note of notes) console.log(note);
      if (setup.needed()) console.log(setupBanner(setup.code));
      // Dated changes run in the dev server too when the scheduler is on.
      config.scheduler?.start();
      server.httpServer?.once('close', () => config.scheduler?.stop());
      // Runs before Vite's own host check, so it repeats the companion's.
      server.middlewares.use((req, res, next) => {
        const auth = setup.auth();
        if (!auth && !setup.needed() && !isAllowedHost(req.headers.host, hosts)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(hostRefusal(req.headers.host ?? ''));
          return;
        }
        authorize(req.headers.authorization, auth).then((ok) => {
          if (!ok) {
            res.writeHead(401, AUTH_CHALLENGE);
            res.end('Sign in to Tunarr Lineup.');
            return;
          }
          if (!isTunarrApiPath(req.url)) return next();
          return handleNodeApiRequest(req, res, config);
        }).catch(next);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>;
  return {
    root: 'local',
    publicDir: '../public',
    // Server settings are read by the server only; nothing from the environment
    // is exposed to the client bundle.
    envPrefix: 'LINEUP_PUBLIC_',
    css: { postcss: { plugins: [tailwindcss()] } },
    plugins: [react(), tunarrApi(env)],
    // The middleware above applies the companion's host rule (sign-in, or the setup code, otherwise LINEUP_ALLOWED_HOSTS).
    server: { port: 3000, allowedHosts: true },
    build: { outDir: '../dist-local', emptyOutDir: true },
  };
});
