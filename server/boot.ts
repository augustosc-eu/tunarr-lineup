// Starting the companion's state, shared by server/main.ts and the dev server
// (vite.local.config.ts): config.json (read, or imported once from the
// environment, D62), the setup state and the proxy config built from them.
import path from 'node:path';
import { configEnv, createConfigStore, ignoredEnv, importEnv, savedAiModel } from './configStore.js';
import { createHostPolicy } from './hosts.js';
import { createSetup } from './setup.js';
import { createProxyConfig, loadSavedSettings } from './tunarrProxy.js';

export async function bootCompanion(env: Record<string, string | undefined>, staticDir?: string) {
  const dataDir = path.resolve(env.LINEUP_DATA_DIR?.trim() || 'data');
  // A config.json that can't be read stops the server rather than being replaced.
  const store = createConfigStore(dataDir);
  let stored = await store.read();
  const notes: string[] = [];
  if (!stored) {
    stored = await importEnv(env);
    if (stored.importedFromEnv?.length) {
      await store.write(stored);
      notes.push(`Copied ${stored.importedFromEnv.join(', ')} from the environment into config.json. Change them under Setup → Server Settings from now on.`);
    }
  } else {
    const ignored = ignoredEnv(env);
    if (ignored.length) notes.push(`Ignoring ${ignored.join(', ')} from the environment: Lineup keeps these in config.json now. Change them under Setup → Server Settings, and remove them from your .env or compose file.`);
  }
  // The AI model used to be a desk setting (settings.json); it is part of AI setup now.
  const legacyModel = await savedAiModel(dataDir);
  if (legacyModel && !stored.values.LINEUP_AI_MODEL) {
    stored = { ...stored, values: { ...stored.values, LINEUP_AI_MODEL: legacyModel } };
    await store.write(stored);
  }
  const setup = createSetup({
    store, stored, processEnv: env, dataDir, staticDir,
    // The desktop app passes its window's key and the code it opens the window with.
    appKey: env.LINEUP_APP_KEY || undefined, code: env.LINEUP_SETUP_CODE || undefined,
  });
  const config = createProxyConfig(configEnv(env, stored.values));
  config.setup = setup;
  // Settings changed from the desk win over the setup values; a broken settings.json is reported, not overwritten.
  await loadSavedSettings(config).catch((error) => console.error('[settings]', error instanceof Error ? error.message : error));
  // Rewriting settings.json drops the moved model, so it is copied only once.
  if (legacyModel) await config.settings?.update({}).catch(() => undefined);
  return { config, setup, store, hosts: createHostPolicy(env), notes };
}

/** The box the log shows until setup is done. */
export function setupBanner(code: string) {
  return [
    '',
    '  ┌──────────────────────────────────────────────────┐',
    '  │  Lineup needs setting up. Open it in a browser   │',
    `  │  and enter this setup code:  ${code}         │`,
    '  └──────────────────────────────────────────────────┘',
    '',
  ].join('\n');
}
