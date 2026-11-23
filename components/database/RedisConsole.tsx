import React, { useEffect, useRef, useState } from 'react';
import { TerminalSquare, Trash2 } from 'lucide-react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { databaseClient, dbErrorMessage } from '@/infrastructure/services/databaseClient';
import { formatReplyValue } from './format';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import EmptyState from '../EmptyState';

interface RedisConsoleProps {
  connectionId: string;
}

interface ConsoleEntry {
  command: string;
  ok: boolean;
  output: string;
  at: number;
}

const MAX_ENTRIES = 200;

const RedisConsole: React.FC<RedisConsoleProps> = ({ connectionId }) => {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

  const run = async () => {
    const command = input.trim();
    if (!command || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setInput('');
    setCommandHistory((prev) => [...prev, command]);
    setHistoryIndex(null);
    try {
      const result = await databaseClient.redis.runCommand({ connectionId, command });
      setEntries((prev) => {
        const next = [...prev, { command: result.command, ok: true, output: formatReplyValue(result.reply), at: Date.now() }];
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    } catch (err) {
      const message = dbErrorMessage(err);
      setEntries((prev) => {
        const next = [...prev, { command, ok: false, output: message, at: Date.now() }];
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      let next: number | null;
      if (e.key === 'ArrowUp') {
        next = historyIndex === null ? commandHistory.length - 1 : Math.max(0, historyIndex - 1);
      } else {
        next = historyIndex === null ? null : historyIndex + 1;
        if (next >= commandHistory.length) next = null;
      }
      setHistoryIndex(next);
      setInput(next === null ? '' : commandHistory[next]);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {entries.length > 0 && (
        <div className="px-3 py-1 flex justify-end border-b border-border/40 shrink-0">
          <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={() => setEntries([])}>
            <Trash2 size={12} className="mr-1" />{t('db.pubsub.clear')}
          </Button>
        </div>
      )}
      <div className="flex-1 overflow-auto p-3 text-xs font-mono">
        {entries.length === 0 && (
          <EmptyState className="h-full" icon={<TerminalSquare size={30} />} title={t('db.console.empty')} />
        )}
        {entries.map((entry, i) => (
          <div key={`${entry.at}/${i}`} className="border-b border-border/30 py-1">
            <div className="text-foreground/90">
              <span className="text-emerald-600 dark:text-emerald-400 select-none">&gt; </span>
              <span className="break-all">{entry.command}</span>
            </div>
            <div className={`whitespace-pre-wrap break-all mt-0.5 ${entry.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
              {entry.output}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="p-2 border-t border-border/60 flex items-center gap-2 shrink-0">
        <span className="text-emerald-600 dark:text-emerald-400 font-mono text-xs select-none">&gt;</span>
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('db.console.placeholder')}
          className="h-7 text-xs font-mono flex-1"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
        <Button size="sm" className="h-7 font-medium" disabled={running || !input.trim()} onClick={() => void run()}>
          {t('db.workbench.query.run')}
        </Button>
      </div>
    </div>
  );
};

export default RedisConsole;
