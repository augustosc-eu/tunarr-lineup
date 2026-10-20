import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SKIN, isSkinId, parseSkin, SKIN_STORAGE_KEY, SKINS } from '../lib/skins';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const initScript = readFileSync(new URL('../public/skin-init.js', import.meta.url), 'utf8');

/** Runs public/skin-init.js against a fake document and storage; returns the data-skin it set. */
function runInit(storage: { getItem: (key: string) => string | null } | 'throws') {
  const attributes: Record<string, string> = {};
  const window = {
    get localStorage() {
      if (storage === 'throws') throw new Error('SecurityError');
      return storage;
    },
  };
  const document = { documentElement: { setAttribute: (name: string, value: string) => { attributes[name] = value; } } };
  runInNewContext(initScript, { window, document });
  return attributes['data-skin'];
}

/** The custom properties declared in a rule body. */
const declared = (body: string) => new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
const ruleBody = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('\n}', start));
};

describe('skins', () => {
  it('lists four skins with Platinum as the default', () => {
    expect(SKINS.map((skin) => skin.id)).toEqual(['platinum', 'windows', 'modern', 'broadcast']);
    expect(DEFAULT_SKIN).toBe('platinum');
    expect(SKIN_STORAGE_KEY).toBe('tunarr-lineup-skin');
    for (const skin of SKINS) expect(skin.name && skin.description).toBeTruthy();
  });

  it('accepts only known skin ids and falls back to Platinum', () => {
    for (const skin of SKINS) {
      expect(isSkinId(skin.id)).toBe(true);
      expect(parseSkin(skin.id)).toBe(skin.id);
    }
    for (const value of [null, undefined, '', 'Platinum', 'dark', 'windows ', 42, {}, ['modern'], 'constructor', '__proto__']) {
      expect(isSkinId(value)).toBe(false);
      expect(parseSkin(value)).toBe('platinum');
    }
  });

  it('applies the stored skin before React starts, with the same list and key', () => {
    for (const skin of SKINS) expect(runInit({ getItem: (key) => (key === SKIN_STORAGE_KEY ? skin.id : null) })).toBe(skin.id);
    expect(runInit({ getItem: () => null })).toBe('platinum');
    expect(runInit({ getItem: () => 'neon' })).toBe('platinum');
    expect(runInit({ getItem: () => { throw new Error('blocked'); } })).toBe('platinum');
    expect(runInit('throws')).toBe('platinum');
    // It's a plain same-origin script: nothing fetched, no inline code needed.
    expect(initScript).not.toMatch(/fetch|XMLHttpRequest|import\(|https?:/);
  });

  it('styles every skin with tokens Platinum defines, and defines every token it uses', () => {
    const root = new Set([...css.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap((match) => [...declared(match[1])]));
    for (const skin of SKINS.filter((item) => item.id !== DEFAULT_SKIN)) {
      const overrides = declared(ruleBody(`:root[data-skin="${skin.id}"]`));
      expect(overrides.size).toBeGreaterThan(40);
      expect([...overrides].filter((token) => !root.has(token)), `${skin.id} overrides unknown tokens`).toEqual([]);
    }
    const everyDeclared = declared(css);
    // Set by Next's font loader in the hosted build only (Platinum's stack, kept as it was).
    everyDeclared.add('--font-geist-sans');
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    expect([...used].filter((token) => !everyDeclared.has(token))).toEqual([]);
  });

  it('keeps Platinum’s exact shades, aliased to role tokens in every other skin', () => {
    const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
    const shades = root.slice(root.indexOf("/* Platinum's exact shades"), root.indexOf('/* Menu bar height'));
    const shadeTokens = [...declared(shades)];
    expect(shadeTokens.length).toBeGreaterThan(30);
    const aliases = ruleBody(':root:is([data-skin="windows"],[data-skin="modern"],[data-skin="broadcast"])');
    expect([...declared(aliases)].sort()).toEqual(shadeTokens.sort());
    // Each alias points at a role token, never at a literal colour.
    for (const line of aliases.split('\n').filter((text) => text.includes('--') && text.includes(':'))) expect(line).toMatch(/:var\(--[a-z0-9-]+\);$/);
  });

  it('gives only Broadcast Console a dark color scheme, and keeps type at least 13px', () => {
    expect(ruleBody(':root[data-skin="broadcast"]')).toContain('color-scheme:dark');
    for (const id of ['windows', 'modern']) expect(ruleBody(`:root[data-skin="${id}"]`)).not.toContain('color-scheme');
    expect(css).not.toMatch(/font-smoothing:\s*none/);
    expect(css).not.toMatch(/font-size:\s*(?:[0-9]|1[0-2])px/);
  });
});
