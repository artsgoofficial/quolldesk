/**
 * Shared empty-state block: rounded icon chip + title + hint + actions.
 * One definition so every section's "nothing here yet" reads the same
 * (monitor / scripts / notes / keychain previously hand-rolled variants).
 */
import React from 'react';
import { cn } from '../lib/utils';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Section glyph, rendered inside the rounded chip (32px reads best). */
  icon: React.ReactNode;
  title: string;
  hint?: string;
  /** Buttons or any call-to-action cluster under the hint. */
  actions?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, hint, actions, className, ...rest }) => (
  <div {...rest} className={cn('flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center', className)}>
    <div className="h-16 w-16 rounded-2xl bg-secondary/80 flex items-center justify-center text-muted-foreground">
      {icon}
    </div>
    <h2 className="text-lg font-semibold text-foreground">{title}</h2>
    {hint ? <p className="text-sm text-center max-w-sm text-muted-foreground">{hint}</p> : null}
    {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
  </div>
);

export default EmptyState;
