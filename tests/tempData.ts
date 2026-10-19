// A throwaway LINEUP_DATA_DIR for tests that build a full proxy config, so
// snapshots and other stores never write into the repository's ./data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const testDataDir = mkdtempSync(path.join(tmpdir(), 'lineup-test-data-'));
