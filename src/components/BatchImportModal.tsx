/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AlertCircle, Braces, HelpCircle, Sparkles, X } from 'lucide-react';
import { getAgentCatalogHelp } from '../lib/agentsConfig';

interface BatchImportModalProps {
  onClose: () => void;
  onImport: (jsonBlob: any) => Promise<boolean>;
}

export default function BatchImportModal({ onClose, onImport }: BatchImportModalProps) {
  const [jsonText, setJsonText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const sampleJson = [
    {
      title: 'Establish Kotlin Compose navigation architecture',
      description: 'Setup type-safe navigation graph using Jetpack Compose Navigation component with serializable routes.',
      status: 'backlog',
      priority: 'high',
      branch: 'feature/compose-navigation',
      category: 'frontend',
      tags: ['android', 'navigation'],
      targetFiles: [
        'app/build.gradle.kts',
        'app/src/main/java/com/example/devflow/ui/NavGraph.kt',
      ],
      checklist: [
        { text: 'Add jetpack-navigation compose ksp dependency', completed: false },
        { text: 'Define type-safe screens destinations hierarchy', completed: false },
      ],
    },
    {
      title: 'Setup iOS Swift Keychain storage cache',
      description: 'Create unified secure wrapper for iOS dynamic Keychain queries.',
      status: 'todo',
      priority: 'medium',
      category: 'backend',
      tags: ['ios', 'security'],
      checklist: [
        { text: 'Create KeychainHelper file wrapping OS queries', completed: false },
      ],
    },
  ];

  const handleApplySample = () => {
    setJsonText(JSON.stringify(sampleJson, null, 2));
    setErrorMsg(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!jsonText.trim() || importing) return;

    setErrorMsg(null);
    setImporting(true);

    try {
      const parsed = JSON.parse(jsonText.trim());

      if (Array.isArray(parsed)) {
        const invalidIndex = parsed.findIndex((item) => !item || typeof item !== 'object' || !item.title);
        if (invalidIndex !== -1) {
          throw new Error(`Item at position #${invalidIndex + 1} is missing a required "title" property.`);
        }
      } else if (typeof parsed === 'object' && parsed !== null) {
        if (!parsed.title) {
          throw new Error('Pasted object must have a "title" property.');
        }
      } else {
        throw new Error('Pasted data must be either a JSON Array [...] or a single Task Object {...}');
      }

      const success = await onImport(parsed);
      if (success) {
        onClose();
      } else {
        throw new Error('Internal server failed to register schema batch. Check network payload.');
      }
    } catch (error: any) {
      console.error(error);
      setErrorMsg(error.message || 'SyntaxError: Invalid JSON scheme.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--df-color-backdrop)] p-3 backdrop-blur-xs sm:p-4">
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-import-title"
        className="relative z-10 flex max-h-[calc(100vh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-df-border bg-df-surface shadow-[var(--df-shadow-lg)] sm:max-h-[calc(100vh-2rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-df-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-df-info">
              <Braces size={16} />
              <span className="text-[9px] font-black uppercase tracking-[0.16em]">Batch authoring</span>
            </div>
            <h2 id="batch-import-title" className="mt-1 text-base font-black text-df-text">Import tasks from JSON</h2>
            <p className="mt-1 max-w-xl text-[10px] leading-relaxed text-df-text-muted">
              Paste one task object or an array of tasks. Every task must include a title; all other supported fields are optional.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close batch import dialog" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-df-text-muted hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 scrollbar-thin">
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-black text-df-text">JSON payload <span className="text-df-accent">· Required</span></p>
                  <p className="mt-0.5 text-[9px] text-df-text-muted">The input stays editable after validation errors.</p>
                </div>
                <button type="button" onClick={handleApplySample} className="inline-flex items-center gap-1.5 rounded-lg border border-df-border px-2.5 py-1.5 text-[9px] font-bold text-df-info hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
                  <HelpCircle size={11} /> Use sample
                </button>
              </div>

              <textarea
                required
                aria-required="true"
                aria-invalid={Boolean(errorMsg)}
                aria-describedby={errorMsg ? 'batch-import-error' : 'batch-import-help'}
                className={`min-h-72 w-full resize-y rounded-xl border bg-df-surface-raised px-3 py-3 font-mono text-[10px] leading-relaxed text-df-text outline-none transition-colors placeholder:text-df-text-muted focus:ring-2 focus:ring-[var(--df-color-focus-ring)]/20 ${errorMsg ? 'border-df-danger focus:border-df-danger' : 'border-df-border focus:border-df-info'}`}
                placeholder={'[\n  {\n    "title": "Example task",\n    "priority": "high",\n    "status": "backlog"\n  }\n]'}
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setErrorMsg(null);
                }}
              />
              <p id="batch-import-help" className="mt-1.5 text-[9px] leading-relaxed text-df-text-muted">
                Accepted top level: a task object or an array of task objects.
              </p>
            </section>

            {errorMsg && (
              <div id="batch-import-error" role="alert" className="flex max-h-36 items-start gap-2.5 overflow-y-auto break-words rounded-xl border border-df-danger bg-[var(--df-color-danger-surface)] px-3 py-2.5 text-[10px] leading-relaxed text-df-danger">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-black">Import could not continue</p>
                  <p className="mt-1 whitespace-pre-wrap break-words font-semibold">{errorMsg}</p>
                </div>
              </div>
            )}

            <details className="rounded-xl border border-df-border bg-df-surface-muted px-3 py-2.5 text-[9px] text-df-text-muted">
              <summary className="cursor-pointer font-black text-df-text">Supported fields</summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p><strong className="text-df-text">Required:</strong> title.</p>
                <p>
                  <strong className="text-df-text">Optional:</strong> description, status, priority, branch, category, tags, targetFiles, checklist, agent, model, and effort {getAgentCatalogHelp()}.
                </p>
                <p>Use the sample when you need a known-good shape before replacing it with your own tasks.</p>
              </div>
            </details>

            <div className="rounded-xl border border-df-border bg-df-surface-raised px-3 py-2.5 text-[9px] leading-relaxed text-df-text-muted">
              <div className="flex items-start gap-2">
                <Sparkles size={12} className="mt-0.5 shrink-0 text-df-info" />
                <p>Validation checks JSON syntax and the required title field before the payload is sent to the backend.</p>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-df-border bg-df-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-df-border px-4 text-[10px] font-extrabold text-df-text-muted hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              Cancel
            </button>
            <button type="submit" disabled={importing || !jsonText.trim()} className="h-10 rounded-xl bg-df-primary px-5 text-[10px] font-extrabold text-[var(--df-color-primary-text)] shadow-[var(--df-shadow-sm)] hover:bg-[var(--df-color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              {importing ? 'Importing tasks…' : 'Import tasks'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
