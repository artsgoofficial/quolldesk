import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { usePluginContributions } from './usePluginContributions';
import { resolvePluginSettingScopeSelection, usePluginSettingScopeCatalog } from './usePluginSettingScopeCatalog';

export function usePluginSettingsModel(pluginId: string) {
  const { locale } = useI18n();
  const catalog = usePluginSettingScopeCatalog();
  const [scopeIds, setScopeIds] = useState<Partial<Record<QuollDeskPluginSettingScopeKind, string>>>({});
  useEffect(() => {
    setScopeIds(current => resolvePluginSettingScopeSelection(catalog, current));
  }, [catalog]);
  const query = useMemo<QuollDeskPluginContributionQuery>(() => ({
    locale, context: { 'quolldesk.surface': 'settings' }, scopeIds,
  }), [locale, scopeIds]);
  const contributions = usePluginContributions(query);
  const plugin = contributions.snapshot.plugins.find(item => item.id === pluginId);
  const settings = plugin?.settings.filter(setting => setting.visible) ?? [];
  const contextualScopes = [...new Set(settings.map(setting => setting.scope)
    .filter((scope): scope is QuollDeskPluginSettingScopeKind => scope !== 'application'))];
  return { ...contributions, plugin, settings, catalog, scopeIds, setScopeIds, contextualScopes };
}
