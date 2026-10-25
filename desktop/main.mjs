// @ts-check
// Desktop shell for Tunarr Lineup (D58). Runs the companion (dist-server) in
// Electron's own Node and shows the desk in a window that is an ordinary,
// sandboxed browser of the companion's origin: the page still calls only
// same-origin /api/tunarr/*. Tunarr's address and the other settings are set in
// the setup wizard and kept by the companion (config.json, D62); lineup.env only
// says where it listens (an older one is imported once). The window signs in
// with a per-launch app key and opens the wizard with its setup code.
import { app, BrowserWindow, dialog, Menu, shell, utilityProcess } from 'electron';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { APP_USER, companionEnv, configuredPort, ENV_TEMPLATE, newSetupCode, parseLineupEnv } from './lineupEnv.mjs';

// Drafts and the skin live in the window's storage, which is per origin, so the
// port is kept between launches and only changes when it's taken.
const DEFAULT_PORT = 47_300;

const userData = app.getPath('userData');
const envPath = path.join(userData, 'lineup.env');
const statePath = path.join(userData, 'desktop.json');
const logPath = path.join(userData, 'logs', 'lineup.log');
// Packaged: resources/companion (dist-server, dist-local and a type:module package.json). Dev: the repo root.
const companionRoot = app.isPackaged ? path.join(process.resourcesPath, 'companion') : path.resolve(app.getAppPath(), '..');

/** @type {Electron.UtilityProcess | null} */
let companion = null;
/** @type {BrowserWindow | null} */
let win = null;
let origin = '';
/** @type {Record<string, string>} */
let fileEnv = {};
let quitting = false;
// Never written anywhere: the companion gets them in its environment, the window only the code.
const appKey = randomBytes(24).toString('base64url');
const setupCode = newSetupCode();

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function readSettings() {
  if (!existsSync(envPath)) writeFileSync(envPath, ENV_TEMPLATE, { mode: 0o600 });
  return parseLineupEnv(readFileSync(envPath, 'utf8'));
}

/** @param {number} port */
function isFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer().once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** @returns {Promise<number>} */
function anyFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}

async function choosePort() {
  const fixed = configuredPort(fileEnv);
  if (fixed) return fixed;
  const saved = Number(readState().port) || DEFAULT_PORT;
  const port = (await isFree(saved)) ? saved : await anyFreePort();
  writeFileSync(statePath, JSON.stringify({ port }));
  return port;
}

/** @param {number} port @param {Electron.UtilityProcess} child */
async function waitUntilUp(port, child) {
  let exited = false;
  child.once('exit', () => { exited = true; });
  for (let i = 0; i < 150 && !exited; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(exited ? 'The Lineup server stopped while starting.' : 'The Lineup server did not start within 15 seconds.');
}

async function startCompanion() {
  fileEnv = readSettings();
  const port = await choosePort();
  mkdirSync(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = utilityProcess.fork(path.join(companionRoot, 'dist-server', 'main.js'), [], {
    serviceName: 'Tunarr Lineup server',
    stdio: 'pipe',
    env: companionEnv({ processEnv: process.env, fileEnv, dataDir: path.join(userData, 'data'), staticDir: path.join(companionRoot, 'dist-local'), port, appKey, setupCode }),
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once('exit', (code) => {
    if (companion === child) companion = null;
    if (!quitting && code !== 0) console.error(`[lineup] server exited with ${code}`);
  });
  companion = child;
  await waitUntilUp(port, child);
  origin = `http://127.0.0.1:${port}`;
}

function stopCompanion() {
  const child = companion;
  companion = null;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}

/** @param {unknown} error */
async function showStartError(error) {
  let tail = '';
  try { tail = readFileSync(logPath, 'utf8').split('\n').slice(-12).join('\n'); } catch { /* no log yet */ }
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
    detail: `${tail}\n\nSettings: ${envPath}`,
    buttons: ['Open Settings File', 'Try Again', 'Quit'],
    defaultId: 1,
    cancelId: 2,
  });
  if (response === 0) await shell.openPath(envPath);
  if (response === 2) return app.quit();
  await restart();
}

/** @param {string} url */
const isOwn = (url) => url === origin || url.startsWith(`${origin}/`);

/** @param {string} url */
function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 480,
    title: 'Tunarr Lineup',
    backgroundColor: '#637fac',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // The window stays on the companion; anything else opens in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwn(url)) return;
    event.preventDefault();
    openExternal(url);
  });
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });
  win.loadURL(startUrl());
}

/** The desk, with the setup code for the wizard (the page drops it from the address). */
const startUrl = () => `${origin}/#setup=${setupCode}`;

async function restart() {
  await stopCompanion();
  try {
    await startCompanion();
  } catch (error) {
    return showStartError(error);
  }
  if (win) win.loadURL(startUrl());
  else createWindow();
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(mac ? [{ role: /** @type {const} */ ('appMenu') }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Settings File…', click: () => shell.openPath(envPath) },
        { label: 'Restart Lineup Server', click: () => restart() },
        { type: 'separator' },
        { label: 'Show Data Folder', click: () => shell.openPath(userData) },
        { label: 'Show Server Log', click: () => shell.showItemInFolder(logPath) },
        ...(mac ? [] : [{ type: /** @type {const} */ ('separator') }, { role: /** @type {const} */ ('quit') }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(mac ? [{ role: /** @type {const} */ ('windowMenu') }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // Sign the window in to its own companion only, with this launch's app key.
  app.on('login', (event, _contents, details, _authInfo, callback) => {
    if (!isOwn(details.url)) return;
    event.preventDefault();
    callback(APP_USER, appKey);
  });

  app.whenReady().then(async () => {
    buildMenu();
    try {
      await startCompanion();
    } catch (error) {
      return showStartError(error);
    }
    createWindow();
  });

  // On macOS the app (and the scheduler) keeps running with the window closed, as Mac apps do.
  app.on('activate', () => { if (!win && origin) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    if (quitting || !companion) return;
    quitting = true;
    event.preventDefault();
    stopCompanion().finally(() => app.quit());
  });
}
