import React, { useEffect } from 'react';
import { AlertTriangle, Info, Loader2, X } from 'lucide-react';

interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'primary';
  confirmDisabled?: boolean;
  confirming?: boolean;
  confirmingText?: string;
}

export default function ConfirmModal({
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  confirmDisabled = false,
  confirming = false,
  confirmingText,
}: ConfirmModalProps) {
  const destructive = variant === 'danger';
  const busyLabel = confirmingText || (confirmText.toLowerCase() === 'delete' ? 'Deleting…' : 'Working…');
  const Icon = destructive ? AlertTriangle : Info;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || confirming) return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [confirming, onCancel]);

  return (
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 select-text">
      <div className="fixed inset-0" onClick={() => { if (!confirming) onCancel(); }} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        aria-busy={confirming}
        className="df-dialog relative z-10 flex w-full max-w-sm flex-col overflow-hidden"
      >
        <div className="df-dialog-header flex items-start justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className={`mt-0.5 shrink-0 ${destructive ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-accent)]'}`}>
              <Icon size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="confirm-modal-title" className="df-heading-sm break-words">
                {title}
              </h2>
              {destructive && (
                <p className="mt-1 text-[10px] font-semibold text-[var(--df-color-text-muted)]">
                  Review the impact before continuing.
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            aria-label="Close confirmation dialog"
            className="df-icon-button df-focus-ring shrink-0"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="px-5 py-5">
          <p id="confirm-modal-message" className="df-body-sm break-words">
            {message}
          </p>
        </div>

        <div className="df-dialog-footer flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={confirming}
            autoFocus
            className="df-button df-button--secondary df-focus-ring"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled || confirming}
            className={`df-button ${destructive ? 'df-button--danger' : 'df-button--primary'} df-focus-ring`}
          >
            {confirming && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {confirming ? busyLabel : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
