import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string) {
  const data = read(file);
  expect(data.subarray(1, 4).toString()).toBe('PNG');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

describe('installable web app (D59)', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest').toString());

  it('opens the desk standalone from the companion’s own origin', () => {
    expect(manifest).toMatchObject({ name: 'Tunarr Lineup', start_url: '/', scope: '/', display: 'standalone' });
    // Same-origin only (invariant 1): nothing in the manifest names another host.
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//);
  });

  it('ships every icon it lists, at the size it claims, including a maskable one', () => {
    for (const icon of manifest.icons) {
      const file = path.join('public', icon.src);
      if (icon.type === 'image/png') expect(pngSize(file)).toBe(icon.sizes);
      else expect(read(file).length).toBeGreaterThan(0);
    }
    expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable')).toBe(true);
    expect(pngSize('public/icons/apple-touch-icon.png')).toBe('180x180');
    expect(pngSize('desktop/build/icon.png')).toBe('1024x1024');
  });

  it('is linked from both page shells', () => {
    const html = read('local/index.html').toString();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />');
    expect(html).toContain('href="/icons/apple-touch-icon.png"');
    const layout = read('app/layout.tsx').toString();
    expect(layout).toContain("manifest: '/manifest.webmanifest'");
    expect(layout).toContain("apple: '/icons/apple-touch-icon.png'");
  });
});
