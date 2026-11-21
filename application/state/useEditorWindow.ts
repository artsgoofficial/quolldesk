import { useCallback, useEffect, useState } from "react";
import { quolldeskBridge } from "../../infrastructure/services/quolldeskBridge";
import { editorTabStore } from "./editorTabStore";
import type { EditorWindowTabSnapshot } from "./editorWindowTypes";
import type { EditorTabId } from "./editorTabStore";

export function useEditorWindowRuntime() {
  const [activeTabId, setActiveTabId] = useState<EditorTabId | null>(
    () => editorTabStore.getTabs()[editorTabStore.getTabs().length - 1]?.id ?? null,
  );

  const closeWindow = useCallback(async () => {
    await quolldeskBridge.get()?.windowClose?.();
  }, []);

  const setWindowTitle = useCallback(async (title: string) => {
    await quolldeskBridge.get()?.setWindowTitle?.(title);
  }, []);

  useEffect(() => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.onEditorWindowOpenTab) return () => {};
    return bridge.onEditorWindowOpenTab((snapshot: EditorWindowTabSnapshot) => {
      const existing = editorTabStore.getTab(snapshot.editorId)
        ?? editorTabStore.getTabs().find((tab) => (
          tab.sessionId === snapshot.sessionId && tab.remotePath === snapshot.remotePath
        ));
      if (existing) {
        if (existing.sessionId !== snapshot.sessionId) {
          editorTabStore.remapSessionId(existing.sessionId, snapshot.sessionId);
        }
        if (existing.sftpTabId !== snapshot.sftpTabId || existing.hostLabel !== snapshot.hostLabel) {
          editorTabStore.upsertFromSnapshot({
            ...snapshot,
            content: existing.content,
            baselineContent: existing.baselineContent,
            viewState: existing.viewState,
            wordWrap: existing.wordWrap,
            languageId: existing.languageId,
          }, "tab");
        }
        setActiveTabId(existing.id);
        return;
      }
      const id = editorTabStore.upsertFromSnapshot(snapshot, "tab");
      setActiveTabId(id);
    });
  }, []);

  useEffect(() => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.onEditorWindowActivateTab) return () => {};
    return bridge.onEditorWindowActivateTab((payload) => {
      if (payload?.editorId && editorTabStore.getTab(payload.editorId)) {
        setActiveTabId(payload.editorId);
      }
    });
  }, []);

  useEffect(() => {
    const bridge = quolldeskBridge.get();
    if (!bridge?.onEditorWindowRemapSession) return () => {};
    return bridge.onEditorWindowRemapSession((payload) => {
      editorTabStore.remapSessionId(payload.fromSessionId, payload.toSessionId);
    });
  }, []);

  return {
    activeTabId,
    setActiveTabId,
    closeWindow,
    setWindowTitle,
  };
}
