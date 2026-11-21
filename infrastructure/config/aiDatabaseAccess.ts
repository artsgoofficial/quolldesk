import { localStorageAdapter } from '../persistence/localStorageAdapter';
import { STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED } from './storageKeys';

/**
 * Master switch for AI/MCP database access (spec §6): enabled by default;
 * disabling filters the database.* / redis.* capability tools from the
 * built-in agent toolset and (via an IPC flag sync) the MCP server listing.
 * Pure reads so per-turn tool building can consult it outside React.
 */
export function readAiDatabaseAccessEnabled(): boolean {
  try {
    return localStorageAdapter.readBoolean(STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED) !== false;
  } catch {
    // localStorage can be unavailable in bare test environments — default to
    // enabled rather than breaking the turn/tool-build path.
    return true;
  }
}

export function writeAiDatabaseAccessEnabled(enabled: boolean): void {
  localStorageAdapter.writeBoolean(STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED, enabled);
}
