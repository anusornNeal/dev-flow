import React from 'react';
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2, Undo2 } from 'lucide-react';

interface TokenCredentialFieldProps {
  label: string;
  description?: string;
  tokenValue: string;
  tokenMasked: boolean;
  showToken: boolean;
  clearToken: boolean;
  placeholder: string;
  inputName: string;
  labelClassName?: string;
  onTokenChange: (value: string) => void;
  onShowTokenChange: (value: boolean) => void;
  onClearTokenChange: (value: boolean) => void;
}

export default function TokenCredentialField({
  label,
  description,
  tokenValue,
  tokenMasked,
  showToken,
  clearToken,
  placeholder,
  inputName,
  labelClassName = 'text-xs font-extrabold text-[var(--df-color-text-strong)]',
  onTokenChange,
  onShowTokenChange,
  onClearTokenChange,
}: TokenCredentialFieldProps) {
  const [revealDraft, setRevealDraft] = React.useState(false);
  const descriptionId = `${inputName}-description`;

  const beginEdit = () => {
    onClearTokenChange(false);
    onShowTokenChange(true);
    setRevealDraft(false);
  };

  const cancelEdit = () => {
    onShowTokenChange(false);
    onTokenChange('');
    setRevealDraft(false);
  };

  const markForRemoval = () => {
    onShowTokenChange(false);
    onTokenChange('');
    setRevealDraft(false);
    onClearTokenChange(true);
  };

  return (
    <div className="min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputName} className={labelClassName}>{label}</label>
          {description && (
            <p id={descriptionId} className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
              {description}
            </p>
          )}
        </div>

        {!showToken && !clearToken && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={beginEdit}
              className="rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface)] px-2 py-1 text-[10px] font-extrabold text-[var(--df-color-accent)] transition-colors hover:border-[var(--df-color-border-strong)] hover:bg-[var(--df-color-surface-subtle)]"
            >
              {tokenMasked ? 'Replace' : 'Add'}
            </button>
            {tokenMasked && (
              <button
                type="button"
                onClick={markForRemoval}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] px-2 py-1 text-[10px] font-extrabold text-[var(--df-color-danger)] transition-opacity hover:opacity-80"
                aria-label={`Clear stored ${label}`}
              >
                <Trash2 size={10} /> Clear
              </button>
            )}
          </div>
        )}
      </div>

      {showToken ? (
        <div className="mt-2.5 min-w-0 rounded-[var(--df-radius-sm)] border border-[var(--df-color-accent)] bg-[var(--df-color-surface-subtle)] p-2.5">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 text-[10px] font-extrabold text-[var(--df-color-text)]">
              {tokenMasked ? 'Enter a replacement value' : 'Enter a new value'}
            </span>
            <button
              type="button"
              onClick={cancelEdit}
              className="shrink-0 rounded-md px-2 py-1 text-[10px] font-bold text-[var(--df-color-text-muted)] hover:bg-[var(--df-color-surface-muted)]"
            >
              Cancel
            </button>
          </div>
          <div className="flex min-w-0 gap-2">
            <input
              id={inputName}
              type={revealDraft ? 'text' : 'password'}
              name={inputName}
              autoComplete="new-password"
              aria-describedby={description ? descriptionId : undefined}
              value={tokenValue}
              onChange={event => onTokenChange(event.target.value)}
              placeholder={placeholder}
              className="df-control min-w-0 flex-1 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setRevealDraft(value => !value)}
              className="df-button df-button--secondary !min-w-0 !px-2.5"
              aria-label={`${revealDraft ? 'Hide' : 'Reveal'} new ${label} value`}
              title={`${revealDraft ? 'Hide' : 'Reveal'} the value you are entering. Stored secrets are never revealed.`}
            >
              {revealDraft ? <EyeOff size={14} /> : <Eye size={14} />}
              <span className="hidden sm:inline">{revealDraft ? 'Hide' : 'Show'}</span>
            </button>
          </div>
          <p className="mt-1.5 break-words text-[9px] leading-relaxed text-[var(--df-color-text-subtle)]">
            This only reveals the new value in this input. DevFlow never sends the previously stored secret back to the browser.
          </p>
        </div>
      ) : clearToken ? (
        <div className="mt-2.5 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-[var(--df-radius-sm)] border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] px-3 py-2.5" role="status">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10px] font-extrabold text-[var(--df-color-danger)]">
              <Trash2 size={12} className="shrink-0" /> Clear on save
            </div>
            <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]">
              The stored credential will remain available until you press Save Settings.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClearTokenChange(false)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-2 py-1 text-[10px] font-extrabold text-[var(--df-color-text)]"
          >
            <Undo2 size={11} /> Undo
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-3 py-2.5">
          {tokenMasked ? <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--df-color-success)]" /> : <KeyRound size={14} className="mt-0.5 shrink-0 text-[var(--df-color-text-subtle)]" />}
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold text-[var(--df-color-text)]">
              {tokenMasked ? 'Stored securely · hidden' : 'Not configured'}
            </div>
            <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]">
              {tokenMasked
                ? 'The saved value is masked and cannot be revealed. Choose Replace to enter a new value.'
                : `No ${label.replace(' Access Token', '')} credential is stored.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
