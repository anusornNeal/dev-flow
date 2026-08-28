import React, { useEffect, useMemo, useState } from 'react';
import { X, FileText, Lock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REVIEWER_SKILL_ID = 'ready-for-review-reviewer-skill';

interface SkillsModalProps {
  onClose: () => void;
}

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  isProtected?: boolean;
  content: string;
}

export default function SkillsModal({ onClose }: SkillsModalProps) {
  const [skills, setSkills] = useState<SkillDetail[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const mergeSkills = (items: SkillDetail[]) => {
    const map = new Map<string, SkillDetail>();
    for (const item of items) {
      map.set(item.id, item);
    }
    return Array.from(map.values());
  };

  useEffect(() => {
    const loadSkills = async () => {
      try {
        const [authoringResponse, reviewerResponse] = await Promise.all([
          fetch('/api/skills/authoring'),
          fetch(`/api/skills/${REVIEWER_SKILL_ID}`),
        ]);

        const authoringData = await authoringResponse.json();
        const reviewerData = reviewerResponse.ok ? await reviewerResponse.json() : null;

        const nextSkills = mergeSkills([
          ...(Array.isArray(authoringData) ? authoringData : []),
          ...(reviewerData ? [reviewerData] : []),
        ]);

        setSkills(nextSkills);
        setSelectedSkillId(nextSkills[0]?.id || null);
      } catch (err) {
        console.error('Failed to load authoring skills:', err);
        setSkills([]);
        setSelectedSkillId(null);
      } finally {
        setLoading(false);
      }
    };

    void loadSkills();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const selectedSkill = useMemo(() => {
    return skills.find((skill) => skill.id === selectedSkillId) || null;
  }, [skills, selectedSkillId]);

  return (
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="df-dialog relative z-10 flex h-[85vh] w-full max-w-6xl overflow-hidden select-none" role="dialog" aria-modal="true" aria-label="Authoring skills">
        <div className="flex w-1/3 min-w-0 flex-col border-r border-df-border bg-df-surface">
          <div className="flex shrink-0 items-center justify-between border-b border-df-border px-6 py-4">
            <h2 className="flex min-w-0 items-center gap-2 font-sans text-lg font-extrabold text-[var(--df-color-text-strong)]">
              <FileText size={20} className="shrink-0 text-df-accent" />
              Authoring skill
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-wider text-df-text-muted">
              Authoring only
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loading ? (
              <div className="p-2 font-mono text-sm text-df-text-muted">Loading skills...</div>
            ) : skills.length === 0 ? (
              <div className="p-2 font-mono text-sm text-df-text-muted">No skills available.</div>
            ) : (
              skills.map((skill) => {
                const isSelected = skill.id === selectedSkillId;
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => setSelectedSkillId(skill.id)}
                    className={`flex items-center w-full justify-between p-3 rounded-xl border transition-all text-left ${
                      isSelected
                        ? 'border-df-accent bg-[var(--df-color-surface-subtle)] text-df-accent shadow-[var(--df-shadow-sm)]'
                         : 'border-df-border bg-df-surface-raised text-df-text hover:bg-df-surface-muted'
                    }`}
                  >
                    <div className="flex-1 min-w-0 pr-6">
                      <div className="flex min-w-0 items-center gap-1.5 break-words text-sm font-extrabold">
                        {skill.name}
                        <span title="Protected Master Skill">
                          <Lock size={10} className="text-df-text-muted" />
                        </span>
                      </div>
                      <div className="mt-1 line-clamp-1 font-mono text-[10px] text-df-text-muted">
                        {skill.description}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="flex w-2/3 min-w-0 flex-col bg-df-canvas">
          <div className="flex h-[69px] shrink-0 items-center justify-between border-b border-df-border bg-df-surface px-6 py-4">
            {loading ? (
              <div className="font-mono text-sm text-df-text-muted">Loading details...</div>
            ) : selectedSkill ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="break-words font-sans text-base font-extrabold text-[var(--df-color-text-strong)]">{selectedSkill.name}</h3>
                  <p className="df-meta mt-1 break-words font-mono">{selectedSkill.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 rounded-lg border border-df-border bg-df-surface-muted px-3 py-1.5 text-xs font-bold text-df-text-muted shadow-[var(--df-shadow-sm)]">
                    <Lock size={14} /> Master skill
                  </span>
                  <div className="mx-1 h-5 w-px bg-df-border" />
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close skills dialog"
                    className="df-icon-button"
                    title="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close skills dialog"
                  className="df-icon-button"
                  title="Close"
                >
                  <X size={18} />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 overflow-hidden flex flex-col relative select-text">
            {loading ? (
              <div className="flex flex-1 items-center justify-center font-mono text-sm text-df-text-muted">
                Loading skill...
              </div>
            ) : !selectedSkill ? (
              <div className="flex flex-1 items-center justify-center font-mono text-sm text-df-text-muted">
                No skill content available.
              </div>
            ) : (
              <div className="flex-1 flex flex-col relative h-full">
                <div className="h-full w-full flex-1 cursor-default overflow-y-auto rounded-xl border border-df-border bg-df-surface p-6 text-df-text">
                  {selectedSkill.content.trim() === '' ? (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-50">
                      <FileText size={48} className="mb-4 text-df-text-muted" />
                      <p className="font-mono text-sm text-df-text-muted">This skill has no content yet.</p>
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none text-df-text prose-headings:font-extrabold prose-a:text-df-accent dark:prose-invert">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedSkill.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>

                <div className="absolute inset-x-0 bottom-4 text-center pointer-events-none">
                  <span className="rounded-full border border-df-border bg-df-surface/90 px-3 py-1.5 font-mono text-[10px] font-bold text-df-text-muted shadow-[var(--df-shadow-sm)] backdrop-blur-sm">
                    Read-Only Mode
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
