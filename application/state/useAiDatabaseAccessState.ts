import { useCallback, useEffect, useState } from 'react';
import {
  readAiDatabaseAccessEnabled,
  writeAiDatabaseAccessEnabled,
} from '../../infrastructure/config/aiDatabaseAccess';
import { STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED } from '../../infrastructure/config/storageKeys';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';
import { AI_STATE_CHANGED_EVENT, emitAIStateChanged } from './aiStateEvents';

/**
 * Master switch for AI/MCP database access (spec §6). Enabled by default;
 * disabled filters the database.* / redis.* capability tools on both surfaces
 * (built-in agent tools + MCP server tool listing via a flag sync to main).
 */
export function useAiDatabaseAccessState() {
  const [enabled, setEnabledState] = useState<boolean>(() => readAiDatabaseAccessEnabled());

  // Keep in sync with other windows/components via aiStateEvents.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string }>).detail;
      if (detail?.key && detail.key !== STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED) return;
      setEnabledState(readAiDatabaseAccessEnabled());
    };
    window.addEventListener('storage', handler);
    window.addEventListener(AI_STATE_CHANGED_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(AI_STATE_CHANGED_EVENT, handler as EventListener);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    writeAiDatabaseAccessEnabled(next);
    setEnabledState(next);
    emitAIStateChanged(STORAGE_KEY_AI_DATABASE_ACCESS_ENABLED);
    // Push the flag to the main process so the MCP server filters the tools too.
    void quolldeskBridge.get()?.setAiDatabaseAccessEnabled?.(next);
  }, []);

  // Boot sync: if the switch was left off, push it at startup (the MCP server
  // defaults to enabled before any settings UI has run).
  useEffect(() => {
    if (!readAiDatabaseAccessEnabled()) {
      void quolldeskBridge.get()?.setAiDatabaseAccessEnabled?.(false);
    }
  }, []);

  return { enabled, setEnabled };
}
