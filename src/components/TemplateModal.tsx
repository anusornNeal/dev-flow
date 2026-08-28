import React, { useState, useEffect } from 'react';
import { X, Save, FileText, Edit2, Ban, ChevronRight, Eye, Lock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface TemplateModalProps {
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
  masterAvailable?: boolean;
  overrideAvailable?: boolean;
  masterContent?: string;
  overrideContent?: string;
  effectiveContent?: string;
}

export default function TemplateModal({ onClose }: TemplateModalProps) {
  const [sections, setSections] = useState<PromptSection[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [isEditingOverride, setIsEditingOverride] = useState(false);
  const [editContent, setEditContent] = useState('');
  
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewSections, setPreviewSections] = useState<{ skillId: string; content: string; isEmpty: boolean }[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    fetchSections();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const fetchSections = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/prompt-template/sections');
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
      if (selectedSection.masterContent === undefined && selectedSection.effectiveContent === undefined) {
        fetch(`/api/prompt-template/section?sectionId=${selectedSection.id}`)
          .then(res => res.json())
          .then(data => {
            if (data.section) {
              setSections(prev => prev.map(s => s.id === selectedSection.id ? { ...s, ...data.section } : s));
            }
          })
          .catch(err => console.error('Failed to load section content:', err));
      } else {
        setEditContent(selectedSection.overrideContent !== undefined ? selectedSection.overrideContent : (selectedSection.masterContent || ''));
        setIsEditingOverride(false);
        setPreviewContent(null);
      }
    }
  }, [selectedSectionId, selectedSection?.masterContent]);

  const handleSaveOverride = async () => {
    if (!selectedSectionId) return;
      setSaving(true);
    try {
      await fetch('/api/prompt-template/section', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId: selectedSectionId, content: editContent })
      });
      await fetchSections();
      setIsEditingOverride(false);
    } catch (err) {
      console.error('Failed to save override:', err);
    }
    setSaving(false);
  };

  const handlePreviewFinalPrompt = async () => {
    setLoadingPreview(true);
    try {
      const res = await fetch('/api/prompt-template/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (data.content !== undefined) {
        setPreviewContent(data.content);
        setPreviewSections(data.sections || null);
        setSelectedSectionId(null);
      }
    } catch (err) {
      console.error('Failed to load preview:', err);
    }
    setLoadingPreview(false);
  };

  return (
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close prompt template backdrop" className="fixed inset-0 cursor-default" onClick={onClose} />
      <div className="df-dialog relative z-10 flex h-[85vh] w-full max-w-6xl overflow-hidden select-none" role="dialog" aria-modal="true" aria-label="Global prompt template">
        
        {/* Left Sidebar: Section List */}
        <div className="flex w-1/3 min-w-0 flex-col border-r border-df-border bg-df-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-df-border px-6 py-4">
            <h2 className="flex min-w-0 items-center gap-2 font-sans text-lg font-extrabold text-[var(--df-color-text-strong)]">
              <FileText size={20} className="shrink-0 text-df-accent" />
              Global Prompt Template
            </h2>
          </div>
          
          <div className="shrink-0 border-b border-df-border bg-df-surface-muted p-4">
             <button
                onClick={handlePreviewFinalPrompt}
                disabled={loadingPreview}
                className="df-button df-button--primary w-full text-xs"
              >
                <Eye size={14} />
                {loadingPreview ? 'Loading Preview...' : 'Preview Final Prompt'}
              </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loading ? (
              <div className="p-2 font-mono text-sm text-df-text-muted">Loading template...</div>
            ) : sections.length === 0 ? (
              <div className="p-2 font-mono text-sm text-df-text-muted">No sections found.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {sections.map((section, idx) => {
                  const isSelected = section.id === selectedSectionId;
                  const missingRequired = section.required && !section.masterAvailable && !section.overrideAvailable;
                  
                  return (
                    <button
                      key={section.id}
                      onClick={() => {
                        setSelectedSectionId(section.id);
                        setPreviewContent(null);
                      }}
                      className={`text-left p-3 rounded-xl border transition-all flex flex-col gap-1 ${
                        isSelected
                          ? 'border-df-accent bg-[var(--df-color-surface-subtle)] shadow-[var(--df-shadow-sm)]'
                          : missingRequired 
                            ? 'border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-900/20 opacity-80'
                             : 'border-df-border bg-df-surface-raised hover:border-[var(--df-color-border-strong)] hover:shadow-[var(--df-shadow-sm)]'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-bold text-df-text">
                           <span className="text-[10px] text-df-text-muted">{String(section.order).padStart(2, '0')}.</span>
                           {section.title}
                        </span>
                        <ChevronRight size={14} className={isSelected ? "text-df-accent" : "text-df-text-muted opacity-0 group-hover:opacity-100"} />
                      </div>
                      <div className="flex items-center gap-2 text-[9px] uppercase tracking-widest font-bold">
                        {section.sourceType === 'override' ? (
                          <span className="flex items-center gap-1 rounded bg-df-surface-muted px-1.5 py-0.5 text-df-text-muted">
                            <Lock size={8} /> Master
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 rounded bg-df-surface-muted px-1.5 py-0.5 text-df-text-muted">
                            <Lock size={8} /> Master
                          </span>
                        )}
                        {section.required ? (
                          <span className="text-df-text-muted">Required</span>
                        ) : (
                          <span className="text-df-text-muted">Optional</span>
                        )}
                        {missingRequired && (
                           <span className="flex items-center gap-1 text-df-danger">
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
        <div className="flex min-w-0 flex-1 flex-col bg-df-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-df-border bg-df-surface px-6 py-4">
            {previewContent !== null ? (
               <div className="flex flex-col gap-1">
                  <h3 className="flex items-center gap-2 text-lg font-extrabold text-[var(--df-color-text-strong)]">
                    Final Prompt Preview
                  </h3>
                  <span className="font-mono text-xs text-df-text-muted">
                     Rendered sequence of all sections
                  </span>
               </div>
            ) : selectedSection ? (
              <>
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <h3 className="flex min-w-0 items-center gap-2 break-words text-lg font-extrabold text-[var(--df-color-text-strong)]">
                    {selectedSection.title}
                  </h3>
                  <span className="df-meta df-break-technical font-mono" title={selectedSection.sourcePath}>
                    {selectedSection.sourcePath}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {!isEditingOverride && (
                     <button
                        onClick={() => {
                          setIsEditingOverride(true);
                          setEditContent(selectedSection.sourceType === 'override' ? (selectedSection.overrideContent || '') : (selectedSection.masterContent || ''));
                        }}
                        className="df-button df-button--secondary min-w-0 px-3 text-xs"
                     >
                        <Edit2 size={12} /> Edit Master
                     </button>
                  )}
                  {isEditingOverride && (
                    <>
                      <button
                        onClick={() => {
                          setIsEditingOverride(false);
                          setEditContent(selectedSection.masterContent || '');
                        }}
                        className="df-button df-button--secondary min-w-0 px-3 text-xs"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSaveOverride}
                        disabled={saving}
                        className="df-button df-button--primary min-w-0 px-3 text-xs"
                      >
                        <Save size={12} /> {saving ? 'Saving...' : 'Save Master'}
                      </button>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="h-[28px]" />
            )}
            
            <button
              type="button"
              onClick={onClose}
              aria-label="Close prompt template"
              className="df-icon-button ml-4 shrink-0"
            >
              <X size={20} />
            </button>
          </div>

          <div className="relative flex-1 overflow-hidden bg-df-surface">
             {previewContent !== null ? (
                <div className="absolute inset-0 p-6 overflow-y-auto space-y-4">
                  {previewSections && previewSections.length > 0 ? (
                    previewSections.map((sec, idx) => {
                      const sectionMeta = sections.find(s => s.id === sec.skillId);
                      const orderStr = sectionMeta ? String(sectionMeta.order).padStart(2, '0') : String(idx + 1).padStart(2, '0');
                      
                      return (
                        <div key={idx} className="flex flex-col gap-2">
                          <div className="flex items-center gap-2 font-mono text-sm font-bold text-[var(--df-color-text-strong)]">
                            <span className="text-df-accent">{orderStr}</span>
                            {sec.skillId}
                          </div>
                          <div className="min-h-[60px] overflow-hidden rounded-xl border border-df-border bg-df-surface-raised p-4 shadow-[var(--df-shadow-sm)]">
                            {sec.isEmpty ? (
                              <div className="py-4 text-center font-mono text-xs italic text-df-text-muted opacity-60">
                                Empty in preview
                              </div>
                            ) : (
                              <div className="prose prose-sm max-w-none text-df-text prose-headings:font-extrabold prose-a:text-df-accent dark:prose-invert">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                  {sec.content}
                                </ReactMarkdown>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="prose prose-sm max-w-none text-df-text prose-headings:font-extrabold prose-a:text-df-accent dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {previewContent}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
             ) : selectedSection ? (
               isEditingOverride ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="absolute inset-0 h-full w-full resize-none border-none bg-transparent p-6 font-mono text-sm leading-relaxed text-df-text outline-none focus:ring-0"
                    spellCheck={false}
                    placeholder="Edit the global prompt template section..."
                  />
               ) : (
                  <div className="absolute inset-0 p-6 overflow-y-auto">
                     {selectedSection.effectiveContent ? (
                       <div className={`prose prose-sm max-w-none text-df-text prose-headings:font-extrabold prose-a:text-df-accent dark:prose-invert ${selectedSection.sourceType === 'master' ? 'opacity-80' : ''}`}>
                         <ReactMarkdown remarkPlugins={[remarkGfm]}>
                           {selectedSection.effectiveContent}
                         </ReactMarkdown>
                       </div>
                     ) : (
                       <div className="h-full flex items-center justify-center">
                         <div className="flex flex-col items-center gap-2 text-center font-mono text-sm text-df-text-muted">
                           <Ban size={24} className="opacity-50" />
                           <p>No content available for this section.</p>
                         </div>
                       </div>
                     )}
                  </div>
               )
             ) : (
               <div className="flex h-full items-center justify-center font-mono text-sm text-df-text-muted">
                 Select a section to view or edit
               </div>
             )}
          </div>
        </div>
      </div>
    </div>
  );
}
