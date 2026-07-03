import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { AtlasNode, ProjectAtlas } from '../../types.js';
import { buildProjectAtlasPrompt, PROJECT_ATLAS_PROMPT_VARIANTS, type ProjectAtlasPromptVariantId } from '../../lib/projectAtlasPromptTemplates.js';

interface AtlasPromptMenuProps {
  atlas: ProjectAtlas | null;
  selectedNode: AtlasNode | null;
}

export function AtlasPromptMenu({ atlas, selectedNode }: AtlasPromptMenuProps) {
  const [open, setOpen] = useState(false);
  const [copiedVariant, setCopiedVariant] = useState<ProjectAtlasPromptVariantId | null>(null);
  const disabled = !atlas;

  const copyPrompt = async (variantId: ProjectAtlasPromptVariantId) => {
    if (!atlas) return;
    const prompt = buildProjectAtlasPrompt(variantId, atlas, { selectedNodeId: selectedNode?.id });
    await navigator.clipboard?.writeText(prompt);
    setCopiedVariant(variantId);
    setOpen(false);
    window.setTimeout(() => setCopiedVariant(null), 1600);
  };

  return (
    <div className="relative">
      <button
        className="h-9 cursor-pointer rounded-xl border border-[#e5d4bb] bg-[#fffdfa] px-3 text-[11px] font-extrabold text-[#6d5a4d] transition hover:border-[#c9872c] hover:bg-[#fff7eb] disabled:cursor-not-allowed disabled:opacity-60"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <ClipboardList size={14} className="mr-1 inline" /> Prompts
      </button>
      {copiedVariant && (
        <span className="absolute right-0 top-10 z-30 rounded-md bg-[#8a4d0d] px-2 py-1 text-[10px] font-bold text-white shadow">
          Copied
        </span>
      )}
      {open && atlas && (
        <div className="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-[#d8c5aa] bg-[#fffdfa] p-2 shadow-xl">
          {PROJECT_ATLAS_PROMPT_VARIANTS.map((variant) => (
            <button
              key={variant.id}
              type="button"
              onClick={() => copyPrompt(variant.id)}
              className="w-full cursor-pointer rounded-md px-3 py-2 text-left text-[11px] font-bold text-[#5c493c] hover:bg-[#fff1d7]"
            >
              {variant.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
