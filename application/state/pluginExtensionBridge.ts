import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";

const requireBridge = () => {
  const bridge = quolldeskBridge.get();
  if (!bridge) throw new Error("QuollDesk desktop bridge is unavailable");
  return bridge;
};

const EMPTY_CREDENTIAL_IDS: ReadonlyArray<string> = Object.freeze([]);
let credentialCatalogIds = EMPTY_CREDENTIAL_IDS;
const credentialCatalogListeners = new Set<() => void>();

const publishCredentialCatalogIds = (ids: ReadonlyArray<string>) => {
  const next = ids.length > 0 ? Object.freeze([...new Set(ids)]) : EMPTY_CREDENTIAL_IDS;
  if (next.length === credentialCatalogIds.length
    && next.every((id, index) => id === credentialCatalogIds[index])) return;
  credentialCatalogIds = next;
  for (const listener of credentialCatalogListeners) listener();
};

export const pluginExtensionBridge = Object.freeze({
  async listProviders(kind: "connection" | "authentication" | "importer" | "sync") {
    return requireBridge().listPluginExtensionProviders?.({ kind }) ?? [];
  },
  async updateCredentialCatalog(entries: ReadonlyArray<{ id: string; ciphertext: string }>) {
    try {
      const accepted = await (requireBridge().updatePluginCredentialCatalog?.(entries) ?? 0);
      publishCredentialCatalogIds(accepted === entries.length ? entries.map((entry) => entry.id) : []);
      return accepted;
    } catch (error) {
      publishCredentialCatalogIds([]);
      throw error;
    }
  },
  getCredentialCatalogIds() {
    return credentialCatalogIds;
  },
  subscribeCredentialCatalog(listener: () => void) {
    credentialCatalogListeners.add(listener);
    return () => credentialCatalogListeners.delete(listener);
  },
  async detectImporter(request: Parameters<NonNullable<QuollDeskBridge["detectPluginImporter"]>>[0]) {
    const bridge = requireBridge();
    if (!bridge.detectPluginImporter) return null;
    return bridge.detectPluginImporter(request);
  },
  async parseImporterFile(request: Parameters<NonNullable<QuollDeskBridge["parsePluginImporterFile"]>>[0]) {
    const bridge = requireBridge();
    if (!bridge.parsePluginImporterFile) throw new Error("Plugin importer bridge is unavailable");
    return bridge.parsePluginImporterFile(request);
  },
  async cancelRequest(requestId: string) {
    return requireBridge().cancelPluginExtensionRequest?.(requestId) ?? false;
  },
  async selectImporterFile() {
    const bridge = requireBridge();
    if (!bridge.selectPluginImporterFile) throw new Error("Plugin importer file selection is unavailable");
    return bridge.selectPluginImporterFile();
  },
  async releaseImporterFile(selectionToken: string) {
    return requireBridge().releasePluginImporterFile?.(selectionToken) ?? false;
  },
  onImporterProgress(listener: Parameters<NonNullable<QuollDeskBridge["onPluginImporterProgress"]>>[0]) {
    return quolldeskBridge.get()?.onPluginImporterProgress?.(listener) ?? (() => {});
  },
  onAuthenticationChallenge(listener: Parameters<NonNullable<QuollDeskBridge["onPluginAuthenticationChallenge"]>>[0]) {
    return quolldeskBridge.get()?.onPluginAuthenticationChallenge?.(listener) ?? (() => {});
  },
  onContributionsChanged(listener: Parameters<NonNullable<QuollDeskBridge["onPluginContributionsChanged"]>>[0]) {
    return quolldeskBridge.get()?.onPluginContributionsChanged?.(listener) ?? (() => {});
  },
  async respondAuthenticationChallenge(
    response: Parameters<NonNullable<QuollDeskBridge["respondPluginAuthenticationChallenge"]>>[0],
  ) {
    const bridge = requireBridge();
    if (!bridge.respondPluginAuthenticationChallenge) throw new Error("Plugin authentication bridge is unavailable");
    return bridge.respondPluginAuthenticationChallenge(response);
  },
  async openExternal(url: string) {
    return requireBridge().openExternal?.(url);
  },
});
