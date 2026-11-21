import { useCallback } from "react";
import { quolldeskBridge } from "../../../infrastructure/services/quolldeskBridge";
import type { SftpFileEntry, SftpFilenameEncoding } from "../../../domain/models";
import { buildMockLocalFiles } from "./mockLocalFiles";
import { formatFileSize, formatDate } from "./utils";

export const useSftpDirectoryListing = () => {
  const getMockLocalFiles = useCallback((path: string): SftpFileEntry[] => {
    return buildMockLocalFiles(path);
  }, []);

  const listLocalFiles = useCallback(
    async (path: string): Promise<SftpFileEntry[]> => {
      const rawFiles = await quolldeskBridge.get()?.listLocalDir?.(path);
      if (!rawFiles) {
        return getMockLocalFiles(path);
      }

      return rawFiles.map((f) => {
        const size = parseInt(f.size) || 0;
        const lastModified = new Date(f.lastModified).getTime();
        return {
          name: f.name,
          type: f.type as "file" | "directory" | "symlink",
          size,
          sizeFormatted: formatFileSize(size),
          lastModified,
          lastModifiedFormatted: formatDate(lastModified),
          linkTarget: f.linkTarget as "file" | "directory" | null | undefined,
          hidden: f.hidden,
          owner: f.owner,
        };
      });
    },
    [getMockLocalFiles],
  );

  const listRemoteFiles = useCallback(
    async (sftpId: string, path: string, encoding?: SftpFilenameEncoding): Promise<SftpFileEntry[]> => {
      const rawFiles = await quolldeskBridge.get()?.listSftp(sftpId, path, encoding);
      if (!rawFiles) return [];

      return rawFiles.map((f) => {
        const size = parseInt(f.size) || 0;
        const lastModified = new Date(f.lastModified).getTime();
        return {
          name: f.name,
          type: f.type as "file" | "directory" | "symlink",
          size,
          sizeFormatted: formatFileSize(size),
          lastModified,
          lastModifiedFormatted: formatDate(lastModified),
          permissions: f.permissions,
          owner: f.owner,
          linkTarget: f.linkTarget as "file" | "directory" | null | undefined,
        };
      });
    },
    [],
  );

  return {
    listLocalFiles,
    listRemoteFiles,
  };
};
