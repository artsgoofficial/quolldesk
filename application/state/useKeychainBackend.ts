import { useCallback } from "react";
import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";

export const useKeychainBackend = () => {
  const generateKeyPair = useCallback(async (options: { type: "RSA" | "ECDSA" | "ED25519"; bits?: number; comment?: string }) => {
    const bridge = quolldeskBridge.get();
    return bridge?.generateKeyPair?.(options);
  }, []);

  const execCommand = useCallback(async (options: Parameters<QuollDeskBridge["execCommand"]>[0]) => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.execCommand) throw new Error("execCommand unavailable");
    return bridge.execCommand(options);
  }, []);

  return { generateKeyPair, execCommand };
};
