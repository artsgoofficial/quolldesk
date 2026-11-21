import { useCallback } from "react";
import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";

export const useTrayPanelBackend = () => {
  const hideTrayPanel = useCallback(async () => {
    const bridge = quolldeskBridge.get();
    await bridge?.hideTrayPanel?.();
  }, []);

  const openMainWindow = useCallback(async () => {
    const bridge = quolldeskBridge.get();
    await bridge?.openMainWindow?.();
  }, []);

  const quitApp = useCallback(async () => {
    const bridge = quolldeskBridge.get();
    await bridge?.quitApp?.();
  }, []);

  const jumpToSession = useCallback(async (sessionId: string) => {
    const bridge = quolldeskBridge.get();
    await bridge?.jumpToSessionFromTrayPanel?.(sessionId);
  }, []);

  const closeSessionFromTrayPanel = useCallback(async (sessionId: string) => {
    const bridge = quolldeskBridge.get();
    await bridge?.closeSessionFromTrayPanel?.(sessionId);
  }, []);

  const connectToHostFromTrayPanel = useCallback(async (hostId: string) => {
    const bridge = quolldeskBridge.get();
    await bridge?.connectToHostFromTrayPanel?.(hostId);
  }, []);

  const startPortForwardFromTrayPanel = useCallback(async (ruleId: string) => {
    const bridge = quolldeskBridge.get();
    return bridge?.startPortForwardFromTrayPanel?.(ruleId);
  }, []);

  const onTrayPanelCloseRequest = useCallback((callback: () => void) => {
    const bridge = quolldeskBridge.get();
    return bridge?.onTrayPanelCloseRequest?.(callback);
  }, []);

  const onTrayPanelRefresh = useCallback((callback: () => void) => {
    const bridge = quolldeskBridge.get();
    return bridge?.onTrayPanelRefresh?.(callback);
  }, []);

  const onTrayPanelMenuData = useCallback(
    (
      callback: (data: {
        sessions?: Array<{ id: string; label: string; hostLabel: string; status: "connecting" | "connected" | "disconnected"; workspaceId?: string; workspaceTitle?: string }>;
        portForwardRules?: Array<{
          id: string;
          label: string;
          type: "local" | "remote" | "dynamic";
          localPort: number;
          remoteHost?: string;
          remotePort?: number;
          status: "inactive" | "connecting" | "active" | "error";
          hostId?: string;
          canStop?: boolean;
        }>;
      }) => void,
    ) => {
      const bridge = quolldeskBridge.get();
      return bridge?.onTrayPanelMenuData?.(callback);
    },
    [],
  );

  return {
    hideTrayPanel,
    openMainWindow,
    quitApp,
    jumpToSession,
    closeSessionFromTrayPanel,
    startPortForwardFromTrayPanel,
    connectToHostFromTrayPanel,
    onTrayPanelCloseRequest,
    onTrayPanelRefresh,
    onTrayPanelMenuData,
  };
};
