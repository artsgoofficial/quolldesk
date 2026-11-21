/**
 * Sql Host Details Panel - create/edit form for MySQL/PostgreSQL connections.
 * Follows the SerialHostDetailsPanel / aside-panel design system.
 */
import { Eye, EyeOff, Save, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { Host } from '../../domain/models/connection';
import {
  DB_DEFAULT_PORTS, isValidPort, normalizeSqlConfig,
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

type SqlDialect = 'mysql' | 'postgresql';

interface SqlHostDetailsPanelProps {
  initialData?: Host | null;
  dialect: SqlDialect;
  sshHosts: Host[];
  onSave: (host: Host) => void;
  onCancel: () => void;
}

export const SqlHostDetailsPanel: React.FC<SqlHostDetailsPanelProps> = ({
  initialData, dialect, sshHosts, onSave, onCancel,
}) => {
  const { t } = useI18n();
  const cfg = initialData?.sqlConfig ?? {};
  const [label, setLabel] = useState(initialData?.label ?? '');
  const [hostname, setHostname] = useState(initialData?.hostname ?? '');
  const [port, setPort] = useState(String(
    initialData?.port ?? DB_DEFAULT_PORTS[
      initialData?.protocol === 'postgresql' || dialect === 'postgresql' ? 'postgresql' : 'mysql'
    ],
  ));
  const [username, setUsername] = useState(initialData?.username ?? '');
  const [password, setPassword] = useState(initialData?.password ?? '');
  const [savePassword, setSavePassword] = useState(initialData?.savePassword ?? true);
  const [database, setDatabase] = useState(cfg.database ?? '');
  const [tls, setTls] = useState(!!cfg.tls);
  const [tlsInsecure, setTlsInsecure] = useState(!!cfg.tlsInsecure);
  const [tunnelHostId, setTunnelHostId] = useState(cfg.tunnelHostId ?? '');
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const portNumber = useMemo(() => Number(port), [port]);
  const hostInvalid = !hostname.trim();
  const portInvalid = !isValidPort(portNumber);

  const buildHost = (): Host => ({
    ...(initialData ?? {}),
    // Host requires tags/os; the `?? {}` spread leaves them undefined on new
    // hosts, so provide explicit defaults (preserved from initialData on edit).
    tags: initialData?.tags ?? [],
    os: initialData?.os ?? 'linux',
    id: initialData?.id ?? crypto.randomUUID(),
    protocol: dialect,
    label: label.trim() || hostname.trim(),
    hostname: hostname.trim(),
    port: portNumber,
    username,
    password: savePassword ? password : undefined,
    savePassword,
    redisConfig: undefined,
    sqlConfig: normalizeSqlConfig({
      database: database || undefined, tls, tlsInsecure, tunnelHostId: tunnelHostId || undefined,
    }),
  });

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const probe: Host = { ...buildHost() };
    const tunnelHost = sshHosts.find((h) => h.id === tunnelHostId) ?? undefined;
    try {
      const args = resolveDbConnectArgs({
        host: probe, dialect,
        tunnelHost: tunnelHost ? { ...tunnelHost } : undefined,
      });
      const result = await databaseClient[dialect].test(args);
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
          <Label htmlFor="sql-label">{t('db.form.label')}</Label>
          <Input id="sql-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="db-1" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <Label htmlFor="sql-host">{t('db.form.host')}</Label>
            <Input id="sql-host" value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="127.0.0.1" />
            {hostInvalid && <p className="text-xs text-destructive">{t('db.form.validation.hostRequired')}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="sql-port">{t('db.form.port')}</Label>
            <Input id="sql-port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
            {portInvalid && <p className="text-xs text-destructive">{t('db.form.validation.portInvalid')}</p>}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="sql-username">{t('db.form.username')}</Label>
          <Input id="sql-username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="sql-password">{t('db.form.password')}</Label>
          <div className="relative">
            <Input id="sql-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} className="pr-8" />
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowPassword((v) => !v)} aria-label="toggle password">
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {checkboxRow(savePassword, setSavePassword, 'db.form.savePassword')}
        </div>
        <div className="space-y-1">
          <Label htmlFor="sql-database">{t('db.form.database')}</Label>
          <Input id="sql-database" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={dialect === 'postgresql' ? 'postgres' : 'mysql'} />
        </div>
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
          <Button className="flex-1" disabled={hostInvalid || portInvalid} onClick={() => onSave(buildHost())}>
            <Save size={14} className="mr-1" />{t('db.action.save')}
          </Button>
        </div>
      </AsidePanelFooter>
    </AsidePanel>
  );
};

export default SqlHostDetailsPanel;
