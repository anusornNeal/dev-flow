import React from 'react';
import { AlertCircle, CheckCircle2, Database, Download, FlaskConical, Loader2, ShieldAlert, Upload } from 'lucide-react';

interface BackupSettingsSectionProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  importStatus: 'idle' | 'importing' | 'success' | 'error';
  importMsg: string;
  onImportFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

interface RecoverySummary {
  lastVerifiedGoodBackup?: { id: string; createdAt: string; schemaVersion: string | null };
  lastRestoreDrill?: { checkedAt: string; ok: boolean; code?: string; reason?: string; migrated: boolean };
  failureReason?: { code: string; reason: string; recordedAt: string } | null;
}

type RecoveryFeedback = 'idle' | 'success' | 'error';

export default function BackupSettingsSection({
  fileInputRef,
  importStatus,
  importMsg,
  onImportFile,
}: BackupSettingsSectionProps) {
  const [recovery, setRecovery] = React.useState<RecoverySummary>({});
  const [recoveryAction, setRecoveryAction] = React.useState<'snapshot' | 'drill' | null>(null);
  const [recoveryMessage, setRecoveryMessage] = React.useState('');
  const [recoveryFeedback, setRecoveryFeedback] = React.useState<RecoveryFeedback>('idle');

  const refreshRecovery = React.useCallback(() => {
    fetch('/api/recovery/status', { cache: 'no-store' })
      .then(response => response.json())
      .then((data: RecoverySummary) => setRecovery(data))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    refreshRecovery();
  }, [refreshRecovery]);

  const runRecoveryAction = async (action: 'snapshot' | 'drill') => {
    setRecoveryAction(action);
    setRecoveryMessage('');
    setRecoveryFeedback('idle');
    try {
      const endpoint = action === 'snapshot' ? '/api/recovery/snapshot' : '/api/recovery/restore-drill';
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.drill?.reason || data?.reason || data?.error || 'Recovery verification failed');
      if (data.recovery) setRecovery(data.recovery);
      else refreshRecovery();
      setRecoveryMessage(action === 'snapshot'
        ? 'Verified recovery snapshot created. You can now run a restore drill against it.'
        : 'Restore drill passed in an isolated temporary database. Your live database was not replaced.');
      setRecoveryFeedback('success');
    } catch (error: any) {
      setRecoveryMessage(error?.message || 'Recovery verification failed');
      setRecoveryFeedback('error');
      refreshRecovery();
    } finally {
      setRecoveryAction(null);
    }
  };

  const formatRecoveryTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Not yet';
  const recoveryError = recovery.failureReason
    ? `${recovery.failureReason.code}: ${recovery.failureReason.reason}`
    : recoveryFeedback === 'error'
      ? recoveryMessage
      : '';
  const recoverySuccess = !recovery.failureReason && recoveryFeedback === 'success' ? recoveryMessage : '';

  return (
    <section className="df-surface min-w-0 p-4" aria-labelledby="settings-backup-title">
      <div className="flex min-w-0 items-start gap-2">
        <Database size={16} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
        <div className="min-w-0">
          <h3 id="settings-backup-title" className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Backup & recovery</h3>
          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
            Export portable data, verify recoverability, or restore a backup. Secrets are excluded from exported backups.
          </p>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
        <div className="min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
          <div className="flex min-w-0 items-start gap-2">
            <Download size={14} className="mt-0.5 shrink-0 text-[var(--df-color-info)]" />
            <div className="min-w-0">
              <h4 className="text-xs font-extrabold text-[var(--df-color-text-strong)]">Export current data</h4>
              <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]">
                Download projects, tasks, skills, and related local data for migration or safekeeping.
              </p>
            </div>
          </div>
          <button
            onClick={() => { window.location.href = '/api/export'; }}
            type="button"
            className="df-button df-button--secondary mt-3 !min-w-0"
          >
            <Download size={14} /> Export Backup
          </button>
        </div>

        <div className="min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] p-3">
          <div className="flex min-w-0 items-start gap-2">
            <ShieldAlert size={14} className="mt-0.5 shrink-0 text-[var(--df-color-danger)]" />
            <div className="min-w-0">
              <h4 className="text-xs font-extrabold text-[var(--df-color-danger)]">Restore from backup</h4>
              <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text)]">
                Restoring replaces the current DevFlow database after explicit confirmation. A safety backup is created first, and DevFlow must be restarted after a successful import.
              </p>
            </div>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            type="button"
            disabled={importStatus === 'importing'}
            className="df-button mt-3 !min-w-0 border border-[var(--df-color-danger)] bg-[var(--df-color-danger)] text-white disabled:opacity-60"
          >
            {importStatus === 'importing' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {importStatus === 'importing' ? 'Restoring…' : 'Choose Backup to Restore'}
          </button>
          <input
            type="file"
            accept=".db"
            ref={fileInputRef}
            onChange={onImportFile}
            className="hidden"
          />
        </div>
      </div>

      {importStatus === 'importing' && (
        <div className="mt-3 flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] px-3 py-2.5" role="status">
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-[var(--df-color-warning)]" />
          <div className="min-w-0">
            <div className="text-[10px] font-extrabold text-[var(--df-color-warning)]">Restore in progress</div>
            <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text)]">Keep DevFlow open until the import finishes. The current database is being replaced only after validation.</p>
          </div>
        </div>
      )}

      {importMsg && importStatus !== 'importing' && (
        <div className={`mt-3 flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border px-3 py-2.5 ${
          importStatus === 'error'
            ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
            : 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)]'
        }`} role={importStatus === 'error' ? 'alert' : 'status'}>
          {importStatus === 'error'
            ? <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--df-color-danger)]" />
            : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[var(--df-color-success)]" />}
          <div className="min-w-0">
            <div className={`text-[10px] font-extrabold ${importStatus === 'error' ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-success)]'}`}>
              {importStatus === 'error' ? 'Restore failed' : 'Restore completed'}
            </div>
            <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text)]">{importMsg}</p>
          </div>
        </div>
      )}

      <div className="mt-4 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-3">
        <div className="flex min-w-0 items-start gap-2">
          <FlaskConical size={14} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
          <div className="min-w-0">
            <h4 className="text-xs font-extrabold text-[var(--df-color-text-strong)]">Recovery readiness</h4>
            <p className="mt-0.5 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]">
              Create a verified snapshot, then run a restore drill in an isolated temporary database before relying on it for recovery.
            </p>
          </div>
        </div>

        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-2.5">
            <div className="text-[10px] font-extrabold text-[var(--df-color-text-strong)]">Last verified backup</div>
            <div className="mt-0.5 break-words text-[9px] leading-relaxed text-[var(--df-color-text-muted)]" title={recovery.lastVerifiedGoodBackup?.createdAt}>
              {formatRecoveryTime(recovery.lastVerifiedGoodBackup?.createdAt)}
              {recovery.lastVerifiedGoodBackup?.schemaVersion ? ` · ${recovery.lastVerifiedGoodBackup.schemaVersion}` : ''}
            </div>
          </div>
          <div className="min-w-0 rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-2.5">
            <div className="text-[10px] font-extrabold text-[var(--df-color-text-strong)]">Last restore drill</div>
            <div className="mt-0.5 break-words text-[9px] leading-relaxed text-[var(--df-color-text-muted)]" title={recovery.lastRestoreDrill?.checkedAt}>
              {formatRecoveryTime(recovery.lastRestoreDrill?.checkedAt)}
              {recovery.lastRestoreDrill ? ` · ${recovery.lastRestoreDrill.ok ? 'Passed' : recovery.lastRestoreDrill.code || 'Failed'}` : ''}
            </div>
          </div>
        </div>

        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          <button
            type="button"
            disabled={recoveryAction !== null}
            onClick={() => runRecoveryAction('snapshot')}
            className="df-button df-button--secondary !min-w-0"
          >
            {recoveryAction === 'snapshot' ? <Loader2 size={13} className="animate-spin" /> : <Database size={13} />}
            {recoveryAction === 'snapshot' ? 'Verifying…' : 'Create verified snapshot'}
          </button>
          <button
            type="button"
            disabled={recoveryAction !== null || !recovery.lastVerifiedGoodBackup}
            onClick={() => runRecoveryAction('drill')}
            className="df-button df-button--secondary !min-w-0"
          >
            {recoveryAction === 'drill' ? <Loader2 size={13} className="animate-spin" /> : <FlaskConical size={13} />}
            {recoveryAction === 'drill' ? 'Running drill…' : 'Run restore drill'}
          </button>
        </div>

        {recoveryError && (
          <div className="mt-3 flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] px-3 py-2.5" role="alert">
            <AlertCircle size={13} className="mt-0.5 shrink-0 text-[var(--df-color-danger)]" />
            <span className="min-w-0 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text)]">{recoveryError}</span>
          </div>
        )}
        {recoverySuccess && (
          <div className="mt-3 flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border border-[var(--df-color-success)] bg-[var(--df-color-success-surface)] px-3 py-2.5" role="status">
            <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[var(--df-color-success)]" />
            <span className="min-w-0 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text)]">{recoverySuccess}</span>
          </div>
        )}
      </div>
    </section>
  );
}
