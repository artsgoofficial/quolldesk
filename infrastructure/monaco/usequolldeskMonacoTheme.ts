import type { Monaco } from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import {
  buildQuollDeskMonacoThemeColors,
  getQuollDeskEditorColors,
  getQuollDeskMonacoThemeName,
  getQuollDeskThemeSignal,
  QUOLLDESK_MONACO_THEME_DARK,
  QUOLLDESK_MONACO_THEME_LIGHT,
} from './quolldeskMonacoTheme';

export const useQuollDeskMonacoTheme = (
  monaco: Monaco | null | undefined,
): string => {
  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  const [themeSignal, setThemeSignal] = useState(() => getQuollDeskThemeSignal());
  const themeName = getQuollDeskMonacoThemeName(isDarkTheme);

  useEffect(() => {
    if (!monaco) return;

    const colors = getQuollDeskEditorColors(isDarkTheme);
    const themeColors = buildQuollDeskMonacoThemeColors(colors);

    monaco.editor.defineTheme(QUOLLDESK_MONACO_THEME_DARK, {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.defineTheme(QUOLLDESK_MONACO_THEME_LIGHT, {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: themeColors,
    });

    monaco.editor.setTheme(themeName);
  }, [monaco, isDarkTheme, themeSignal, themeName]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const root = document.documentElement;
    const updateTheme = () => {
      setIsDarkTheme(root.classList.contains('dark'));
      setThemeSignal(getQuollDeskThemeSignal());
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-active-chrome-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return themeName;
};
