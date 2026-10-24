// `npm start`: runs the desktop app from the repo (after `npm run build:local`
// in the root). Clears ELECTRON_RUN_AS_NODE, which terminals inside Electron
// editors such as VS Code set and which would start Electron as plain Node.
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(String(electron), ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
