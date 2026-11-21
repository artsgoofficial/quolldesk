import { useEffect, useState } from 'react';
import { quolldeskBridge } from '../../infrastructure/services/quolldeskBridge';

type Raster = { light: string; dark?: string };
export function usePluginBrandIcon(plugin?: QuollDeskInstalledPlugin): Raster | null {
  const pluginId = plugin?.id;
  const kind = plugin?.manifest?.icon?.kind;
  const key = JSON.stringify([pluginId, plugin?.activeVersion, plugin?.archiveSha256, plugin?.runtime?.quarantinedAt, plugin?.manifest?.icon]);
  const [loaded, setLoaded] = useState<{ key: string; value: Raster | null } | null>(null);
  useEffect(() => {
    if (!pluginId || kind !== 'package') return;
    let cancelled = false;
    void quolldeskBridge.get()?.getPluginBrandIcon?.(pluginId).then((value) => {
      if (!cancelled) setLoaded({ key, value });
    }).catch(() => { if (!cancelled) setLoaded({ key, value: null }); });
    return () => { cancelled = true; };
  }, [key, pluginId, kind]);
  return loaded?.key === key ? loaded.value : null;
}
