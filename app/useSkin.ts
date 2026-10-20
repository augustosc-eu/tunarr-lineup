'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SKIN, parseSkin, SKIN_STORAGE_KEY, type SkinId } from '../lib/skins';

// Storage can be missing (server render) or throw (blocked site data, sandboxed
// frames); the desk then just uses Platinum and doesn't remember the choice.
export function readStoredSkin(): SkinId {
  try {
    return parseSkin(window.localStorage.getItem(SKIN_STORAGE_KEY));
  } catch {
    return DEFAULT_SKIN;
  }
}

function storeSkin(skin: SkinId) {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, skin);
  } catch {
    // Not remembered, but still applied for this visit.
  }
}

function applySkin(skin: SkinId) {
  document.documentElement.dataset.skin = skin;
}

/** The active skin, applied to <html data-skin> and kept in this browser only. */
export function useSkin() {
  const [skin, setSkinState] = useState<SkinId>(() => (typeof window === 'undefined' ? DEFAULT_SKIN : readStoredSkin()));

  // public/skin-init.js normally set this before React started; this covers a
  // missing script and keeps <html> in step with state.
  useEffect(() => { applySkin(skin); }, [skin]);

  const setSkin = useCallback((next: SkinId) => {
    applySkin(next);
    storeSkin(next);
    setSkinState(next);
  }, []);

  return { skin, setSkin };
}
