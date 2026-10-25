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

- **Setup is protected by a one-time code.** Until the setup wizard is
  finished, only the wizard answers, and it needs the code the server prints
  in its log; five wrong codes lock it for a minute.
- **Sign-in is always on after setup.** HTTP Basic with the account made in
  the wizard; the password is stored only as a salted scrypt hash in
  `config.json` (owner-only, in the data folder). Basic auth sends the password
  with every request, so use HTTPS (a reverse proxy) if it crosses an
  untrusted network, and don't expose Lineup to the internet without it.
- **The browser never contacts Tunarr.** It only calls the companion's
  same-origin `/api/tunarr/*` routes. The companion forwards an explicit
  allowlist of routes to the one Tunarr address saved in setup, validates
  every id and body, doesn't follow redirects, and doesn't forward cookies or
  credentials.
- **Secrets stay on the server.** Media-server addresses and tokens are sent
  to Tunarr and never returned to the browser. The AI provider's key, the
  password and any credentials in Tunarr's address are write-only: kept in
  `config.json` and never sent back. Keep the data folder private.
- **DNS rebinding.** A rebound name gets no credentials from the browser, so
  it is refused with sign-in on. A server without setup and without a
  password only answers to IP addresses, `localhost`, and names listed in
  `LINEUP_ALLOWED_HOSTS`.
- **Channel logos** on public sites are fetched by the companion with guards:
  public addresses only, ports 80/443, image types, and size and redirect
  limits. Turn off **Load logos from public sites** in Server Settings to stop this.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full request flow.
