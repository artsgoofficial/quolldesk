import { loader } from '@monaco-editor/react';

/**
 * Point the shared @monaco-editor/react loader at local files instead of the
 * CDN: the dev server serves monaco from node_modules, the packaged app from
 * the copied public/monaco assets. Call once at each editor surface's module
 * scope — loader config is global and idempotent (every call sets the same
 * path, so multiple editor surfaces stay in sync).
 */
export function configureMonacoLoader(): void {
  const viteEnv = import.meta.env ?? { BASE_URL: '/', DEV: false };
  const monacoBasePath = viteEnv.DEV
    ? './node_modules/monaco-editor/min/vs'
    : `${viteEnv.BASE_URL}monaco/vs`;
  loader.config({ paths: { vs: monacoBasePath } });
}
