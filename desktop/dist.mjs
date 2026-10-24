// Packages the desktop app with electron-builder, versioned like the rest of
// Lineup (the root package.json), from the companion build in ../dist-server and
// ../dist-local (run `npm run build:local` first). Extra arguments go to
// electron-builder, e.g. `npm run dist -- --mac` or `-- --linux AppImage`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const dir of ['dist-server', 'dist-local']) {
  if (!existsSync(path.join(here, '..', dir))) {
    console.error(`../${dir} is missing: run \`npm run build:local\` in the repository root first.`);
    process.exit(1);
  }
}
const { version } = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const bin = path.join(here, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const result = spawnSync(bin, ['--publish', 'never', `-c.extraMetadata.version=${version}`, ...process.argv.slice(2)], {
  cwd: here,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
