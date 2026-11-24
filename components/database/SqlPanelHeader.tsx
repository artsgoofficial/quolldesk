/**
 * Shared header for full-area SQL workbench panels (sessions/locks/users):
 * back button, title, trailing actions pushed right. Presentation only.
 */
import { ArrowLeft, RefreshCw } from 'lucide-react';
import React from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { Button } from '../ui/button';

interface SqlPanelHeaderProps {
  titleKey: string;
  onClose: () => void;
  /** When set, renders the refresh button with loading spin/disable. */
  onRefresh?: () => void;
  loading?: boolean;
  children?: React.ReactNode;
}

export const SqlPanelHeader: React.FC<SqlPanelHeaderProps> = ({ titleKey, onClose, onRefresh, loading = false, children }) => {
  const { t } = useI18n();
  return (
    <div className="px-2 py-1.5 border-b border-border/60 flex items-center gap-1.5 shrink-0 app-no-drag">
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onClose} title={t('db.search.back')}>
        <ArrowLeft size={13} />
      </Button>
      <span className="text-xs font-medium">{t(titleKey)}</span>
      <div className="ml-auto flex items-center gap-1.5">
        {onRefresh && (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onRefresh} disabled={loading} title={t('common.refresh')}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        )}
        {children}
      </div>
    </div>
  );
};

export default SqlPanelHeader;
