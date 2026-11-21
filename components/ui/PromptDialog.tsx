import React, { useEffect, useState } from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";

interface PromptDialogProps {
  open: boolean;
  title: string;
  /** Field label above the input; omit for a label-less prompt. */
  label?: string;
  /** Pre-fills the input; re-applied whenever the dialog opens. */
  initialValue?: string;
  confirmLabel: string;
  placeholder?: string;
  busy?: boolean;
  destructive?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the trimmed value. Empty input never reaches here. */
  onConfirm: (value: string) => void;
}

/** Single-input dialog (rename table/key, TTL, …) mirroring ConfirmDialog's shell. */
export const PromptDialog = function PromptDialog({
  open,
  title,
  label,
  initialValue = '',
  confirmLabel,
  placeholder,
  busy = false,
  destructive = false,
  onOpenChange,
  onConfirm,
}: PromptDialogProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);

  // Each open starts from the caller's initial value (rename pre-fill etc.);
  // closing resets so a cancelled edit doesn't leak into the next open.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const submit = () => {
    if (busy || !trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-[380px]">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="space-y-2"
        >
          {label && <label className="text-xs text-muted-foreground">{label}</label>}
          <Input
            value={value}
            placeholder={placeholder}
            autoFocus
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </form>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={submit}
            disabled={busy || !trimmed}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PromptDialog;
