import React, { useEffect, useMemo, useState } from 'react';
import { X, FileText, Lock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

  useEffect(() => {
    fetch('/api/skills/authoring')
      .then((res) => res.json())
      .then((data) => {
        const nextSkills = Array.isArray(data) ? data : [];
        setSkills(nextSkills);
        setSelectedSkillId(nextSkills[0]?.id || null);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load authoring skills:', err);
        setSkills([]);
        setSelectedSkillId(null);
        setLoading(false);
      });
  }, []);

  const selectedSkill = useMemo(() => {
    return skills.find((skill) => skill.id === selectedSkillId) || null;
  }, [skills, selectedSkillId]);

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 dark:bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="bg-[#fffdfa] dark:bg-[#1e1914] rounded-2xl shadow-xl w-full max-w-6xl h-[85vh] flex border border-[#e5d4bb] dark:border-[#584a3b] overflow-hidden select-none relative z-10">
        <div className="w-1/3 border-r border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#1e1914] flex flex-col">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-between shrink-0">
            <h2 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-lg flex items-center gap-2">
              <FileText size={20} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
              Authoring skill
            </h2>
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#8c7463] dark:text-[#f3eadf]">
              Authoring only
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
            {loading ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">Loading skills...</div>
            ) : skills.length === 0 ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf] p-2">No skills available.</div>
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
                        ? 'bg-[#ffecca] dark:bg-[#1e1914] border-[#e3a35a] dark:border-[#584a3b] shadow-sm text-[#935919] dark:text-[#e0a070] dark:text-[#d6b56d]'
                        : 'bg-white dark:bg-[#1e1914] border-[#e5d4bb] dark:border-[#584a3b] hover:bg-[#faf6ef] dark:hover:bg-[#584a3b]/40 text-[#534135] dark:text-[#f3eadf]'
                    }`}
                  >
                    <div className="flex-1 min-w-0 pr-6">
                      <div className="font-extrabold text-sm flex items-center gap-1.5">
                        {skill.name}
                        <span title="Protected Master Skill">
                          <Lock size={10} className="text-[#c4a991] dark:text-[#d6b56d]" />
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-[#8a725f] dark:text-[#f3eadf] mt-1 line-clamp-1">
                        {skill.description}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div className="w-2/3 flex flex-col bg-[#f5f2eb] dark:bg-[#1e1914]">
          <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#1e1914] flex items-center justify-between shrink-0 h-[69px]">
            {loading ? (
              <div className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf]">Loading details...</div>
            ) : selectedSkill ? (
              <div className="flex-1 flex items-center justify-between">
                <div>
                  <h3 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-base">{selectedSkill.name}</h3>
                  <p className="text-[10px] font-mono text-[#8a725f] dark:text-[#f3eadf]">{selectedSkill.description}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="bg-[#fff7eb] dark:bg-[#1e1914] border border-[#f0d9b2] dark:border-[#584a3b] text-[#9a6a27] dark:text-[#f3eadf] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 shadow-sm">
                    <Lock size={14} /> Master skill
                  </span>
                  <div className="w-px h-5 bg-[#ebdcb9] dark:bg-[#584a3b] mx-1" />
                  <button
                    type="button"
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
                  type="button"
                  onClick={onClose}
                  className="text-[#8c7463] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 p-1.5 rounded-lg transition-colors"
                  title="Close"
                >
                  <X size={18} />
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 overflow-hidden flex flex-col relative select-text">
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-[#8a6e5a] dark:text-[#f3eadf] font-mono text-sm">
                Loading skill...
              </div>
            ) : !selectedSkill ? (
              <div className="flex-1 flex items-center justify-center text-[#8a6e5a] dark:text-[#f3eadf] font-mono text-sm">
                No skill content available.
              </div>
            ) : (
              <div className="flex-1 flex flex-col relative h-full">
                <div className="flex-1 overflow-y-auto w-full p-6 border rounded-xl bg-[#fdfbf6] dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#534135]/90 dark:text-[#f3eadf]/90 cursor-default h-full">
                  {selectedSkill.content.trim() === '' ? (
                    <div className="h-full flex flex-col items-center justify-center text-center opacity-50">
                      <FileText size={48} className="text-[#8c7463] dark:text-[#f3eadf] mb-4" />
                      <p className="text-sm font-mono text-[#8c7463] dark:text-[#f3eadf]">This skill has no content yet.</p>
                    </div>
                  ) : (
                    <div className="prose prose-sm prose-orange max-w-none prose-headings:font-extrabold prose-a:text-[#d89745] dark:prose-invert dark:prose-headings:text-[#e0a070] dark:text-[#f3eadf]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedSkill.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>

                <div className="absolute inset-x-0 bottom-4 text-center pointer-events-none">
                  <span className="bg-[#fdfbf6]/90 dark:bg-[#1e1914]/90 backdrop-blur-sm text-[#8c7463] dark:text-[#f3eadf] text-[10px] font-mono font-bold px-3 py-1.5 rounded-full border border-[#ebdcb9] dark:border-[#584a3b] shadow-sm">
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
