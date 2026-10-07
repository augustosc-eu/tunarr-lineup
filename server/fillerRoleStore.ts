// What each Tunarr filler list is for (station IDs, commercials, promos…),
// kept by the companion in LINEUP_DATA_DIR/filler-roles.json. Tunarr's lists
// carry no such field, and encoding it in list names would rename the user's
// data in Tunarr.
import { isFillerRole, type FillerRole, type FillerRoles } from './fillerRoles.js';
import { createJsonFile, StoreError } from './jsonFile.js';

export const MAX_FILLER_ROLES = 1000;
const FILE = 'filler-roles.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FillerRoleStore = {
  readonly location: string;
  list(): Promise<FillerRoles>;
  set(listId: string, role: FillerRole): Promise<FillerRoles>;
  remove(listId: string): Promise<FillerRoles>;
};

export function createFillerRoleStore(dir: string): FillerRoleStore {
  const file = createJsonFile(dir, FILE, 'filler-list roles');

  async function read(): Promise<FillerRoles> {
    const data = (await file.read()) as { roles?: unknown } | undefined;
    const roles: FillerRoles = {};
    if (data && data.roles && typeof data.roles === 'object' && !Array.isArray(data.roles)) {
      // Drop anything a hand edit broke rather than failing the whole desk.
      for (const [id, role] of Object.entries(data.roles)) if (UUID.test(id) && isFillerRole(role)) roles[id] = role;
    }
    return roles;
  }

  const write = (roles: FillerRoles) => file.write({ version: 1, roles });

  return {
    location: file.location,
    list: () => file.serialize(read),
    set: (listId, role) => file.serialize(async () => {
      const roles = await read();
      if (!(listId in roles) && Object.keys(roles).length >= MAX_FILLER_ROLES) throw new StoreError(409, 'too_many_roles', `You can tag up to ${MAX_FILLER_ROLES} filler lists.`);
      roles[listId] = role;
      await write(roles);
      return roles;
    }),
    remove: (listId) => file.serialize(async () => {
      const roles = await read();
      if (!(listId in roles)) return roles;
      delete roles[listId];
      await write(roles);
      return roles;
    }),
  };
}
