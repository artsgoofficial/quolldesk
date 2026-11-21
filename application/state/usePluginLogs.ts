import { useCallback, useEffect, useRef, useState } from 'react';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';

export function usePluginLogs() {
  const [status, setStatus] = useState<QuollDeskPluginLogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const run = useCallback(async (action: 'status' | 'configure' | 'open' | 'export' | 'clear', settings?: { saveToDisk: boolean; verbose: boolean }) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const bridge = quolldeskBridge.require();
      const result = await (action === 'configure' ? bridge.configurePluginLogs?.(settings!)
        : action === 'open' ? bridge.openPluginLogFolder?.()
          : action === 'export' ? bridge.exportPluginLogs?.()
            : action === 'clear' ? bridge.clearPluginLogs?.() : bridge.getPluginLogStatus?.());
      if (!result) throw new Error('Local plugin logging is unavailable');
      if (mounted.current) setStatus(result);
    } catch (cause) {
      let message = cause instanceof Error ? cause.message : String(cause);
      if (action === 'configure') {
        // Configuration fails closed before disk I/O. Show actual host state,
        // even when persisting a setting failed, rather than keeping stale ON.
        try {
          const actual = await quolldeskBridge.require().getPluginLogStatus?.();
          if (!actual) throw new Error('Local plugin log status is unavailable');
          if (mounted.current) setStatus(actual);
        } catch (refreshError) {
          if (mounted.current) setStatus(null);
          message += `\n${refreshError instanceof Error ? refreshError.message : String(refreshError)}`;
        }
      }
      if (mounted.current) setError(message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void run('status');
    return () => { mounted.current = false; };
  }, [run]);
  return { status, error, busy, run };
}
