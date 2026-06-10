import React, { useState, useEffect } from 'react';
import { X, Save, FileText } from 'lucide-react';

interface DocEditorModalProps {
  docId: 'schema' | 'playbook';
  onClose: () => void;
}

export default function DocEditorModal({ docId, onClose }: DocEditorModalProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/docs/${docId}`)
      .then(res => res.json())
      .then(data => {
        setContent(data.content || '');
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });
  }, [docId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`/api/docs/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      onClose();
    } catch (err) {
      console.error('Save failed:', err);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] rounded-2xl shadow-xl w-full max-w-5xl h-[85vh] flex flex-col border border-[#e5d4bb] overflow-hidden">
        
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#ebdcb9] bg-[#fdfbf6]">
          <h2 className="text-[#534135] font-extrabold font-sans text-lg flex items-center gap-2">
            <FileText size={20} className="text-[#d89745]" />
            Editing: {docId === 'schema' ? 'Schema Document' : 'Agent Playbook'}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={loading || saving}
              className="bg-[#2a7a8a] hover:bg-[#1a5b67] text-white px-4 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Save size={14} /> {saving ? 'Saving...' : 'Save Document'}
            </button>
            <button
              onClick={onClose}
              className="text-[#8c7463] hover:bg-[#ebdcb9]/40 p-1.5 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 p-4 overflow-hidden flex flex-col bg-[#f5f2eb]">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-[#8a6e5a] font-mono text-sm">
              Loading document...
            </div>
          ) : (
            <textarea
              className="flex-1 w-full p-6 border border-[#ebdcb9] rounded-xl bg-white text-[#3e3129] font-mono text-sm outline-none focus:border-[#d89745] resize-none shadow-sm"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Document content goes here..."
              spellCheck="false"
            />
          )}
        </div>
      </div>
    </div>
  );
}
