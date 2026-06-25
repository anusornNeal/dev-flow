import React from 'react';
import { AlertCircle, CheckCircle2, Database, Download, Loader2, Upload } from 'lucide-react';

interface BackupSettingsSectionProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  importStatus: 'idle' | 'importing' | 'success' | 'error';
  importMsg: string;
  onImportFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function BackupSettingsSection({
  fileInputRef,
  importStatus,
  importMsg,
  onImportFile,
}: BackupSettingsSectionProps) {
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

      {importMsg && (
        <div className={`mt-2 p-2 rounded-lg text-xs font-mono flex items-start gap-2 ${importStatus === 'error' ? 'bg-[#fff0f0] dark:bg-[#1e1914] text-[#991b1b] dark:text-[#f3eadf] border border-[#fecaca] dark:border-[#584a3b]' : 'bg-[#f0f9f4] dark:bg-[#1e1914] text-[#166534] dark:text-[#f3eadf] border border-[#a3e6cd] dark:border-[#584a3b]'}`}>
          {importStatus === 'error' ? <AlertCircle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
          <span>{importMsg}</span>
        </div>
      )}
    </div>
  );
}
