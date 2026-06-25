/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Sparkles, AlertCircle, Terminal, HelpCircle } from 'lucide-react';
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
      "title": "Establish Kotlin Compose navigation architecture",
      "description": "Setup type-safe navigation graph using Jetpack Compose Navigation component with serializable routes.",
      "status": "backlog",
      "priority": "high",
      "branch": "feature/compose-navigation",
      "category": "frontend",
      "tags": ["android", "navigation"],
      "targetFiles": [
        "app/build.gradle.kts",
        "app/src/main/java/com/example/devflow/ui/NavGraph.kt"
      ],
      "checklist": [
        { "text": "Add jetpack-navigation compose ksp dependency", "completed": false },
        { "text": "Define type-safe screens destinations hierarchy", "completed": false }
      ]
    },
    {
      "title": "Setup iOS Swift Keychain storage cache",
      "description": "Create unified secure wrapper for iOS dynamic Keychain queries.",
      "status": "todo",
      "priority": "medium",
      "category": "backend",
      "tags": ["ios", "security"],
      "checklist": [
        { "text": "Create KeychainHelper file wrapping OS queries", "completed": false }
      ]
    }
  ];

  const handleApplySample = () => {
    setJsonText(JSON.stringify(sampleJson, null, 2));
    setErrorMsg(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jsonText.trim()) return;

    setErrorMsg(null);
    setImporting(true);

    try {
      // 1. Initial syntax check
      const parsed = JSON.parse(jsonText.trim());
      
      // 2. Validate format structure
      if (Array.isArray(parsed)) {
        const invalidIndex = parsed.findIndex(item => !item || typeof item !== 'object' || !item.title);
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

      // 3. Dispatch action API call to backend
      const success = await onImport(parsed);
      if (success) {
        onClose();
      } else {
        throw new Error('Internal server failed to register schema batch. Check network payload.');
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || 'SyntaxError: Invalid JSON scheme.');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      {/* Outer Close clicking */}
      <div className="fixed inset-0" onClick={onClose} />

      {/* Modal Card */}
      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col justify-between font-sans">
        
        {/* Header toolbar */}
        <div className="p-5 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between font-mono text-[#5c493c] dark:text-[#f3eadf]">
          <div className="flex items-center gap-2">
            <Terminal size={18} className="text-[#3c829e] dark:text-[#f3eadf]" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase">
              BATCH_IMPORT_JSON_TICKETS
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
          >
            <X size={17} />
          </button>
        </div>

        {/* Input fields Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto scrollbar-thin text-xs font-mono text-[#5c493c] dark:text-[#f3eadf]">
          
          <div className="space-y-1">
            <div className="flex justify-between items-center pr-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                Paste JSON Array or Object
              </label>
              <button
                type="button"
                onClick={handleApplySample}
                className="text-[9px] bg-[#fffbf4] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] text-[#3c829e] dark:text-[#f3eadf] hover:bg-[#fff9ed] dark:hover:bg-[#1e1914] px-2.5 py-1 rounded-lg transition-colors cursor-pointer font-extrabold shadow-3xs flex items-center gap-1"
              >
                <HelpCircle size={10} />
                <span>+ Use Sample JSON Array</span>
              </button>
            </div>

            <textarea
              required
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 h-64 outline-none focus:border-[#3c829e] dark:border-[#8ba4e8] dark:focus:border-[#584a3b] font-mono resize-y text-[#3a2f26] dark:text-[#f3eadf] text-[11px] leading-relaxed shadow-3xs"
              placeholder="e.g.&#10;[&#10;  {&#10;    &quot;title&quot;: &quot;Awesome Ticket&quot;,&#10;    &quot;priority&quot;: &quot;high&quot;,&#10;    &quot;status&quot;: &quot;backlog&quot;&#10;  }&#10;]"
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setErrorMsg(null);
              }}
            />
          </div>

          {/* Feedback error notice logs */}
          {errorMsg && (
            <div className="p-3 bg-[#fdf2f2] dark:bg-[#1e1914] border border-[#fbd5d5] dark:border-[#584a3b] rounded-xl flex items-start gap-2.5 text-red-700 text-[10px] leading-relaxed">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-extrabold uppercase tracking-wide">Validation Failure Log:</p>
                <p className="font-semibold">{errorMsg}</p>
              </div>
            </div>
          )}

          {/* Instruction helper guidelines */}
          <div className="p-3.5 bg-[#f5efdf]/60 dark:bg-[#1e1914]/60 border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl text-[9px] text-[#856e5f] dark:text-[#f3eadf] leading-relaxed font-sans">
            <p className="font-bold uppercase tracking-wider mb-1 flex items-center gap-1.5 font-mono text-[#5c493c] dark:text-[#f3eadf]">
              <Sparkles size={11} className="text-[#3c829e] dark:text-[#f3eadf]" /> Importing Guidelines
            </p>
            <ul className="list-disc pl-3.5 space-y-1 font-semibold">
              <li>Pasted blob must consist of a clean JSON Array containing ticket records.</li>
              <li>Required property is the ticket <strong>title</strong> string.</li>
              <li>Optional properties: <strong>description</strong> (markdown string), <strong>status</strong> (backlog, todo, in-progress, ready-for-review, done), <strong>priority</strong> (low, medium, high), <strong>branch</strong> (text), <strong>category</strong> (<strong>frontend</strong>, <strong>backend</strong>, or <strong>general</strong>), <strong>tags</strong> (free-form labels), <strong>targetFiles</strong> (array of paths), <strong>agent</strong>, <strong>model</strong>, <strong>effort</strong> {getAgentCatalogHelp()}, and <strong>checklist</strong> (array of steps with text and completed values).</li>
            </ul>
          </div>

          {/* Buttons bar */}
          <div className="flex gap-3 pt-4 border-t border-[#ebdcb9] dark:border-[#584a3b]">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] text-[#816b5a] dark:text-[#f3eadf] bg-white dark:bg-[#1e1914] hover:bg-[#fffcf6] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] transition-all text-xs font-bold font-mono cursor-pointer"
            >
              Discard
            </button>
            <button
              type="submit"
              disabled={importing || !jsonText.trim()}
              className="flex-1 bg-[#3c829e] dark:bg-[#e0a070] hover:bg-[#2d6277] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] disabled:bg-gray-300 dark:disabled:bg-[#292119] disabled:cursor-not-allowed text-white dark:text-[#f3eadf] font-extrabold py-2.5 rounded-xl text-xs transition-all shadow-md cursor-pointer font-mono"
            >
              {importing ? 'Importing... 🚀' : 'Commit Batch JSON ✨'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
