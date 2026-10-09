// The companion's media folder (LINEUP_MEDIA_DIR): video files for filler
// lists, one subfolder per role (station IDs, commercials, promos…). Tunarr
// reads the same folders as a local media source, so the folder must be
// mounted into both containers (LINEUP_MEDIA_TUNARR_DIR is where Tunarr sees
// it). Owner decision 2026-10-07: uploads are allowed here, and only here.
// Files are written under a temporary name and linked into place, so a file
// is never overwritten and a broken upload never leaves a partial video.
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FILLER_ROLES, type FillerRole } from './fillerRoles.js';
import { StoreError } from './jsonFile.js';

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

export type MediaFolder = {
  readonly maxBytes: number;
  /** The role's folder as Tunarr sees it (a local library's path). */
  tunarrPath(role: FillerRole): string;
  /** Creates the role folders (so Tunarr can add them before anything is uploaded). */
  prepare(): Promise<void>;
  list(): Promise<Record<FillerRole, MediaFile[]>>;
  save(role: FillerRole, name: string, body: Readable, length: number): Promise<MediaFile>;
  move(role: FillerRole, name: string, to: FillerRole): Promise<void>;
  remove(role: FillerRole, name: string): Promise<void>;
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
  if (!tunarrDir.startsWith('/') && !isWindowsPath(tunarrDir)) return { off: 'LINEUP_MEDIA_TUNARR_DIR must be a full path, like /media/lineup.' };
  const megabytes = Number(env.LINEUP_MEDIA_MAX_MB);
  const maxBytes = (Number.isInteger(megabytes) && megabytes > 0 ? megabytes : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024;
  return createMediaFolderAt(path.resolve(dir), tunarrDir, maxBytes);
}

export function createMediaFolderAt(root: string, tunarrRoot: string, maxBytes: number): MediaFolder {
  const join = isWindowsPath(tunarrRoot) ? path.win32.join : path.posix.join;
  const folder = (role: FillerRole) => path.join(root, ROLE_FOLDERS[role]);

  const notFound = () => new StoreError(404, 'not_found', 'That file is not in the media folder.');
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

  async function filesIn(role: FillerRole): Promise<MediaFile[]> {
    let entries;
    try {
      entries = await readdir(folder(role), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StoreError(500, 'media_unreadable', `The ${ROLE_FOLDERS[role]} folder could not be read. Check LINEUP_MEDIA_DIR.`);
    }
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && mediaFileName(entry.name) === entry.name)
      .map(async (entry) => {
        const info = await stat(path.join(folder(role), entry.name)).catch(() => null);
        return info ? { name: entry.name, size: info.size, modifiedAt: info.mtimeMs } : null;
      }));
    return files.filter((file): file is MediaFile => !!file).sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    maxBytes,
    tunarrPath: (role) => join(tunarrRoot, ROLE_FOLDERS[role]),
    async prepare() {
      try {
        await Promise.all(FILLER_ROLES.map((role) => mkdir(folder(role), { recursive: true })));
      } catch {
        throw new StoreError(500, 'media_unwritable', 'The media folder could not be created. Check that LINEUP_MEDIA_DIR is writable.');
      }
    },
    async list() {
      const entries = await Promise.all(FILLER_ROLES.map(async (role) => [role, await filesIn(role)] as const));
      return Object.fromEntries(entries) as Record<FillerRole, MediaFile[]>;
    },
    async save(role, name, body, length) {
      if (length > maxBytes) throw new StoreError(413, 'file_too_large', `Files can be up to ${Math.round(maxBytes / 1024 / 1024)} MB (LINEUP_MEDIA_MAX_MB).`);
      const dir = folder(role);
      const target = path.join(dir, name);
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        throw new StoreError(500, 'media_unwritable', 'The media folder could not be created. Check that LINEUP_MEDIA_DIR is writable.');
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
        throw new StoreError(500, 'media_unwritable', 'The file could not be saved. Check that LINEUP_MEDIA_DIR is writable and has space.');
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
      const info = await stat(target);
      return { name, size: info.size, modifiedAt: info.mtimeMs };
    },
    async move(role, name, to) {
      if (role === to) return;
      try {
        await mkdir(folder(to), { recursive: true });
      } catch {
        throw new StoreError(500, 'media_unwritable', 'The media folder could not be created. Check that LINEUP_MEDIA_DIR is writable.');
      }
      await placeNew(path.join(folder(role), name), path.join(folder(to), name));
    },
    async remove(role, name) {
      try {
        await unlink(path.join(folder(role), name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound();
        throw new StoreError(500, 'media_unwritable', 'The file could not be deleted.');
      }
    },
  };
}
