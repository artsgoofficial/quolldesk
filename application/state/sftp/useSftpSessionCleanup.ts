import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { quolldeskBridge } from "../../../infrastructure/services/quolldeskBridge";

export const useSftpSessionCleanup = (
  sftpSessionsRef: MutableRefObject<Map<string, string>>,
): MutableRefObject<boolean> => {
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    const sessionsRef = sftpSessionsRef.current;

    return () => {
      disposedRef.current = true;
      const sftpIds = [...sessionsRef.values()];
      sessionsRef.clear();
      for (const sftpId of sftpIds) {
        void quolldeskBridge.get()?.closeSftp(sftpId).catch(() => {
          // Ignore errors when closing SFTP sessions during cleanup.
        });
      }
    };
  }, [sftpSessionsRef]);

  return disposedRef;
};
