// The companion's media folder (LINEUP_MEDIA_DIR): video files for filler
// lists, one subfolder per role (station IDs, commercials, promos…), and
// program videos (music videos, downloads) in named folders under
// music-videos/ and videos/ (owner decision 2026-10-27, D70). Tunarr
// reads the same folders as a local media source, so the folder must be
// mounted into both containers (LINEUP_MEDIA_TUNARR_DIR is where Tunarr sees
// it). Owner decision 2026-10-07: uploads are allowed here, and only here.
// Files are written under a temporary name and linked into place, so a file
// is never overwritten and a broken upload never leaves a partial video.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FILLER_ROLES, type FillerRole } from './fillerRoles.js';
import { StoreError } from './jsonFile.js';
import { VIDEO_KINDS, videoFolderName, type VideoKind } from './videoTitles.js';

/** Folder names on disk. Plain words, so they read well in Tunarr and a file manager. */
export const ROLE_FOLDERS: Record<FillerRole, string> = {
  'station-id': 'station-ids',
  commercials: 'commercials',
  promos: 'promos',
  bumpers: 'bumpers',
  other: 'other-filler',
};

export const VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.mov', '.avi', '.webm', '.ts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.flv'];
export const DEFAULT_MAX_UPLOAD_MB = 4096;
const MAX_NAME = 200;

export type MediaFile = { name: string; size: number; modifiedAt: number };

/** Where each kind of program video lives: named folders inside these. */
export const KIND_FOLDERS: Record<VideoKind, string> = { 'music-videos': 'music-videos', videos: 'videos' };
export const MAX_VIDEO_FOLDERS = 500;

export type VideoFolder = { kind: VideoKind; folder: string; files: MediaFile[] };

/** Program videos: one level of named folders per kind, each read by Tunarr as its own library. */
export type ProgramFolders = {
  /** The folder as Tunarr sees it (a local library's path). */
  tunarrPath(kind: VideoKind, folder: string): string;
  list(): Promise<VideoFolder[]>;
  /** The folders alone, without reading their files (the pickup runs every few seconds). */
  folders(): Promise<Array<{ kind: VideoKind; folder: string }>>;
  /** Makes an empty folder (so Tunarr can add it before anything is uploaded); an existing one is fine. */
  make(kind: VideoKind, folder: string): Promise<void>;
  save(kind: VideoKind, folder: string, name: string, body: Readable, length: number): Promise<MediaFile>;
  remove(kind: VideoKind, folder: string, name: string): Promise<void>;
  open(kind: VideoKind, folder: string, name: string): Promise<{ path: string; size: number; modifiedAt: number }>;
};

export type MediaFolder = {
  /** Changeable while running (Server Settings). */
  maxBytes: number;
  /** The role's folder as Tunarr sees it (a local library's path). */
  tunarrPath(role: FillerRole): string;
  /** Creates the role folders (so Tunarr can add them before anything is uploaded). */
  prepare(): Promise<void>;
  list(): Promise<Record<FillerRole, MediaFile[]>>;
  save(role: FillerRole, name: string, body: Readable, length: number): Promise<MediaFile>;
  move(role: FillerRole, name: string, to: FillerRole): Promise<void>;
  remove(role: FillerRole, name: string): Promise<void>;
  /** A file to play back in the browser (preview): its path and size. Never a symlink or a folder. */
  open(role: FillerRole, name: string): Promise<{ path: string; size: number; modifiedAt: number }>;
  programs: ProgramFolders;
};

/**
 * A safe video file name, or null. One path segment: no slashes, no leading
 * dot, no characters Windows or SMB shares refuse, and a video extension.
 */
export function mediaFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC');
  if (!name || name.length > MAX_NAME || name.startsWith('.') || /^\s|[.\s]$/.test(name)) return null;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) return null;
  return VIDEO_EXTENSIONS.includes(path.extname(name).toLowerCase()) ? name : null;
}

const isWindowsPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value);

/** Off (undefined) unless LINEUP_MEDIA_DIR is set; `{ off }` explains a bad setting. */
export function createMediaFolder(env: Record<string, string | undefined>): MediaFolder | { off: string } | undefined {
  const dir = env.LINEUP_MEDIA_DIR?.trim();
  if (!dir) return undefined;
  const tunarrDir = env.LINEUP_MEDIA_TUNARR_DIR?.trim() || path.resolve(dir);
  if (!tunarrDir.startsWith('/') && !isWindowsPath(tunarrDir)) return { off: 'The media folder as Tunarr sees it must be a full path, like /media/lineup (Setup → Server Settings).' };
  const megabytes = Number(env.LINEUP_MEDIA_MAX_MB);
  const maxBytes = (Number.isInteger(megabytes) && megabytes > 0 ? megabytes : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  return createMediaFolderAt(path.resolve(dir), tunarrDir, maxBytes);
}

export function createMediaFolderAt(root: string, tunarrRoot: string, maxBytes: number): MediaFolder {
  const join = isWindowsPath(tunarrRoot) ? path.win32.join : path.posix.join;
  const folder = (role: FillerRole) => path.join(root, ROLE_FOLDERS[role]);
  const programDir = (kind: VideoKind, name: string) => path.join(root, KIND_FOLDERS[kind], name);

  const notFound = () => new StoreError(404, 'not_found', 'That file is not in the media folder.');
  const unwritable = () => new StoreError(500, 'media_unwritable', 'The media folder could not be created. Check that the Lineup server can write to it.');
  const exists = async (file: string) => stat(file).then(() => true, () => false);

  /** Puts `from` at `to` without ever replacing a file already there. */
  async function placeNew(from: string, to: string) {
    try {
      await link(from, to);
      await unlink(from);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new StoreError(409, 'file_exists', `${path.basename(to)} is already there. Rename the file and try again.`);
      if (code === 'ENOENT') throw notFound();
      // Some shares (SMB, exFAT) have no hard links; check, then rename.
      if (await exists(to)) throw new StoreError(409, 'file_exists', `${path.basename(to)} is already there. Rename the file and try again.`);
      await rename(from, to);
    }
  }

  async function filesIn(dir: string, label: string): Promise<MediaFile[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StoreError(500, 'media_unreadable', `The ${label} folder could not be read. Check the media folder under Setup → Server Settings.`);
    }
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && mediaFileName(entry.name) === entry.name)
      .map(async (entry) => {
        const info = await stat(path.join(dir, entry.name)).catch(() => null);
        return info ? { name: entry.name, size: info.size, modifiedAt: info.mtimeMs } : null;
      }));
    return files.filter((file): file is MediaFile => !!file).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function saveIn(dir: string, name: string, body: Readable, length: number): Promise<MediaFile> {
    if (length > media.maxBytes) throw new StoreError(413, 'file_too_large', `Files can be up to ${Math.round(media.maxBytes / 1024 / 1024)} MB (LINEUP_MEDIA_MAX_MB).`);
    const target = path.join(dir, name);
    try {
      await mkdir(dir, { recursive: true });
    } catch {
      throw unwritable();
    }
    if (await exists(target)) throw new StoreError(409, 'file_exists', `${name} is already there. Rename the file and try again.`);
    // A dot name, so listings and Tunarr's scanner skip it until it is complete.
    const temp = path.join(dir, `.upload-${randomUUID()}.part`);
    let received = 0;
    try {
      await pipeline(
        body,
        async function* count(source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > length) throw new StoreError(400, 'upload_mismatch', 'More data arrived than the upload announced.');
            yield chunk;
          }
        },
        createWriteStream(temp, { flags: 'wx' }),
      );
      if (received !== length) throw new StoreError(400, 'upload_incomplete', 'The upload stopped before the whole file arrived.');
      await placeNew(temp, target);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new StoreError(500, 'media_unwritable', 'The file could not be saved. Check that the Lineup server can write to the media folder and that it has space.');
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
    const info = await stat(target);
    return { name, size: info.size, modifiedAt: info.mtimeMs };
  }

  async function openIn(dir: string, name: string) {
    const file = path.join(dir, name);
    const info = await lstat(file).catch(() => null);
    if (!info || !info.isFile()) throw notFound();
    return { path: file, size: info.size, modifiedAt: info.mtimeMs };
  }

  async function removeIn(dir: string, name: string) {
    try {
      await unlink(path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
      throw new StoreError(500, 'media_unwritable', 'The file could not be deleted.');
    }
  }

  /** A program folder that is really there: a directory, never a symlink out of the media folder. */
  async function programFolder(kind: VideoKind, name: string, create = false) {
    const dir = programDir(kind, name);
    const info = await lstat(dir).catch(() => null);
    if (info?.isDirectory()) return dir;
    if (info || !create) throw new StoreError(404, 'not_found', `There is no folder “${name}” in ${KIND_FOLDERS[kind]}.`);
    return dir;
  }

  const programs: ProgramFolders = {
    tunarrPath: (kind, name) => join(tunarrRoot, KIND_FOLDERS[kind], name),
    async list() {
      return Promise.all((await programs.folders()).map(async ({ kind, folder: name }) => ({ kind, folder: name, files: await filesIn(programDir(kind, name), name) })));
    },
    async folders() {
      const found: Array<{ kind: VideoKind; folder: string }> = [];
      for (const kind of VIDEO_KINDS) {
        let entries;
        try {
          entries = await readdir(path.join(root, KIND_FOLDERS[kind]), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw new StoreError(500, 'media_unreadable', `The ${KIND_FOLDERS[kind]} folder could not be read. Check the media folder under Setup → Server Settings.`);
        }
        const names = entries.filter((entry) => entry.isDirectory() && videoFolderName(entry.name) === entry.name).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
        for (const name of names.slice(0, MAX_VIDEO_FOLDERS)) found.push({ kind, folder: name });
      }
      return found;
    },
    async make(kind, name) {
      const existing = await lstat(programDir(kind, name)).catch(() => null);
      if (existing && !existing.isDirectory()) throw new StoreError(409, 'file_exists', `${name} is already there and isn’t a folder.`);
      if (!existing && (await programs.folders()).length >= MAX_VIDEO_FOLDERS) throw new StoreError(409, 'too_many_folders', `The media folder can hold up to ${MAX_VIDEO_FOLDERS} video folders.`);
      try {
        await mkdir(programDir(kind, name), { recursive: true });
      } catch {
        throw unwritable();
      }
    },
    save: async (kind, name, file, body, length) => saveIn(await programFolder(kind, name), file, body, length),
    remove: async (kind, name, file) => removeIn(await programFolder(kind, name), file),
    open: async (kind, name, file) => openIn(await programFolder(kind, name), file),
  };

  const media: MediaFolder = {
    maxBytes,
    tunarrPath: (role) => join(tunarrRoot, ROLE_FOLDERS[role]),
    async prepare() {
      try {
        await Promise.all(FILLER_ROLES.map((role) => mkdir(folder(role), { recursive: true })));
      } catch {
        throw unwritable();
      }
    },
    async list() {
      const entries = await Promise.all(FILLER_ROLES.map(async (role) => [role, await filesIn(folder(role), ROLE_FOLDERS[role])] as const));
      return Object.fromEntries(entries) as Record<FillerRole, MediaFile[]>;
    },
    save: (role, name, body, length) => saveIn(folder(role), name, body, length),
    async move(role, name, to) {
      if (role === to) return;
      try {
        await mkdir(folder(to), { recursive: true });
      } catch {
        throw unwritable();
      }
      await placeNew(path.join(folder(role), name), path.join(folder(to), name));
    },
    open: (role, name) => openIn(folder(role), name),
    remove: (role, name) => removeIn(folder(role), name),
    programs,
  };
  return media;
}
