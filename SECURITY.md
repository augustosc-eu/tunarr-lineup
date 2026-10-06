# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's
[private vulnerability reporting](https://github.com/augustosc-eu/tunarr-lineup/security/advisories/new)
for this repository. Don't open a public issue. Include the version (or
commit), how Lineup is deployed, and steps to reproduce. You should get a
reply within a week.

Only the latest release is supported with fixes.

## What Lineup protects, and what it doesn't

Lineup can rewrite your channels' programming and change Tunarr's setup
(channels, media sources, transcode profiles). Treat access to it like access
to Tunarr itself.

- **No sign-in by default.** Anyone who can reach the companion's port can
  edit your channels. Set `LINEUP_PASSWORD` to require HTTP Basic sign-in,
  publish the port on `127.0.0.1` only, or keep it on a trusted network.
  Basic auth sends the password with every request, so use HTTPS (a reverse
  proxy) if it crosses an untrusted network. Don't expose Lineup to the
  internet without sign-in and HTTPS.
- **The browser never contacts Tunarr.** It only calls the companion's
  same-origin `/api/tunarr/*` routes. The companion forwards an explicit
  allowlist of routes to the one Tunarr address in `TUNARR_URL`, validates
  every id and body, doesn't follow redirects, and doesn't forward cookies or
  credentials.
- **Secrets stay on the server.** Media-server addresses and tokens are sent
  to Tunarr and never returned to the browser. The AI provider's key and
  address are read from the server's environment only.
- **DNS rebinding.** Without sign-in, the companion only answers to IP
  addresses, `localhost`, and names listed in `LINEUP_ALLOWED_HOSTS`.
- **Channel logos** on public sites are fetched by the companion with guards:
  public addresses only, ports 80/443, image types, and size and redirect
  limits. Set `LINEUP_EXTERNAL_LOGOS=false` to turn this off.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full request flow.
