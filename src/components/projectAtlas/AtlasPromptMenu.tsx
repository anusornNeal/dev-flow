import { useCallback, useRef, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { AtlasNode, ProjectAtlas } from '../../types.js';
import { buildProjectAtlasPrompt, PROJECT_ATLAS_PROMPT_VARIANTS, type ProjectAtlasPromptVariantId } from '../../lib/projectAtlasPromptTemplates.js';
import { useDismissOnOutsidePointer } from './useDismissOnOutsidePointer.js';

interface AtlasPromptMenuProps {
  atlas: ProjectAtlas | null;
  selectedNode: AtlasNode | null;
}

export function AtlasPromptMenu({ atlas, selectedNode }: AtlasPromptMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [copiedVariant, setCopiedVariant] = useState<ProjectAtlasPromptVariantId | null>(null);
  const disabled = !atlas;
  const closeMenu = useCallback(() => setOpen(false), []);

  useDismissOnOutsidePointer(containerRef, open, closeMenu);

  const copyPrompt = async (variantId: ProjectAtlasPromptVariantId) => {
    if (!atlas) return;
    const prompt = buildProjectAtlasPrompt(variantId, atlas, { selectedNodeId: selectedNode?.id });
    await navigator.clipboard?.writeText(prompt);
    setCopiedVariant(variantId);
    setOpen(false);
    window.setTimeout(() => setCopiedVariant(null), 1600);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        className="h-8 cursor-pointer rounded-lg border border-[#e5d4bb] bg-[#fffdfa] px-2.5 text-[11px] font-extrabold text-[#6d5a4d] transition hover:border-[#c9872c] hover:bg-[#fff7eb] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#f3eadf] dark:hover:bg-[#3a2f26]"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <ClipboardList size={14} className="mr-1 inline" /> Prompts
      </button>
      {copiedVariant && (
        <span className="absolute right-0 top-10 z-[90] rounded-md bg-[#8a4d0d] px-2 py-1 text-[10px] font-bold text-white shadow">
          Copied
        </span>
      )}
      {open && atlas && (
        <div className="absolute right-0 top-full z-[80] mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-[#d8c5aa] bg-[#fffdfa]/98 p-2.5 shadow-[0_18px_46px_rgba(90,62,26,0.20)] backdrop-blur dark:border-[#584a3b] dark:bg-[#1e1914]/98 dark:shadow-[0_18px_52px_rgba(0,0,0,0.45)]">
          <div className="border-b border-[#ead9c2] px-2 pb-2 dark:border-[#584a3b]">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Prompt Templates</p>
            <p className="mt-0.5 text-[10px] font-semibold text-[#8a6d55] dark:text-[#d8c5aa]">Copy an Atlas prompt for the selected context.</p>
          </div>
          <div className="mt-1.5 space-y-1">
            {PROJECT_ATLAS_PROMPT_VARIANTS.map((variant) => (
              <button
                key={variant.id}
                type="button"
                onClick={() => copyPrompt(variant.id)}
                className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-[11px] font-bold text-[#5c493c] transition hover:bg-[#fff1d7] hover:text-[#241f1a] dark:text-[#f3eadf] dark:hover:bg-[#3a2f26]"
              >
                <span className="min-w-0 truncate whitespace-nowrap">{variant.label}</span>
                <span className="shrink-0 rounded border border-[#ead9c2] px-1.5 py-0.5 text-[8px] font-black uppercase text-[#9a5b13] dark:border-[#584a3b] dark:text-[#f5a959]">Copy</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
