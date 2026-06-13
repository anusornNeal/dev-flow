import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Edit2, Ban, ChevronRight, Copy, Eye, Lock, Trash2 } from 'lucide-react';

interface TemplateModalProps {
  projectId: string;
  onClose: () => void;
}

interface PromptSection {
  id: string;
  rawId?: string;
  title: string;
  order: number;
  required: boolean;
  sourcePath: string;
  sourceType: 'master' | 'override';
  masterContent: string;
  overrideContent?: string;
  effectiveContent: string;
}

export default function TemplateModal({ projectId, onClose }: TemplateModalProps) {
  const [sections, setSections] = useState<PromptSection[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [isEditingOverride, setIsEditingOverride] = useState(false);
  const [editContent, setEditContent] = useState('');
  
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    fetchSections();
  }, [projectId]);

  const fetchSections = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/projects/${projectId}/prompt-sections`);
      const data = await res.json();
      if (data.sections) {
        setSections(data.sections);
        if (data.sections.length > 0 && !selectedSectionId) {
          setSelectedSectionId(data.sections[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to load prompt sections:', err);
    } finally {
      setLoading(false);
    }
  };

  const selectedSection = sections.find(s => s.id === selectedSectionId) || null;

  useEffect(() => {
    if (selectedSection) {
      setEditContent(selectedSection.overrideContent !== undefined ? selectedSection.overrideContent : '');
      setIsEditingOverride(selectedSection.sourceType === 'override');
      setPreviewContent(null);
    }
  }, [selectedSectionId, selectedSection?.sourceType]);

  const handleSaveOverride = async () => {
    if (!selectedSectionId) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}/prompt-overrides/${selectedSectionId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent })
      });
      await fetchSections();
    } catch (err) {
      console.error('Failed to save override:', err);
    }
    setSaving(false);
  };

  const handleResetToMaster = async () => {
    if (!selectedSectionId) return;
    if (!confirm('Are you sure you want to delete this override and revert to the master template?')) return;
    setSaving(true);
    try {
      await fetch(`/api/projects/${projectId}/prompt-overrides/${selectedSectionId}`, {
        method: 'DELETE'
      });
      setIsEditingOverride(false);
      setEditContent('');
      await fetchSections();
    } catch (err) {
      console.error('Failed to reset override:', err);
    }
    setSaving(false);
  };

  const handlePreviewFinalPrompt = async () => {
    setLoadingPreview(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/prompt-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.content) {
        setPreviewContent(data.content);
        setSelectedSectionId(null);
      }
    } catch (err) {
      console.error('Failed to load preview:', err);
    }
    setLoadingPreview(false);
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 dark:bg-[#f3eadf]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] dark:bg-[#1e1914] rounded-2xl shadow-xl w-full max-w-6xl h-[85vh] flex border border-[#e5d4bb] dark:border-[#584a3b] overflow-hidden select-none">
        
        {/* Left Sidebar: Section List */}
        <div className="w-1/3 border-r border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#1e1914] flex flex-col">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-between shrink-0">
            <h2 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-lg flex items-center gap-2">
              <FileText size={20} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
              Prompt Template
            </h2>
          </div>
          
          <div className="p-4 border-b border-[#ebdcb9] dark:border-[#584a3b] shrink-0 bg-[#f4ebd9] dark:bg-[#1e1914]">
             <button
                onClick={handlePreviewFinalPrompt}
                disabled={loadingPreview}
                className="w-full py-2 bg-[#d89745] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] font-bold rounded-lg shadow-sm hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] transition-colors flex items-center justify-center gap-2 text-xs"
              >
                <Eye size={14} />
                {loadingPreview ? 'Loading Preview...' : 'Preview Final Prompt'}
              </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loading ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">Loading template...</div>
            ) : sections.length === 0 ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">No sections found.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {sections.map((section, idx) => {
                  const isSelected = section.id === selectedSectionId;
                  const missingRequired = section.required && !section.masterContent && !section.overrideContent;
                  
                  return (
                    <button
                      key={section.id}
                      onClick={() => {
                        setSelectedSectionId(section.id);
                        setPreviewContent(null);
                      }}
                      className={`text-left p-3 rounded-xl border transition-all flex flex-col gap-1 ${
                        isSelected
                          ? 'border-[#d89745] dark:border-[#e0a070] bg-[#fff9ee] dark:bg-[#1e1914] shadow-sm'
                          : missingRequired 
                            ? 'border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-900/20 opacity-80'
                            : 'border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] hover:border-[#d8c5aa] dark:border-[#584a3b] dark:hover:border-[#6b5a48] hover:shadow-xs'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-[#534135] dark:text-[#f3eadf] font-mono flex items-center gap-1.5">
                           <span className="text-[9px] text-[#b89b82] dark:text-[#8c7463]">{String(section.order).padStart(2, '0')}.</span>
                           {section.title}
                        </span>
                        <ChevronRight size={14} className={isSelected ? "text-[#d89745] dark:text-[#e0a070]" : "text-[#c2ae9a] dark:text-[#6b5a48] opacity-0 group-hover:opacity-100"} />
                      </div>
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest font-bold">
                        {section.sourceType === 'override' ? (
                          <span className="text-[#a46c24] dark:text-[#d6b56d] bg-[#fdf5e6] dark:bg-[#382b1d] px-1.5 py-0.5 rounded flex items-center gap-1">
                            <Edit2 size={8} /> Override
                          </span>
                        ) : (
                          <span className="text-[#8c7463] dark:text-[#8c7463] bg-[#f4ebd9] dark:bg-[#1e1914] px-1.5 py-0.5 rounded flex items-center gap-1">
                            <Lock size={8} /> Master
                          </span>
                        )}
                        {section.required ? (
                          <span className="text-[#b89b82] dark:text-[#8c7463]">Required</span>
                        ) : (
                          <span className="text-[#b89b82] dark:text-[#8c7463]">Optional</span>
                        )}
                        {missingRequired && (
                           <span className="text-red-500 flex items-center gap-1">
                             <Ban size={8} /> Missing
                           </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Content Area */}
        <div className="flex-1 flex flex-col bg-[#fffdfa] dark:bg-[#1e1914] min-w-0">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-between shrink-0 bg-[#fdfbf6] dark:bg-[#1e1914]">
            {previewContent !== null ? (
               <div className="flex flex-col gap-1">
                  <h3 className="text-[#534135] dark:text-[#f3eadf] font-extrabold text-lg flex items-center gap-2">
                    Final Prompt Preview
                  </h3>
                  <span className="text-xs font-mono text-[#8C7565] dark:text-[#8c7463]">
                     Rendered sequence of all sections
                  </span>
               </div>
            ) : selectedSection ? (
              <>
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <h3 className="text-[#534135] dark:text-[#f3eadf] font-extrabold text-lg flex items-center gap-2 truncate">
                    {selectedSection.title}
                  </h3>
                  <span className="text-xs font-mono text-[#8C7565] dark:text-[#8c7463] truncate" title={selectedSection.sourcePath}>
                    {selectedSection.sourcePath}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {selectedSection.sourceType === 'master' && !isEditingOverride && (
                     <button
                        onClick={() => {
                          setIsEditingOverride(true);
                          setEditContent(selectedSection.masterContent || '');
                        }}
                        className="px-3 py-1.5 text-xs font-bold bg-[#f4ebd9] dark:bg-[#1e1914] text-[#7a6455] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#382b1d] rounded-lg transition-colors flex items-center gap-1.5 border border-[#d8c5aa] dark:border-[#584a3b]"
                     >
                        <Edit2 size={12} /> Create Override
                     </button>
                  )}
                  {isEditingOverride && (
                    <>
                      <button
                        onClick={handleResetToMaster}
                        className="p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors border border-transparent hover:border-red-200 dark:hover:border-red-900"
                        title="Delete Override and Reset to Master"
                      >
                        <Trash2 size={14} />
                      </button>
                      <button
                        onClick={() => setEditContent(selectedSection.masterContent || '')}
                        className="px-3 py-1.5 text-xs font-bold text-[#7a6455] dark:text-[#f3eadf] bg-[#f4ebd9] dark:bg-[#1e1914] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#382b1d] rounded-lg transition-colors flex items-center gap-1.5 border border-[#d8c5aa] dark:border-[#584a3b]"
                        title="Copy from Master"
                      >
                        <Copy size={12} /> Copy Master
                      </button>
                      <button
                        onClick={handleSaveOverride}
                        disabled={saving}
                        className="px-3 py-1.5 text-xs font-bold bg-[#d89745] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] rounded-lg transition-colors flex items-center gap-1.5"
                      >
                        <Save size={12} /> {saving ? 'Saving...' : 'Save Override'}
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="h-[28px]" />
            )}
            
            <button
              onClick={onClose}
              className="ml-4 p-1.5 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 rounded-lg text-[#8C7565] dark:text-[#f3eadf] transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-hidden relative bg-[#fffdfa] dark:bg-[#1e1914]">
             {previewContent !== null ? (
                <div className="absolute inset-0 p-6 overflow-y-auto font-mono text-xs text-[#534135] dark:text-[#f3eadf] whitespace-pre-wrap">
                   {previewContent}
                </div>
             ) : selectedSection ? (
               isEditingOverride ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="absolute inset-0 w-full h-full p-6 bg-transparent border-none outline-none font-mono text-sm text-[#534135] dark:text-[#f3eadf] resize-none focus:ring-0 leading-relaxed"
                    spellCheck={false}
                    placeholder="Enter your project-specific override for this section..."
                  />
               ) : (
                  <div className="absolute inset-0 p-6 overflow-y-auto">
                     {selectedSection.masterContent ? (
                       <div className="font-mono text-sm text-[#534135] dark:text-[#f3eadf] whitespace-pre-wrap leading-relaxed opacity-80">
                         {selectedSection.masterContent}
                       </div>
                     ) : (
                       <div className="h-full flex items-center justify-center">
                         <div className="text-center text-[#8C7565] dark:text-[#8c7463] font-mono text-sm flex flex-col items-center gap-2">
                           <Ban size={24} className="opacity-50" />
                           <p>No master content available for this section.</p>
                         </div>
                       </div>
                     )}
                  </div>
               )
             ) : (
               <div className="h-full flex items-center justify-center text-[#8C7565] dark:text-[#8c7463] font-mono text-sm">
                 Select a section to view or edit
               </div>
             )}
          </div>
        </div>
      </div>
    </div>
  );
}
