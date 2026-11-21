import { Radio, Trash2, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { formatMaybeJson } from './format';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface RedisPubSubProps {
  connectionId: string;
}

interface Subscription { channel: string; pattern: boolean }

/** A received message plus its render (JSON detection happens once, here). */
interface PubsubMessage { channel: string; pattern?: string | null; message: string; receivedAt: number; rendered: React.ReactNode }

const MAX_MESSAGES = 500;
const MAX_SUBSCRIPTIONS = 20;

const RedisPubSub: React.FC<RedisPubSubProps> = ({ connectionId }) => {
  const { t } = useI18n();
  const [channel, setChannel] = useState('');
  const [asPattern, setAsPattern] = useState(false);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [messages, setMessages] = useState<PubsubMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Live push feed. The connectionId filter keeps one workbench's page from
  // showing another connection's traffic. JSON detection/prettify runs once
  // per message at receive time — doing it per render would re-parse every
  // previously received JSON message on each incoming one.
  useEffect(() => {
    const unsubscribe = databaseClient.redis.onPubsubMessage((payload) => {
      if (payload.connectionId !== connectionId) return;
      const detected = formatMaybeJson(payload.message);
      const rendered: React.ReactNode = detected.isJson
        ? <pre className="whitespace-pre-wrap break-all font-mono m-0">{detected.formatted}</pre>
        : payload.message;
      setMessages((prev) => {
        const next: PubsubMessage[] = [...prev, { ...payload, rendered }];
        return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
      });
    });
    return unsubscribe;
  }, [connectionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const doSubscribe = async () => {
    const trimmed = channel.trim();
    if (!trimmed || busy) return;
    if (subscriptions.some((s) => s.channel === trimmed && s.pattern === asPattern)) return;
    if (subscriptions.length >= MAX_SUBSCRIPTIONS) {
      setError(t('db.pubsub.tooMany'));
      return;
    }
    setBusy(true); setError(null);
    try {
      await databaseClient.redis.subscribe({ connectionId, channel: trimmed, pattern: asPattern });
      setSubscriptions((prev) => [...prev, { channel: trimmed, pattern: asPattern }]);
      setChannel('');
    } catch (err) {
      setError(dbErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const doUnsubscribe = async (target: Subscription) => {
    try {
      await databaseClient.redis.unsubscribe({ connectionId, channel: target.channel, pattern: target.pattern });
    } catch (err) {
      setError(dbErrorMessage(err));
      return;
    }
    setSubscriptions((prev) => prev.filter((s) => !(s.channel === target.channel && s.pattern === target.pattern)));
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-border/60 flex items-center gap-2 shrink-0">
        <Input
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void doSubscribe(); }}
          placeholder={asPattern ? 'news.tech.*' : 'news.tech'}
          className="h-7 text-xs flex-1"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={asPattern} onChange={(e) => setAsPattern(e.target.checked)} />
          {t('db.pubsub.pattern')}
        </label>
        <Button size="sm" className="h-7 font-medium" disabled={busy || !channel.trim()} onClick={() => void doSubscribe()}>
          <Radio size={13} className="mr-1" />{t('db.pubsub.subscribe')}
        </Button>
        {subscriptions.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setMessages([])}>
            <Trash2 size={13} className="mr-1" />{t('db.pubsub.clear')}
          </Button>
        )}
      </div>
      {subscriptions.length > 0 && (
        <div className="px-3 py-1.5 border-b border-border/60 flex flex-wrap gap-1 shrink-0">
          {subscriptions.map((sub) => (
            <span key={`${sub.pattern ? 'p' : 'c'}/${sub.channel}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-foreground/5 text-xs">
              <span className={sub.pattern ? 'text-violet-600 dark:text-violet-400' : 'text-emerald-600 dark:text-emerald-400'}>
                {sub.pattern ? t('db.pubsub.pattern') : t('db.pubsub.channel')}:
              </span>
              <span className="font-mono">{sub.channel}</span>
              <button type="button" aria-label={t('db.pubsub.unsubscribe')} className="text-muted-foreground hover:text-destructive"
                onClick={() => void doUnsubscribe(sub)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-xs px-3 py-2 shrink-0">{error}</p>}
      <div className="flex-1 overflow-auto p-2 text-xs">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-muted-foreground text-center px-4">
            <p>{t('db.pubsub.empty')}</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={`${msg.receivedAt}/${i}`} className="border-b border-border/30 py-1">
            <div className="flex gap-2 text-[10px] text-muted-foreground">
              <span>{new Date(msg.receivedAt).toLocaleTimeString()}</span>
              <span className="font-mono text-foreground/80 truncate">{msg.channel}</span>
              {msg.pattern && <span className="text-violet-600 dark:text-violet-400 font-mono truncate">~{msg.pattern}</span>}
            </div>
            <div className="font-mono break-all mt-0.5">{msg.rendered}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default RedisPubSub;
