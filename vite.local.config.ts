// Build and dev config for the local companion target (see README). Unlike
// vite.config.ts it has no Cloudflare runtime: the UI is a static bundle and
// /api/tunarr/* is answered by the Node proxy in server/.
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { AUTH_CHALLENGE, createAuthConfig, isAuthorized } from './server/auth.js';
import { handleNodeApiRequest, isTunarrApiPath } from './server/nodeAdapter.js';
import { createProxyConfig } from './server/tunarrProxy.js';

function tunarrApi(env: Record<string, string>): Plugin {
  const config = createProxyConfig({ ...env, ...process.env });
  const auth = createAuthConfig({ ...env, ...process.env });
  return {
    name: 'tunarr-lineup-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isAuthorized(req.headers.authorization, auth)) {
          res.writeHead(401, AUTH_CHALLENGE);
          res.end('Sign in to Tunarr Lineup.');
          return;
        }
        if (!isTunarrApiPath(req.url)) return next();
        handleNodeApiRequest(req, res, config).catch(next);
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: 'local',
  publicDir: '../public',
  // TUNARR_URL is read by the server only; nothing from the environment is
  // exposed to the client bundle.
  envPrefix: 'LINEUP_PUBLIC_',
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react(), tunarrApi(loadEnv(mode, process.cwd(), ''))],
  server: { port: 3000 },
  build: { outDir: '../dist-local', emptyOutDir: true },
}));
