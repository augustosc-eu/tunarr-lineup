// Renders the app icons from public/favicon.svg with Playwright's Chromium:
// the home-screen icons for the installable web app (public/icons/) and the
// desktop app icon (desktop/build/icon.png, which electron-builder turns into
// .icns and .ico). Run with `node scripts/make-icons.mjs` after changing the logo.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = await readFile(path.join(root, 'public', 'favicon.svg'), 'utf8');

// A platinum tile, with a bevel like the desk's chrome when its edge shows (full-bleed icons get cropped).
const tile = (radius) => `background:linear-gradient(#f2f2f2,#cfcfcf);border-radius:${radius};` + (radius === '0' ? '' : `box-shadow:inset 0 0 0 calc(var(--s)*0.006) #8a8a8a,inset calc(var(--s)*0.012) calc(var(--s)*0.012) 0 #fff,inset calc(var(--s)*-0.012) calc(var(--s)*-0.012) 0 #a8a8a8;`);

const icons = [
  // Rounded tile with transparent corners, for browsers that show the icon as is.
  { file: 'public/icons/icon-192.png', size: 192, inset: 0, radius: '22%', logo: 0.62, transparent: true },
  { file: 'public/icons/icon-512.png', size: 512, inset: 0, radius: '22%', logo: 0.62, transparent: true },
  // Full bleed; Android crops it to its own shape, so the logo stays in the safe zone.
  { file: 'public/icons/maskable-512.png', size: 512, inset: 0, radius: '0', logo: 0.5, transparent: false },
  // iOS rounds the corners itself and wants an opaque square.
  { file: 'public/icons/apple-touch-icon.png', size: 180, inset: 0, radius: '0', logo: 0.6, transparent: false },
  // macOS-style margin around the tile; also used for Windows and Linux.
  { file: 'desktop/build/icon.png', size: 1024, inset: 0.1, radius: '22%', logo: 0.6, transparent: true },
];

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const pad = icon.size * icon.inset;
    const box = icon.size - pad * 2;
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent;--s:${box}px">
      <div style="position:absolute;left:${pad}px;top:${pad}px;width:${box}px;height:${box}px;display:grid;place-items:center;${tile(icon.radius)}">
        <div style="width:${box * icon.logo}px;height:${box * icon.logo}px">${logo.replace('<svg width="24" height="24"', '<svg width="100%" height="100%"')}</div>
      </div></body></html>`);
    await page.screenshot({ path: path.join(root, icon.file), omitBackground: icon.transparent });
    await page.close();
    console.log(`${icon.file} (${icon.size}×${icon.size})`);
  }
} finally {
  await browser.close();
}
