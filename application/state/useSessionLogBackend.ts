import { useCallback } from "react";
import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";

type ManualChoosePathPayload = {
  sessionId: string;
  sessionName?: string;
  preferredDirectory?: string;
  format?: "txt" | "raw" | "html";
};

type ManualStartPayload = {
  sessionId: string;
  sessionName?: string;
  preferredDirectory?: string;
  /**
   * Opaque token from chooseManualSessionLogPath. Required for the post-dialog
   * second phase; raw file paths from the renderer are rejected.
   */
  selectionToken?: string;
  format?: "txt" | "raw" | "html";
  timestampsEnabled?: boolean;
  initialLine?: string;
  alternateScreenActive?: boolean;
};

type ManualStopPayload = {
  sessionId: string;
};

type ManualStatusPayload = {
  sessionId: string;
};

export const useSessionLogBackend = () => {
  const chooseManualSessionLogPath = useCallback(async (payload: ManualChoosePathPayload) => {
    const bridge = quolldeskBridge.get();
    return bridge?.chooseManualSessionLogPath?.(payload)
      ?? { success: false, canceled: false, error: "Session log bridge unavailable" };
  }, []);

  const startManualSessionLog = useCallback(async (payload: ManualStartPayload) => {
    const bridge = quolldeskBridge.get();
    return bridge?.startManualSessionLog?.(payload) ?? { success: false, started: false, error: "Session log bridge unavailable" };
  }, []);

  const stopManualSessionLog = useCallback(async (payload: ManualStopPayload) => {
    const bridge = quolldeskBridge.get();
    return bridge?.stopManualSessionLog?.(payload) ?? { success: false, stopped: false, error: "Session log bridge unavailable" };
  }, []);

  const getManualSessionLogStatus = useCallback(async (payload: ManualStatusPayload) => {
    const bridge = quolldeskBridge.get();
    return bridge?.getManualSessionLogStatus?.(payload) ?? { success: false, isLogging: false, hasSessionLog: false, error: "Session log bridge unavailable" };
  }, []);

  return {
    chooseManualSessionLogPath,
    startManualSessionLog,
    stopManualSessionLog,
    getManualSessionLogStatus,
  };
};
