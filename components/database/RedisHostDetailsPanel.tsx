/**
 * Redis Host Details Panel - create/edit form for Redis connections.
 * Follows the SerialHostDetailsPanel / aside-panel design system.
 */
import { Eye, EyeOff, Plus, Save, Trash2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host } from '../../domain/models/connection';
import {
  DB_DEFAULT_PORTS, isValidPort, normalizeRedisConfig,
} from '../../domain/models/database';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  AsidePanel, AsidePanelContent, AsidePanelFooter,
} from '../ui/aside-panel';
// The @/ alias is the repo's sanctioned path for component-layer imports of
// infrastructure services (relative ../../infrastructure imports are eslint-restricted).
import { resolveDbConnectArgs, databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';

interface RedisHostDetailsPanelProps {
  initialData?: Host | null;
  sshHosts: Host[];
  onSave: (host: Host) => void;
  onCancel: () => void;
}

export const RedisHostDetailsPanel: React.FC<RedisHostDetailsPanelProps> = ({
  initialData, sshHosts, onSave, onCancel,
}) => {
  const { t } = useI18n();
  const cfg = initialData?.redisConfig ?? {};
  const [label, setLabel] = useState(initialData?.label ?? '');
  const [hostname, setHostname] = useState(initialData?.hostname ?? '');
  const [port, setPort] = useState(String(initialData?.port ?? DB_DEFAULT_PORTS.redis));
  const [password, setPassword] = useState(initialData?.password ?? '');
  const [savePassword, setSavePassword] = useState(initialData?.savePassword ?? true);
  const [redisUsername, setRedisUsername] = useState(cfg.redisUsername ?? '');
  const [redisDb, setRedisDb] = useState(cfg.redisDb != null ? String(cfg.redisDb) : '');
  const [tls, setTls] = useState(!!cfg.tls);
  const [tlsInsecure, setTlsInsecure] = useState(!!cfg.tlsInsecure);
  const [cluster, setCluster] = useState(!!cfg.cluster);
  const [clusterNodes, setClusterNodes] = useState(
    (cfg.clusterNodes ?? []).map((n) => ({ hostname: n.hostname, port: String(n.port) })),
  );
  const [tunnelHostId, setTunnelHostId] = useState(cfg.tunnelHostId ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const portNumber = useMemo(() => Number(port), [port]);
  const hostInvalid = !hostname.trim();
  const portInvalid = !isValidPort(portNumber);
  const dbInvalid = redisDb !== '' && (!/^\d+$/.test(redisDb) || Number(redisDb) > 15);

  const buildHost = (): Host => ({
    ...(initialData ?? {}),
    // Host requires tags/os; the `?? {}` spread leaves them undefined on new
    // hosts, so provide explicit defaults (preserved from initialData on edit).
    tags: initialData?.tags ?? [],
    os: initialData?.os ?? 'linux',
    id: initialData?.id ?? crypto.randomUUID(),
    protocol: 'redis',
    label: label.trim() || hostname.trim(),
    hostname: hostname.trim(),
    port: portNumber,
    username: '',
    password: savePassword ? password : undefined,
    savePassword,
    redisConfig: normalizeRedisConfig({
      redisDb: redisDb === '' ? undefined : Number(redisDb),
      redisUsername: redisUsername || undefined,
      tls, tlsInsecure, cluster,
      clusterNodes: cluster
        ? clusterNodes
            .map((n) => ({ hostname: n.hostname.trim(), port: Number(n.port) }))
            .filter((n) => n.hostname && Number.isInteger(n.port) && n.port >= 1 && n.port <= 65535)
        : undefined,
      tunnelHostId: tunnelHostId || undefined,
    }),
  });

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const probe: Host = { ...buildHost() };
    const tunnelHost = sshHosts.find((h) => h.id === tunnelHostId) ?? undefined;
    try {
      const args = resolveDbConnectArgs({
        host: probe, dialect: 'redis',
        tunnelHost: tunnelHost ? { ...tunnelHost } : undefined,
      });
      const result = await databaseClient.redis.test(args);
      setTestResult({ ok: true, text: t('db.test.ok', { ms: result.latencyMs, version: result.serverVersion ?? '' }) });
    } catch (err) {
      const message = dbErrorMessage(err);
      setTestResult({ ok: false, text: t('db.test.failed', { message }) });
    } finally {
      setTesting(false);
    }
  };

  const checkboxRow = (checked: boolean, onChange: (v: boolean) => void, key: string) => (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {t(key)}
    </label>
  );

  return (
    <AsidePanel
      open
      onClose={onCancel}
      title={initialData ? t('db.action.edit') : t('db.action.new')}
    >
      <AsidePanelContent>
        <div className="space-y-1">
          <Label htmlFor="redis-label">{t('db.form.label')}</Label>
          <Input id="redis-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="cache-1" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="redis-host">{t('db.form.host')}</Label>
            <Input id="redis-host" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="127.0.0.1" />
            {hostInvalid && <p className="text-xs text-destructive">{t('db.form.validation.hostRequired')}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="redis-port">{t('db.form.port')}</Label>
            <Input id="redis-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            {portInvalid && <p className="text-xs text-destructive">{t('db.form.validation.portInvalid')}</p>}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="redis-acl">{t('db.form.redisUsername')}</Label>
          <Input id="redis-acl" value={redisUsername} onChange={(e) => setRedisUsername(e.target.value)} placeholder="default" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="redis-password">{t('db.form.password')}</Label>
          <div className="relative">
            <Input id="redis-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="pr-8" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowPassword((v) => !v)} aria-label="toggle password">
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {checkboxRow(savePassword, setSavePassword, 'db.form.savePassword')}
        </div>
        <div className="space-y-1">
          <Label htmlFor="redis-db">{t('db.form.redisDb')}</Label>
          <Input id="redis-db" inputMode="numeric" value={redisDb} onChange={(e) => setRedisDb(e.target.value)} placeholder="0" />
          {dbInvalid && <p className="text-xs text-destructive">{t('db.form.validation.redisDbInvalid')}</p>}
        </div>
        {checkboxRow(cluster, setCluster, 'db.form.cluster')}
        {cluster && (
          <div className="space-y-2 rounded-md border border-border/60 p-2">
            <p className="text-xs text-muted-foreground">{t('db.form.clusterHint')}</p>
            {clusterNodes.map((node, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input className="flex-1" value={node.hostname} placeholder="10.0.0.1"
                  onChange={(e) => setClusterNodes((prev) => prev.map((n, j) => (j === i ? { ...n, hostname: e.target.value } : n)))} />
                <Input className="w-24" inputMode="numeric" value={node.port} placeholder="6379"
                  onChange={(e) => setClusterNodes((prev) => prev.map((n, j) => (j === i ? { ...n, port: e.target.value } : n)))} />
                <Button variant="ghost" size="icon" aria-label="remove node"
                  onClick={() => setClusterNodes((prev) => prev.filter((_, j) => j !== i))}>
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setClusterNodes((prev) => [...prev, { hostname: '', port: String(DB_DEFAULT_PORTS.redis) }])}>
              <Plus size={14} className="mr-1" />{t('db.form.clusterNodes.add')}
            </Button>
          </div>
        )}
        {checkboxRow(tls, setTls, 'db.form.tls')}
        {tls && checkboxRow(tlsInsecure, setTlsInsecure, 'db.form.tlsInsecure')}
        <div className="space-y-1">
          <Label>{t('db.form.tunnel')}</Label>
          <Select value={tunnelHostId || 'none'} onValueChange={(v) => setTunnelHostId(v === 'none' ? '' : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('db.form.tunnel.none')}</SelectItem>
              {sshHosts.map((h) => (
                <SelectItem key={h.id} value={h.id}>{h.label || h.hostname}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tunnelHostId && <p className="text-xs text-muted-foreground">{t('db.form.tunnel.hint')}</p>}
        </div>
        {testResult && (
          <p className={`text-xs ${testResult.ok ? 'text-emerald-500' : 'text-destructive'}`}>{testResult.text}</p>
        )}
      </AsidePanelContent>
      <AsidePanelFooter>
        <div className="flex gap-2 w-full">
          <Button variant="outline" className="flex-1" disabled={testing || hostInvalid || portInvalid} onClick={runTest}>
            {testing ? t('db.action.testing') : t('db.action.test')}
          </Button>
          <Button variant="ghost" onClick={onCancel}><X size={14} className="mr-1" />{t('db.action.cancel')}</Button>
          <Button className="flex-1" disabled={hostInvalid || portInvalid || dbInvalid} onClick={() => onSave(buildHost())}>
            <Save size={14} className="mr-1" />{t('db.action.save')}
          </Button>
        </div>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default RedisHostDetailsPanel;
