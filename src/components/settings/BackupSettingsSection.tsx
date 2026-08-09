import React from 'react';
import { AlertCircle, CheckCircle2, Database, Download, Loader2, Upload } from 'lucide-react';

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

export default function BackupSettingsSection({
  fileInputRef,
  importStatus,
  importMsg,
  onImportFile,
}: BackupSettingsSectionProps) {
  const [recovery, setRecovery] = React.useState<RecoverySummary>({});
  const [recoveryAction, setRecoveryAction] = React.useState<'snapshot' | 'drill' | null>(null);
  const [recoveryMessage, setRecoveryMessage] = React.useState('');

  const refreshRecovery = React.useCallback(() => {
    fetch('/api/recovery/status', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: RecoverySummary) => setRecovery(data))
      .catch(() => undefined);
  }, []);

  React.useEffect(() => {
    refreshRecovery();
  }, [refreshRecovery]);

  const runRecoveryAction = async (action: 'snapshot' | 'drill') => {
    setRecoveryAction(action);
    setRecoveryMessage('');
    try {
      const endpoint = action === 'snapshot' ? '/api/recovery/snapshot' : '/api/recovery/restore-drill';
      const response = await fetch(endpoint, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.drill?.reason || data?.reason || data?.error || 'Recovery verification failed');
      if (data.recovery) setRecovery(data.recovery);
      else refreshRecovery();
      setRecoveryMessage(action === 'snapshot' ? 'Verified recovery snapshot created.' : 'Restore drill passed in an isolated temporary database.');
    } catch (error: any) {
      setRecoveryMessage(error?.message || 'Recovery verification failed');
      refreshRecovery();
    } finally {
      setRecoveryAction(null);
    }
  };

  const formatRecoveryTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Not yet';

  return (
    <div className="pt-4 mt-2 border-t border-[#ebdcb9] dark:border-[#584a3b] flex flex-col gap-2">
      <div className="flex flex-wrap items-start sm:items-center justify-between gap-4">
        <div className="flex-1 min-w-[240px]">
          <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135] dark:text-[#f3eadf]">
            <Database size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
            Export Data
          </label>
          <p className="text-[11px] text-[#8a725f] dark:text-[#f3eadf] font-mono mt-0.5 leading-relaxed">
            Download a portable backup of your DevFlow data (projects, tasks, skills) to migrate to another machine. Secrets are excluded.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <button
            onClick={() => fileInputRef.current?.click()}
            type="button"
            disabled={importStatus === 'importing'}
            className="bg-[#faf7f0] dark:bg-[#1e1914] border border-[#e5d4bb] dark:border-[#584a3b] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#584a3b] text-[#534135] dark:text-[#f3eadf] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
          >
            {importStatus === 'importing' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {importStatus === 'importing' ? 'Importing...' : 'Import Backup'}
          </button>
          <button
            onClick={() => window.location.href = '/api/export'}
            type="button"
            className="bg-[#faf7f0] dark:bg-[#1e1914] border border-[#e5d4bb] dark:border-[#584a3b] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#584a3b] text-[#534135] dark:text-[#f3eadf] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download size={14} /> Export Backup
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-xl border border-[#eadbc4] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] p-3">
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-[#534135] dark:text-[#f3eadf]">Last verified backup</div>
          <div className="text-[10px] font-mono text-[#8a725f] dark:text-[#cdbcae] truncate">
            {formatRecoveryTime(recovery.lastVerifiedGoodBackup?.createdAt)}
            {recovery.lastVerifiedGoodBackup?.schemaVersion ? ` · ${recovery.lastVerifiedGoodBackup.schemaVersion}` : ''}
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-[#534135] dark:text-[#f3eadf]">Last restore drill</div>
          <div className="text-[10px] font-mono text-[#8a725f] dark:text-[#cdbcae] truncate">
            {formatRecoveryTime(recovery.lastRestoreDrill?.checkedAt)}
            {recovery.lastRestoreDrill ? ` · ${recovery.lastRestoreDrill.ok ? 'Passed' : recovery.lastRestoreDrill.code || 'Failed'}` : ''}
          </div>
        </div>
        <div className="sm:col-span-2 flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            disabled={recoveryAction !== null}
            onClick={() => runRecoveryAction('snapshot')}
            className="bg-[#fffdfa] dark:bg-[#262019] border border-[#e5d4bb] dark:border-[#584a3b] px-2.5 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-50"
          >
            {recoveryAction === 'snapshot' ? 'Verifying…' : 'Create verified snapshot'}
          </button>
          <button
            type="button"
            disabled={recoveryAction !== null || !recovery.lastVerifiedGoodBackup}
            onClick={() => runRecoveryAction('drill')}
            className="bg-[#fffdfa] dark:bg-[#262019] border border-[#e5d4bb] dark:border-[#584a3b] px-2.5 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-50"
          >
            {recoveryAction === 'drill' ? 'Running drill…' : 'Run restore drill'}
          </button>
        </div>
        {(recovery.failureReason || recoveryMessage) && (
          <div className={`sm:col-span-2 text-[10px] font-mono ${recovery.failureReason ? 'text-[#991b1b] dark:text-[#fca5a5]' : 'text-[#166534] dark:text-[#a7f3d0]'}`}>
            {recovery.failureReason ? `${recovery.failureReason.code}: ${recovery.failureReason.reason}` : recoveryMessage}
          </div>
        )}
      </div>

      {importMsg && (
        <div className={`mt-2 p-2 rounded-lg text-xs font-mono flex items-start gap-2 ${importStatus === 'error' ? 'bg-[#fff0f0] dark:bg-[#1e1914] text-[#991b1b] dark:text-[#f3eadf] border border-[#fecaca] dark:border-[#584a3b]' : 'bg-[#f0f9f4] dark:bg-[#1e1914] text-[#166534] dark:text-[#f3eadf] border border-[#a3e6cd] dark:border-[#584a3b]'}`}>
          {importStatus === 'error' ? <AlertCircle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
          <span>{importMsg}</span>
        </div>
      )}
    </div>
  );
}
