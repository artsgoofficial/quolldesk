import { useCallback, useEffect, useRef, useState } from 'react';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';
import { parsePluginGitHubRepository } from '@/domain/pluginGitHubRepository.cjs';

export function usePluginGitHubInstall(onInstalled: () => Promise<unknown>) {
  const [preview, setPreview] = useState<QuollDeskGitHubPluginPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const active = useRef(false);
  const mounted = useRef(true);
  const reset = useCallback(() => {
    const previous = token.current;
    token.current = null;
    setPreview(null);
    setError(null);
    if (previous) void quolldeskBridge.get()?.discardGitHubPlugin?.(previous).catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (token.current) void quolldeskBridge.get()?.discardGitHubPlugin?.(token.current).catch(() => {});
    };
  }, []);
  const run = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  return {
    preview, busy, error, reset,
    prepare: (input: string) => run(async () => {
      const { origin } = parsePluginGitHubRepository(input);
      const bridge = quolldeskBridge.require();
      if (!bridge.prepareGitHubPlugin) throw new Error('GitHub plugin installation unavailable');
      reset();
      const result = await bridge.prepareGitHubPlugin(origin);
      if (!mounted.current) { await bridge.discardGitHubPlugin?.(result.token); return; }
      token.current = result.token;
      setPreview(result);
    }),
    install: () => run(async () => {
      const bridge = quolldeskBridge.require();
      if (!bridge.installGitHubPlugin || !token.current) throw new Error('Download and review a GitHub plugin first');
      const selected = token.current;
      // The host consumes the selection even on failure; retry starts with a new review.
      token.current = null;
      setPreview(null);
      await bridge.installGitHubPlugin(selected);
      await onInstalled();
      window.dispatchEvent(new Event('quolldesk:plugin-packages-changed'));
    }),
  };
}
