import { ChevronDown, Layers } from 'lucide-react';
import type { AtlasLayerKey, AtlasLayers } from './atlasViewModel.js';

interface AtlasLayerPanelProps {
  layers: AtlasLayers;
  collapsedDomains: boolean;
  expandedNodeIds?: string[];
  domains: Array<{ id: string; name: string; nodeCount: number; origin: string }>;
  onToggleLayer: (key: AtlasLayerKey) => void;
  onToggleCollapsedDomains: () => void;
}

export function AtlasLayerPanel({ layers, collapsedDomains, expandedNodeIds = [], domains, onToggleLayer, onToggleCollapsedDomains }: AtlasLayerPanelProps) {
  const expandedIds = new Set(expandedNodeIds);
  return (
    <aside className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-[#e5d4bb] dark:border-[#584a3b] bg-[#f4ebd9] dark:bg-[#292119] p-4 overflow-y-auto">
      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-[#7a6455] dark:text-[#f3eadf]">
        <Layers size={14} className="text-[#a46c24] dark:text-[#d6b56d]" />
        Atlas Layers
      </div>
      <div className="mt-4 space-y-2">
        {(Object.keys(layers) as AtlasLayerKey[]).map((key) => (
          <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-[#e5d4bb] dark:border-[#584a3b] bg-white/70 dark:bg-[#1e1914] px-3 py-2 text-[11px] font-bold text-[#534135] dark:text-[#f3eadf]">
            <span>{layers[key].label}</span>
            <input
              type="checkbox"
              checked={layers[key].visible}
              onChange={() => onToggleLayer(key)}
              className="accent-[#a46c24]"
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={onToggleCollapsedDomains}
        className="mt-4 w-full flex items-center justify-between rounded-lg border border-[#d8c5aa] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 py-2 text-[11px] font-extrabold text-[#5c493c] dark:text-[#f3eadf]"
      >
        <span>{collapsedDomains ? 'Domain collapsed' : 'Expanded graph'}</span>
        <ChevronDown size={14} className={collapsedDomains ? '' : 'rotate-180'} />
      </button>

      <div className="mt-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#8a6e5a] dark:text-[#d6b56d]">Domains</p>
        <div className="mt-2 space-y-2">
          {domains.slice(0, 12).map((domain) => (
            <div key={domain.id} className="rounded-lg bg-[#fffdfa] dark:bg-[#1e1914] border border-[#e5d4bb] dark:border-[#584a3b] px-3 py-2">
              <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-[#534135] dark:text-[#f3eadf]">
                <span className="truncate">{domain.name}</span>
                <span className="font-mono text-[10px] text-[#a46c24] dark:text-[#d6b56d]">{expandedIds.has(domain.id) ? 'open' : domain.nodeCount}</span>
              </div>
              <p className="mt-1 text-[9px] font-mono text-[#8a6e5a] dark:text-[#d6b56d]">{domain.origin}</p>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
