// Build and dev config for the local companion target (see README). Unlike
// vite.config.ts it has no Cloudflare runtime: the UI is a static bundle and
// /api/tunarr/* is answered by the Node proxy in server/.
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { AUTH_CHALLENGE, createAuthConfig, isAuthorized } from './server/auth.js';
import { createHostPolicy, hostRefusal, isAllowedHost } from './server/hosts.js';
import { handleNodeApiRequest, isTunarrApiPath } from './server/nodeAdapter.js';
import { createProxyConfig } from './server/tunarrProxy.js';

function tunarrApi(env: Record<string, string>): Plugin {
  const config = createProxyConfig(env);
  const auth = createAuthConfig(env);
  const hosts = createHostPolicy(env);
  return {
    name: 'tunarr-lineup-api',
    configureServer(server) {
      // Runs before Vite's own host check, so it repeats the companion's.
      server.middlewares.use((req, res, next) => {
        if (!auth && !isAllowedHost(req.headers.host, hosts)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(hostRefusal(req.headers.host ?? ''));
          return;
        }
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

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env } as Record<string, string>;
  const hosts = createHostPolicy(env);
  return {
    root: 'local',
    publicDir: '../public',
    // TUNARR_URL is read by the server only; nothing from the environment is
    // exposed to the client bundle.
    envPrefix: 'LINEUP_PUBLIC_',
    css: { postcss: { plugins: [tailwindcss()] } },
    plugins: [react(), tunarrApi(env)],
    // Same host rule as the companion: any name with sign-in on, otherwise IPs, localhost and LINEUP_ALLOWED_HOSTS.
    server: { port: 3000, allowedHosts: hosts.any || createAuthConfig(env) ? true : hosts.names },
    build: { outDir: '../dist-local', emptyOutDir: true },
  };
});
