import { useCallback } from "react";
import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";

export const useKnownHostsBackend = () => {
  const readKnownHosts = useCallback(async () => {
    const bridge = quolldeskBridge.get();
    return bridge?.readKnownHosts?.();
  }, []);

  return { readKnownHosts };
};

