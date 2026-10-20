// Applies the saved skin (View → Appearance…) before the page paints, so a reload
// doesn't flash Platinum first. Loaded as a same-origin file because the companion's
// CSP allows no inline script. Keep the list and key in step with lib/skins.ts.
(() => {
  const skins = ['platinum', 'windows', 'modern', 'broadcast'];
  let skin = 'platinum';
  try {
    const stored = window.localStorage.getItem('tunarr-lineup-skin');
    if (skins.includes(stored)) skin = stored;
  } catch {
    // Storage blocked (private mode, sandboxed frame): keep the default.
  }
  document.documentElement.setAttribute('data-skin', skin);
})();
