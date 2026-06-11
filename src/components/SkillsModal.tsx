import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Edit2, Ban, ChevronRight, Plus } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SkillsModalProps {
  onClose: () => void;
}

interface SkillMeta {
  id: string;
  name: string;
  description: string;
}

interface SkillDetail extends SkillMeta {
  content: string;
}

export default function SkillsModal({ onClose }: SkillsModalProps) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');

  const [isImporting, setIsImporting] = useState(false);
  const [importId, setImportId] = useState('');
  const [importName, setImportName] = useState('');
  const [importDescription, setImportDescription] = useState('');
  const [importContent, setImportContent] = useState('');
  const [dragOver, setDragOver] = useState(false);

  // 1. Fetch Skill List on mount
  useEffect(() => {
    fetch('/api/skills')
      .then(res => res.json())
      .then(data => {
        setSkills(data);
        setLoadingList(false);
        if (data.length > 0) {
          setSelectedSkillId(data[0].id);
        }
      })
      .catch(err => {
        console.error('Failed to load skills list:', err);
        setLoadingList(false);
      });
  }, []);

  // 2. Fetch Skill Detail when selected changes
  useEffect(() => {
    if (!selectedSkillId) return;
    setLoadingDetail(true);
    setIsEditing(false);
    fetch(`/api/skills/${selectedSkillId}`)
      .then(res => res.json())
      .then(data => {
        setSkillDetail(data);
        setEditContent(data.content || '');
        setLoadingDetail(false);
      })
      .catch(err => {
        console.error('Failed to load skill details:', err);
        setLoadingDetail(false);
      });
  }, [selectedSkillId]);

  const handleSave = async () => {
    if (!selectedSkillId) return;
    setSaving(true);
    try {
      await fetch(`/api/skills/${selectedSkillId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent })
      });
      // Update local state
      setSkillDetail(prev => prev ? { ...prev, content: editContent } : null);
      setIsEditing(false);
    } catch (err) {
      console.error('Save failed:', err);
    }
    setSaving(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    if (skillDetail) {
      setEditContent(skillDetail.content); // revert to original
    }
  };

  const handleImportSave = async () => {
    if (!importId || !importName || !importDescription || !importContent) {
      alert("All fields are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/skills/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: importId,
          name: importName,
          description: importDescription,
          content: importContent
        })
      });
      if (!res.ok) {
        throw new Error('Import failed');
      }
      
      const data = await fetch('/api/skills').then(r => r.json());
      setSkills(data);
      setIsImporting(false);
      setSelectedSkillId(importId);
    } catch (err) {
      console.error('Import failed:', err);
      alert('Failed to import skill');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] rounded-2xl shadow-xl w-full max-w-6xl h-[85vh] flex border border-[#e5d4bb] overflow-hidden select-none">
        
        {/* Left Sidebar: Skill List */}
        <div className="w-1/3 border-r border-[#ebdcb9] bg-[#fdfbf6] flex flex-col">
          <div className="px-6 py-4 border-b border-[#ebdcb9] flex items-center justify-between shrink-0">
            <h2 className="text-[#534135] font-extrabold font-sans text-lg flex items-center gap-2">
              <FileText size={20} className="text-[#d89745]" />
              Agent Skills
            </h2>
            <button
              onClick={() => {
                if ((isEditing || isImporting) && !confirm('You have unsaved changes. Discard them?')) return;
                setIsEditing(false);
                setSelectedSkillId(null);
                setSkillDetail(null);
                setIsImporting(true);
                setImportId('');
                setImportName('');
                setImportDescription('');
                setImportContent('');
              }}
              className="p-1.5 hover:bg-[#ebdcb9]/40 rounded-lg text-[#d89745] transition-colors"
              title="Import Skill"
            >
              <Plus size={18} />
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loadingList ? (
              <div className="text-sm font-mono text-[#8c7463] p-2">Loading skills...</div>
            ) : skills.length === 0 ? (
              <div className="text-sm font-mono text-[#8c7463] p-2">No skills available.</div>
            ) : (
              skills.map(skill => {
                const isSelected = skill.id === selectedSkillId;
                return (
                  <button
                    key={skill.id}
                    onClick={() => {
                      if (!isEditing && !isImporting) {
                        setSelectedSkillId(skill.id);
                        setIsImporting(false);
                      } else {
                        if (confirm('You have unsaved changes. Discard them?')) {
                          setIsImporting(false);
                          setIsEditing(false);
                          setSelectedSkillId(skill.id);
                        }
                      }
                    }}
                    className={`flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                      isSelected
                        ? 'bg-[#ffecca] border-[#e3a35a] shadow-sm text-[#935919]'
                        : 'bg-white border-[#e5d4bb] hover:bg-[#faf6ef] text-[#534135]'
                    }`}
                  >
                    <div>
                      <div className="font-extrabold text-sm">{skill.name}</div>
                      <div className="text-[10px] font-mono text-[#8a725f] mt-1 line-clamp-1">{skill.description}</div>
                    </div>
                    {isSelected && <ChevronRight size={16} className="text-[#d89745]" />}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Area: Detail/Editor */}
        <div className="w-2/3 flex flex-col bg-[#f5f2eb]">
          <div className="px-6 py-4 border-b border-[#ebdcb9] bg-[#fdfbf6] flex items-center justify-between shrink-0 h-[69px]">
            {isImporting ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="text-[#534135] font-extrabold font-sans text-base">Import New Skill</h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (skills.length > 0) setSelectedSkillId(skills[0].id);
                      setIsImporting(false);
                    }}
                    disabled={saving}
                    className="bg-white hover:bg-rose-50 border border-rose-200 text-rose-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Ban size={14} /> Cancel
                  </button>
                  <button
                    onClick={handleImportSave}
                    disabled={saving}
                    className="bg-[#2a7a8a] hover:bg-[#1a5b67] text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Save size={14} /> {saving ? 'Saving...' : 'Import'}
                  </button>
                  <div className="w-px h-5 bg-[#ebdcb9] mx-1"></div>
                  <button
                    onClick={onClose}
                    className="text-[#8c7463] hover:bg-[#ebdcb9]/40 p-1.5 rounded-lg transition-colors"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ) : loadingDetail ? (
              <div className="text-sm font-mono text-[#8c7463]">Loading details...</div>
            ) : skillDetail ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="text-[#534135] font-extrabold font-sans text-base">{skillDetail.name}</h3>
                  <p className="text-[10px] font-mono text-[#8a725f]">{skillDetail.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="bg-white hover:bg-[#ebdcb9]/40 border border-[#ebdcb9] text-[#534135] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm"
                    >
                      <Edit2 size={14} /> Edit Skill
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={handleCancelEdit}
                        disabled={saving}
                        className="bg-white hover:bg-rose-50 border border-rose-200 text-rose-600 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                      >
                        <Ban size={14} /> Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="bg-[#2a7a8a] hover:bg-[#1a5b67] text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                      >
                        <Save size={14} /> {saving ? 'Saving...' : 'Save Changes'}
                      </button>
                    </>
                  )}
                  <div className="w-px h-5 bg-[#ebdcb9] mx-1"></div>
                  <button
                    onClick={onClose}
                    className="text-[#8c7463] hover:bg-[#ebdcb9]/40 p-1.5 rounded-lg transition-colors"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex justify-end">
                <button
                  onClick={onClose}
                  className="text-[#8c7463] hover:bg-[#ebdcb9]/40 p-1.5 rounded-lg transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 overflow-hidden flex flex-col relative select-text">
            {isImporting ? (
              <div 
                className={`flex-1 flex flex-col gap-4 overflow-y-auto transition-all duration-200 ${dragOver ? 'bg-[#d89745]/10 border-2 border-dashed border-[#d89745] p-4 rounded-xl shadow-inner' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.md') || f.name.endsWith('.markdown'));
                  if (files.length === 0) {
                    alert('Please drop valid .md files');
                    return;
                  }
                  
                  if (files.length === 1) {
                    const file = files[0];
                    const text = await file.text();
                    setImportId(file.name.replace(/\.md$|\.markdown$/, ''));
                    setImportName(file.name.replace(/\.md$|\.markdown$/, '').split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
                    setImportContent(text);
                  } else {
                    setSaving(true);
                    let successCount = 0;
                    for (const file of files) {
                      try {
                        const text = await file.text();
                        const id = file.name.replace(/\.md$|\.markdown$/, '');
                        const name = id.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                        const res = await fetch(`/api/skills/import`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id, name, description: 'Imported via drag and drop', content: text })
                        });
                        if (res.ok) successCount++;
                      } catch (err) {
                        console.error('Failed to import', file.name, err);
                      }
                    }
                    const data = await fetch('/api/skills').then(r => r.json());
                    setSkills(data);
                    setSaving(false);
                    alert(`Successfully imported ${successCount} of ${files.length} skills`);
                    setIsImporting(false);
                  }
                }}
              >
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-xs font-extrabold text-[#534135]">ID (Filename)</label>
                  <input
                    type="text"
                    value={importId}
                    onChange={(e) => setImportId(e.target.value)}
                    placeholder="e.g. my-new-skill"
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white border-[#d89745] text-[#3e3129] focus:ring-2 focus:ring-[#d89745]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-xs font-extrabold text-[#534135]">Name</label>
                  <input
                    type="text"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="e.g. My New Skill"
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white border-[#d89745] text-[#3e3129] focus:ring-2 focus:ring-[#d89745]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-xs font-extrabold text-[#534135]">Description</label>
                  <input
                    type="text"
                    value={importDescription}
                    onChange={(e) => setImportDescription(e.target.value)}
                    placeholder="Brief description..."
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white border-[#d89745] text-[#3e3129] focus:ring-2 focus:ring-[#d89745]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-h-[200px]">
                  <label className="text-xs font-extrabold text-[#534135]">Content (Markdown)</label>
                  <textarea
                    className="flex-1 w-full p-4 border rounded-xl text-sm font-mono outline-none resize-none shadow-sm transition-colors bg-white border-[#d89745] text-[#3e3129] focus:ring-2 focus:ring-[#d89745]/30"
                    value={importContent}
                    onChange={(e) => setImportContent(e.target.value)}
                    placeholder="Skill document content goes here..."
                    spellCheck="false"
                  />
                </div>
              </div>
            ) : !skillDetail || loadingDetail ? (
              <div className="flex-1 flex items-center justify-center text-[#8a6e5a] font-mono text-sm">
                No skill selected.
              </div>
            ) : (
              <div className="flex-1 flex flex-col relative h-full">
                {isEditing ? (
                  <textarea
                    className="flex-1 w-full p-6 border rounded-xl text-sm font-mono outline-none resize-none shadow-sm transition-colors bg-white border-[#d89745] text-[#3e3129] focus:ring-2 focus:ring-[#d89745]/30 h-full"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="Skill document content goes here..."
                    spellCheck="false"
                  />
                ) : (
                  <div className="flex-1 overflow-y-auto w-full p-6 border rounded-xl bg-[#fdfbf6] border-[#ebdcb9] text-[#534135]/90 cursor-default h-full">
                    {editContent.trim() === '' ? (
                      <div className="h-full flex flex-col items-center justify-center text-center opacity-50">
                        <FileText size={48} className="text-[#8c7463] mb-4" />
                        <p className="text-sm font-mono text-[#8c7463]">This skill has no content yet.</p>
                      </div>
                    ) : (
                      <div className="prose prose-sm prose-orange max-w-none prose-headings:font-extrabold prose-a:text-[#d89745]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {editContent}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                )}
                
                {!isEditing && (
                  <div className="absolute inset-x-0 bottom-4 text-center pointer-events-none">
                    <span className="bg-[#fdfbf6]/90 backdrop-blur-sm text-[#8c7463] text-[10px] font-mono font-bold px-3 py-1.5 rounded-full border border-[#ebdcb9] shadow-sm">
                      Read-Only Mode
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
