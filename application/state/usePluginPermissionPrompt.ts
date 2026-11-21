import { useEffect, useRef, useState } from 'react';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';

export function usePluginPermissionPrompt() {
  const [prompts, setPrompts] = useState<QuollDeskPluginPermissionPrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const active = useRef<QuollDeskPluginPermissionPrompt | null>(null);
  const prompt = prompts[0];
  active.current = prompt ?? null;
  useEffect(() => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.onPluginPermission || !bridge.setPluginPermissionReady) return;
    const unsubscribe = bridge.onPluginPermission((event) => {
      setPrompts((previous) => 'closed' in event ? previous.filter((item) => item.requestId !== event.requestId)
        : [...previous.filter((item) => item.requestId !== event.requestId), event]);
      setBusy(false);
    });
    void bridge.setPluginPermissionReady(true).catch(() => {});
    return () => { unsubscribe(); void bridge.setPluginPermissionReady?.(false).catch(() => {}); };
  }, []);
  const respond = async (decision: 'allow' | 'deny' | 'cancel') => {
    if (!prompt || busy || active.current !== prompt) return;
    setBusy(true);
    try {
      const accepted = await quolldeskBridge.require().respondPluginPermission?.({ requestId: prompt.requestId, actionToken: prompt.actionToken, decision });
      if (!accepted) setPrompts((previous) => previous.filter((item) => item.requestId !== prompt.requestId));
    } catch { setPrompts((previous) => previous.filter((item) => item.requestId !== prompt.requestId)); }
    finally { setBusy(false); }
  };
  return { prompt, busy, respond };
}
