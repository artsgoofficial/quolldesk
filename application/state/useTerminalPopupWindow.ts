import { useCallback } from 'react';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';
import type { TerminalPopupPayload } from '../../domain/systemManager/types';

export function useTerminalPopupWindow() {
  const close = useCallback(async () => {
    await quolldeskBridge.get()?.windowClose?.();
  }, []);

  const setWindowTitle = useCallback(async (title: string) => {
    await quolldeskBridge.get()?.setWindowTitle?.(title);
  }, []);

  const onPopupConfig = useCallback((cb: (payload: TerminalPopupPayload) => void) => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.onTerminalPopupConfig) return () => {};
    return bridge.onTerminalPopupConfig(cb);
  }, []);

  const markAttachClosePrepared = useCallback(async (sessionId: string, authorization: string) => {
    return quolldeskBridge.get()?.markAttachPopupClosePrepared?.(sessionId, authorization);
  }, []);

  const onPrepareClose = useCallback((cb: (payload: { sessionId: string; authorization: string }) => void) => {
    return quolldeskBridge.get()?.onTerminalPopupPrepareClose?.(cb) ?? (() => {});
  }, []);

  return { close, setWindowTitle, onPopupConfig, markAttachClosePrepared, onPrepareClose };
}
