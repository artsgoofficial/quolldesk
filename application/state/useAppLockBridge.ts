import { useCallback } from 'react';

import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';
import type { RuntimeAppLockReason } from './useAppLockRuntime';

let rendererReadySent = false;

export function useAppLockBridge() {
  const getRuntimeState = useCallback(async () => {
    return quolldeskBridge.get()?.getAppLockRuntimeState?.();
  }, []);

  const getSettings = useCallback(async () => {
    return quolldeskBridge.get()?.getAppLockSettings?.();
  }, []);

  const setRuntimeLocked = useCallback(async (reason: Exclude<RuntimeAppLockReason, null>) => {
    return quolldeskBridge.get()?.setAppLockRuntimeLocked?.(reason);
  }, []);

  const requestUnlock = useCallback(async (password: string) => {
    return quolldeskBridge.get()?.requestAppLockUnlock?.(password) ?? { ok: false as const, error: 'incorrect' as const };
  }, []);

  const requestReset = useCallback(async (currentPassword: string) => {
    return quolldeskBridge.get()?.requestAppLockReset?.(currentPassword);
  }, []);

  const reportActivity = useCallback(async () => {
    await quolldeskBridge.get()?.reportAppLockActivity?.();
  }, []);

  const onRuntimeStateChanged = useCallback((listener: (state: unknown) => void) => {
    try {
      return quolldeskBridge.get()?.onAppLockRuntimeStateChanged?.(listener) ?? (() => {});
    } catch {
      return () => {};
    }
  }, []);

  const onSettingsChanged = useCallback((listener: (settings: unknown) => void) => {
    try {
      return quolldeskBridge.get()?.onAppLockSettingsChanged?.(listener) ?? (() => {});
    } catch {
      return () => {};
    }
  }, []);

  const notifyRendererReady = useCallback(() => {
    if (rendererReadySent) return;
    rendererReadySent = true;
    try {
      quolldeskBridge.get()?.rendererReady?.();
    } catch {
      // ignore
    }
  }, []);

  const onAppLockReopen = useCallback((listener: () => void) => {
    try {
      return quolldeskBridge.get()?.onAppLockReopen?.(listener) ?? (() => {});
    } catch {
      return () => {};
    }
  }, []);

  return {
    getRuntimeState,
    getSettings,
    setRuntimeLocked,
    requestUnlock,
    requestReset,
    reportActivity,
    onRuntimeStateChanged,
    onSettingsChanged,
    notifyRendererReady,
    onAppLockReopen,
  };
}
