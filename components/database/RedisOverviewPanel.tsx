/**
 * Redis server overview — the keys-view empty state. Renders server stats
 * from the workbench's shared serverInfo INFO summary (no bridge calls of
 * its own); every field degrades to a dash when INFO lacks it (old server,
 * restricted ACL) instead of erroring.
 */
import React, { useEffect, useRef, useState } from 'react';
import { databaseClient } from '@/infrastructure/services/databaseClient';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  OPS_SAMPLE_CAPACITY,
  formatDurationMs,
  opsSparklinePoints,
  parseKeyspace,
  pushOpsSample,
  redisHitRate,
} from './redisOverview';

interface RedisOverviewPanelProps {
  /** Flattened INFO sections from the workbench's shared serverInfo fetch. */
  summary: Record<string, string>;
  /** Active logical db: the keyspace card reads keyspace.dbN from summary. */
  db?: number;
  /**
   * Connection used by the low-frequency ops sampler (one INFO round trip
   * every 5s while this panel is mounted — it is the whole right pane, so
   * the extra traffic stays negligible). Absent → no sampling loop.
   */
  connectionId?: string;
}

const dash = (value: string | number | null | undefined) =>
  value == null || value === '' ? '-' : String(value);

const Card: React.FC<{ title: string; rows: [string, string][] }> = ({ title, rows }) => (
  <div className="rounded-md border border-border/60 p-3 min-w-0">
    <p className="text-xs font-medium text-foreground mb-2">{title}</p>
    <dl className="space-y-1.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-2 text-xs">
          <dt className="text-muted-foreground flex-shrink-0">{label}</dt>
          <dd className="font-mono text-foreground text-right truncate" title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  </div>
);

export const RedisOverviewPanel: React.FC<RedisOverviewPanelProps> = ({ summary, db, connectionId }) => {
  const { t } = useI18n();
  const keyspace = db != null ? parseKeyspace(summary, db) : null;
  const rate = redisHitRate(summary);
  // INFO has no uptime_human field — humanize uptime_in_seconds ourselves.
  const uptimeSeconds = Number(summary.uptime_in_seconds);
  const uptime = Number.isFinite(uptimeSeconds) && uptimeSeconds > 0
    ? formatDurationMs(uptimeSeconds * 1000)
    : null;

  // Rolling ops/sec samples for the trend sparkline. Seeds from the shared
  // summary, then advances on its own 5s heartbeat while mounted.
  const [opsHistory, setOpsHistory] = useState<number[]>([]);
  const latestOps = Number(summary.instantaneous_ops_per_sec);
  const seedRef = useRef(false);
  useEffect(() => {
    if (!seedRef.current && Number.isFinite(latestOps)) {
      seedRef.current = true;
      setOpsHistory((prev) => pushOpsSample(prev, latestOps));
    }
  }, [latestOps]);
  useEffect(() => {
    if (!connectionId) return;
    let alive = true;
    const sample = async () => {
      try {
        const info = await databaseClient.redis.serverInfo({ connectionId });
        if (!alive) return;
        seedRef.current = true;
        setOpsHistory((prev) => pushOpsSample(prev, Number(info.summary?.instantaneous_ops_per_sec)));
      } catch {
        // Sampling is best-effort: a missed beat just leaves a gap.
      }
    };
    const timer = setInterval(() => void sample(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [connectionId]);

  return (
    <div className="h-full overflow-auto p-4">
      <p className="text-sm font-medium text-foreground mb-3">{t('db.redis.overview.title')}</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title={t('db.redis.overview.server')} rows={[
          [t('db.redis.overview.version'), dash(summary.redis_version)],
          [t('db.redis.overview.mode'), dash(summary.redis_mode)],
          [t('db.redis.overview.role'), dash(summary.role)],
          [t('db.redis.overview.uptime'), dash(uptime)],
          [t('db.redis.overview.os'), dash(summary.os)],
        ]} />
        <Card title={t('db.redis.overview.memory')} rows={[
          [t('db.redis.overview.usedMemory'), dash(summary.used_memory_human)],
          [t('db.redis.overview.peakMemory'), dash(summary.used_memory_peak_human)],
          [t('db.redis.overview.fragRatio'), dash(summary.mem_fragmentation_ratio)],
        ]} />
        <Card
          title={db != null ? `${t('db.redis.overview.keyspace')} · db${db}` : t('db.redis.overview.keyspace')}
          rows={[
            [t('db.redis.overview.keys'), dash(keyspace?.keys)],
            [t('db.redis.overview.withTtl'), dash(keyspace?.expires)],
            [t('db.redis.overview.avgTtl'), dash(formatDurationMs(keyspace?.avgTtlMs ?? null))],
          ]}
        />
        <Card title={t('db.redis.overview.activity')} rows={[
          [t('db.redis.overview.clients'), dash(summary.connected_clients)],
          [t('db.redis.overview.opsPerSec'), dash(summary.instantaneous_ops_per_sec)],
          [t('db.redis.overview.hitRate'), rate == null ? '-' : `${(rate * 100).toFixed(1)}%`],
        ]} />
      </div>
      {opsHistory.length > 0 && (
        <div className="rounded-md border border-border/60 p-3 mt-3">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <p className="text-xs font-medium text-foreground">{t('db.redis.overview.opsTrend')}</p>
            <p className="text-xs font-mono text-muted-foreground">
              {dash(summary.instantaneous_ops_per_sec)} {t('db.redis.overview.opsPerSecUnit')}
            </p>
          </div>
          <svg viewBox="0 0 240 40" className="w-full h-10" preserveAspectRatio="none" aria-hidden>
            <polyline
              points={opsSparklinePoints(opsHistory, 240, 40)}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-primary/70"
            />
          </svg>
          <p className="text-[10px] text-muted-foreground mt-1">
            {t('db.redis.overview.opsTrendHint', { count: opsHistory.length, capacity: OPS_SAMPLE_CAPACITY })}
          </p>
        </div>
      )}
    </div>
  );
};

export default RedisOverviewPanel;
