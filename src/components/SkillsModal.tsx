import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Edit2, Ban, ChevronRight, Plus, Lock, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SkillsModalProps {
  onClose: () => void;
}

interface SkillMeta {
  id: string;
  name: string;
  description: string;
  isCustom?: boolean;
  isProtected?: boolean;
  kind?: string;
}

interface SkillDetail extends SkillMeta {
  content: string;
}

export default function SkillsModal({ onClose }: SkillsModalProps) {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  
  type TabKey = 'authoring' | 'workflow' | 'prompt' | 'custom';
  const [activeTab, setActiveTab] = useState<TabKey>('authoring');

  const TABS = [
    { id: 'authoring', label: 'Authoring' },
    { id: 'workflow', label: 'Workflows' },
    { id: 'prompt', label: 'Templates' },
    { id: 'custom', label: 'Custom' },
  ];

  
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

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this custom skill?')) return;
    try {
      const res = await fetch(`/api/skills/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      const data = await fetch('/api/skills').then(r => r.json());
      setSkills(data);
      if (selectedSkillId === id) {
        setSelectedSkillId(data.length > 0 ? data[0].id : null);
        setSkillDetail(null);
        setIsEditing(false);
      }
    } catch (err) {
      console.error('Delete failed:', err);
      alert('Failed to delete skill');
    }
  };

  const getTabSkills = () => {
    switch (activeTab) {
      case 'authoring':
        return skills.filter(s => ['schema', 'playbook'].includes(s.id));
      case 'workflow':
        return skills.filter(s => s.id.endsWith('-workflow'));
      case 'prompt':
        return skills.filter(s => s.id === 'agent-task-prompt-template');
      case 'custom':
      default:
        return skills.filter(s => !['schema', 'playbook', 'agent-task-prompt-template'].includes(s.id) && !s.id.endsWith('-workflow'));
    }
  };

  const displayedSkills = getTabSkills();


  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 dark:bg-[#f3eadf]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] dark:bg-[#1e1914] rounded-2xl shadow-xl w-full max-w-6xl h-[85vh] flex border border-[#e5d4bb] dark:border-[#584a3b] overflow-hidden select-none">
        
        {/* Left Sidebar: Skill List */}
        <div className="w-1/3 border-r border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#292119] flex flex-col">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-between shrink-0">
            <h2 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-lg flex items-center gap-2">
              <FileText size={20} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
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
              className="p-1.5 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 rounded-lg text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] transition-colors"
              title="Import Skill"
            >
              <Plus size={18} />
            </button>
          </div>
          {/* Tabs */}
          <div className="flex px-4 pt-2 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] overflow-x-auto no-scrollbar gap-1 shrink-0">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabKey)}
                className={`whitespace-nowrap px-3 py-2 text-[10px] font-bold uppercase tracking-wider border-b-2 transition-colors ${
                  activeTab === tab.id 
                    ? 'border-[#d89745] dark:border-[#e0a070] text-[#935919] dark:text-[#e0a070] dark:text-[#d6b56d]' 
                    : 'border-transparent dark:border-transparent text-[#b89b82] dark:text-[#d6b56d] hover:text-[#935919] dark:hover:text-[#e0a070] dark:text-[#d6b56d]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loadingList ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">Loading skills...</div>
            ) : skills.length === 0 ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">No skills available.</div>
            ) : displayedSkills.length === 0 ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">No skills in this category.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {displayedSkills.map(skill => {
                  const isSelected = skill.id === selectedSkillId;
                  return (
                    <div key={skill.id} className="relative group">
                      <button
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
                        className={`flex items-center w-full justify-between p-3 rounded-xl border transition-all text-left ${
                          isSelected
                            ? 'bg-[#ffecca] dark:bg-[#292119] border-[#e3a35a] dark:border-[#584a3b] shadow-sm text-[#935919] dark:text-[#e0a070] dark:text-[#d6b56d]'
                            : 'bg-white dark:bg-[#292119] border-[#e5d4bb] dark:border-[#584a3b] hover:bg-[#faf6ef] dark:bg-[#292119] dark:hover:bg-[#584a3b]/40 text-[#534135] dark:text-[#f3eadf]'
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-6">
                          <div className="font-extrabold text-sm flex items-center gap-1.5">
                            {skill.name}
                            {!skill.isCustom && (
                              <span title="Protected Master Skill">
                                <Lock size={10} className="text-[#c4a991] dark:text-[#d6b56d]" />
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-[#8a725f] dark:text-[#f3eadf] mt-1 line-clamp-1">{skill.description}</div>
                        </div>
                        {isSelected && <ChevronRight size={16} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] shrink-0" />}
                      </button>
                      {skill.isCustom && (
                        <button
                          onClick={(e) => handleDelete(e, skill.id)}
                          className="absolute right-2 top-3 p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Delete custom skill"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Area: Detail/Editor */}
        <div className="w-2/3 flex flex-col bg-[#f5f2eb] dark:bg-[#292119]">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#292119] flex items-center justify-between shrink-0 h-[69px]">
            {isImporting ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-base">Import New Skill</h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (skills.length > 0) setSelectedSkillId(skills[0].id);
                      setIsImporting(false);
                    }}
                    disabled={saving}
                    className="bg-white dark:bg-[#292119] hover:bg-rose-50 dark:hover:bg-rose-900/20 border border-rose-200 dark:border-rose-900/50 text-rose-600 dark:text-rose-400 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Ban size={14} /> Cancel
                  </button>
                  <button
                    onClick={handleImportSave}
                    disabled={saving}
                    className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] hover:bg-[#1a5b67] dark:bg-[#3c829e] dark:hover:bg-[#292119] text-white dark:text-[#f3eadf] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Save size={14} /> {saving ? 'Saving...' : 'Import'}
                  </button>
                  <div className="w-px h-5 bg-[#ebdcb9] dark:bg-[#584a3b] mx-1"></div>
                  <button
                    onClick={onClose}
                    className="text-[#8c7463] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 p-1.5 rounded-lg transition-colors"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ) : loadingDetail ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf]">Loading details...</div>
            ) : skillDetail ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-base">{skillDetail.name}</h3>
                  <p className="text-[10px] font-mono text-[#8a725f] dark:text-[#f3eadf]">{skillDetail.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    skillDetail.isProtected ? (
                      <span className="bg-[#fff7eb] dark:bg-[#292119] border border-[#f0d9b2] dark:border-[#584a3b] text-[#9a6a27] dark:text-[#f3eadf] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm">
                        <Lock size={14} /> Master skill
                      </span>
                    ) : (
                      <button
                        onClick={() => setIsEditing(true)}
                        className="bg-white dark:bg-[#292119] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 border border-[#ebdcb9] dark:border-[#584a3b] text-[#534135] dark:text-[#f3eadf] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm"
                      >
                        <Edit2 size={14} /> Edit Skill
                      </button>
                    )
                  ) : (
                    <>
                      <button
                        onClick={handleCancelEdit}
                        disabled={saving}
                        className="bg-white dark:bg-[#292119] hover:bg-rose-50 dark:hover:bg-rose-900/20 border border-rose-200 dark:border-rose-900/50 text-rose-600 dark:text-rose-400 px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                      >
                        <Ban size={14} /> Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] hover:bg-[#1a5b67] dark:bg-[#3c829e] dark:hover:bg-[#292119] text-white dark:text-[#f3eadf] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                      >
                        <Save size={14} /> {saving ? 'Saving...' : 'Save Changes'}
                      </button>
                    </>
                  )}
                  <div className="w-px h-5 bg-[#ebdcb9] dark:bg-[#584a3b] mx-1"></div>
                  <button
                    onClick={onClose}
                    className="text-[#8c7463] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 p-1.5 rounded-lg transition-colors"
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
                  className="text-[#8c7463] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 p-1.5 rounded-lg transition-colors"
                >
                  <X size={18} />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 overflow-hidden flex flex-col relative select-text">
            {isImporting ? (
              <div 
                className={`flex-1 flex flex-col gap-4 overflow-y-auto transition-all duration-200 ${dragOver ? 'bg-[#d89745]/10 dark:bg-[#e0a070]/10 border-2 border-dashed border-[#d89745] dark:border-[#e0a070] p-4 rounded-xl shadow-inner' : ''}`}
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
                  <label className="text-xs font-extrabold text-[#534135] dark:text-[#f3eadf]">ID (Filename)</label>
                  <input
                    type="text"
                    value={importId}
                    onChange={(e) => setImportId(e.target.value)}
                    placeholder="e.g. my-new-skill"
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white dark:bg-[#292119] border-[#d89745] dark:border-[#e0a070] text-[#3e3129] dark:text-[#f3eadf] focus:ring-2 focus:ring-[#d89745]/30 dark:focus:ring-[#e0a070]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-xs font-extrabold text-[#534135] dark:text-[#f3eadf]">Name</label>
                  <input
                    type="text"
                    value={importName}
                    onChange={(e) => setImportName(e.target.value)}
                    placeholder="e.g. My New Skill"
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white dark:bg-[#292119] border-[#d89745] dark:border-[#e0a070] text-[#3e3129] dark:text-[#f3eadf] focus:ring-2 focus:ring-[#d89745]/30 dark:focus:ring-[#e0a070]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <label className="text-xs font-extrabold text-[#534135] dark:text-[#f3eadf]">Description</label>
                  <input
                    type="text"
                    value={importDescription}
                    onChange={(e) => setImportDescription(e.target.value)}
                    placeholder="Brief description..."
                    className="w-full p-2 border rounded-lg text-sm font-mono outline-none shadow-sm transition-colors bg-white dark:bg-[#292119] border-[#d89745] dark:border-[#e0a070] text-[#3e3129] dark:text-[#f3eadf] focus:ring-2 focus:ring-[#d89745]/30 dark:focus:ring-[#e0a070]/30"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-h-[200px]">
                  <label className="text-xs font-extrabold text-[#534135] dark:text-[#f3eadf]">Content (Markdown)</label>
                  <textarea
                    className="flex-1 w-full p-4 border rounded-xl text-sm font-mono outline-none resize-none shadow-sm transition-colors bg-white dark:bg-[#292119] border-[#d89745] dark:border-[#e0a070] text-[#3e3129] dark:text-[#f3eadf] focus:ring-2 focus:ring-[#d89745]/30 dark:focus:ring-[#e0a070]/30"
                    value={importContent}
                    onChange={(e) => setImportContent(e.target.value)}
                    placeholder="Skill document content goes here..."
                    spellCheck="false"
                  />
                </div>
              </div>
            ) : !skillDetail || loadingDetail ? (
              <div className="flex-1 flex items-center justify-center text-[#8a6e5a] dark:text-[#f3eadf] font-mono text-sm">
                No skill selected.
              </div>
            ) : (
              <div className="flex-1 flex flex-col relative h-full">
                {isEditing ? (
                  <textarea
                    className="flex-1 w-full p-6 border rounded-xl text-sm font-mono outline-none resize-none shadow-sm transition-colors bg-white dark:bg-[#292119] border-[#d89745] dark:border-[#e0a070] text-[#3e3129] dark:text-[#f3eadf] focus:ring-2 focus:ring-[#d89745]/30 dark:focus:ring-[#e0a070]/30 h-full"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="Skill document content goes here..."
                    spellCheck="false"
                  />
                ) : (
                  <div className="flex-1 overflow-y-auto w-full p-6 border rounded-xl bg-[#fdfbf6] dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] text-[#534135]/90 dark:text-[#f3eadf]/90 cursor-default h-full">
                    {editContent.trim() === '' ? (
                      <div className="h-full flex flex-col items-center justify-center text-center opacity-50">
                        <FileText size={48} className="text-[#8c7463] dark:text-[#f3eadf] mb-4" />
                        <p className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf]">This skill has no content yet.</p>
                      </div>
                    ) : (
                      <div className="prose prose-sm prose-orange max-w-none prose-headings:font-extrabold prose-a:text-[#d89745] dark:prose-invert dark:prose-headings:text-[#e0a070] dark:text-[#f3eadf]">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {editContent}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                )}
                
                {!isEditing && (
                  <div className="absolute inset-x-0 bottom-4 text-center pointer-events-none">
                    <span className="bg-[#fdfbf6]/90 dark:bg-[#292119]/90 backdrop-blur-sm text-[#8c7463] dark:text-[#f3eadf] text-[10px] font-mono font-bold px-3 py-1.5 rounded-full border border-[#ebdcb9] dark:border-[#584a3b] shadow-sm">
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
