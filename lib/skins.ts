// Skins: how the whole desk looks (View → Appearance…). A skin is only a name for a
// set of CSS custom properties in app/globals.css, applied as <html data-skin="…">.
// The choice is the browser's own: it's kept in localStorage, never sent anywhere.

export type SkinId = 'platinum' | 'windows' | 'modern' | 'broadcast';

export type Skin = { id: SkinId; name: string; description: string };

export const SKINS: readonly Skin[] = [
  { id: 'platinum', name: 'Platinum', description: 'The classic Mac OS 9 desk: platinum chrome, striped title bars and 1px bevels. The default.' },
  { id: 'windows', name: 'Classic Windows', description: 'A Windows 95/98-style desktop: teal background, gray 3D chrome and navy title bars.' },
  { id: 'modern', name: 'Modern Studio', description: 'Light and contemporary: neutral surfaces, restrained blue accents and soft shadows.' },
  { id: 'broadcast', name: 'Broadcast Console', description: 'A dark control room: charcoal panels, cyan selection, amber times and red for on air.' },
];

export const DEFAULT_SKIN: SkinId = 'platinum';

/** The localStorage key. public/skin-init.js reads the same key before React starts. */
export const SKIN_STORAGE_KEY = 'tunarr-lineup-skin';

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === 'string' && SKINS.some((skin) => skin.id === value);
}

/** Anything stored (or nothing) becomes a known skin; unknown values fall back to Platinum. */
export function parseSkin(value: unknown): SkinId {
  return isSkinId(value) ? value : DEFAULT_SKIN;
}
