import { describe, expect, it } from 'vitest';
import { APP_USER as SERVER_APP_USER } from '../server/auth';
import { APP_USER, companionEnv, configuredPort, ENV_TEMPLATE, newSetupCode, parseLineupEnv } from '../desktop/lineupEnv.mjs';

describe('desktop settings file (D58)', () => {
  it('reads KEY=value lines like a .env file', () => {
    expect(parseLineupEnv([
      '# comment',
      '',
      'TUNARR_URL=http://tunarr.local:8000',
      'export LINEUP_SCHEDULER=on',
      'LINEUP_PASSWORD="two words # not a comment"',
      "LINEUP_USERNAME='desk'",
      'LINEUP_AI_MODEL=gpt-x  # trailing comment',
      'lowercase=ignored',
      '=nokey',
      'NO_EQUALS',
    ].join('\r\n'))).toEqual({
      TUNARR_URL: 'http://tunarr.local:8000',
      LINEUP_SCHEDULER: 'on',
      LINEUP_PASSWORD: 'two words # not a comment',
      LINEUP_USERNAME: 'desk',
      LINEUP_AI_MODEL: 'gpt-x',
    });
  });

  it('starts with everything commented out', () => {
    expect(parseLineupEnv(ENV_TEMPLATE)).toEqual({});
  });

  it('listens on localhost only unless the file says otherwise', () => {
    const base = { processEnv: { HOST: '0.0.0.0', PORT: '80', TUNARR_URL: 'http://a:8000', UNSET: undefined }, dataDir: '/u/data', staticDir: '/r/dist-local', port: 47300 };
    const env = companionEnv({ ...base, fileEnv: {} });
    expect(env).toMatchObject({ HOST: '127.0.0.1', PORT: '47300', TUNARR_URL: 'http://a:8000', LINEUP_DATA_DIR: '/u/data', STATIC_DIR: '/r/dist-local' });
    expect('UNSET' in env).toBe(false);
    const shared = companionEnv({ ...base, fileEnv: { HOST: '0.0.0.0', TUNARR_URL: 'http://b:8000', LINEUP_DATA_DIR: '/elsewhere' } });
    expect(shared).toMatchObject({ HOST: '0.0.0.0', TUNARR_URL: 'http://b:8000', LINEUP_DATA_DIR: '/elsewhere' });
  });

  it('hands the companion this launch’s app key and setup code (D62)', () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    const env = companionEnv({ processEnv: { LINEUP_APP_KEY: 'stale' }, fileEnv: {}, dataDir: '/u/data', staticDir: '/r', port: 1, appKey: 'k1', setupCode: code });
    expect(env).toMatchObject({ LINEUP_APP_KEY: 'k1', LINEUP_SETUP_CODE: code });
    expect(APP_USER).toBe(SERVER_APP_USER);
    // The template no longer asks for Tunarr's address or a password.
    expect(ENV_TEMPLATE).not.toMatch(/TUNARR_URL|LINEUP_PASSWORD/);
  });

  it('takes a valid PORT from the file, or leaves it to the app', () => {
    expect(configuredPort({ PORT: '3000' })).toBe(3000);
    expect(configuredPort({ PORT: 'x' })).toBeNull();
    expect(configuredPort({ PORT: '70000' })).toBeNull();
    expect(configuredPort({})).toBeNull();
  });
});
