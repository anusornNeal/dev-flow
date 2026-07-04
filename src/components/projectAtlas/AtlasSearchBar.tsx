import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-12 w-full items-center gap-3 rounded-2xl border border-[#d8c3a6] bg-[#fffaf2] px-4 text-[13px] font-medium text-[#685547] shadow-[inset_0_0_18px_rgba(90,62,26,0.06)] dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724] dark:text-[#cbd5e1] dark:shadow-[inset_0_0_18px_rgba(0,0,0,0.35)]">
      <Search size={17} className="text-[#b7741e] dark:text-[#f5a959]" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold text-[#241f1a] outline-none placeholder:text-[#a98e78] dark:text-[#f8fafc] dark:placeholder:text-[#64748b]"
        placeholder="Search domains by name, summary, file path, or tags..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="rounded-lg bg-[#fff1d7] px-2 py-1 font-bold text-[#9a5b13] dark:bg-[rgba(245,169,89,0.16)] dark:text-[#f5a959]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="cursor-pointer text-[#7b6554] hover:text-[#2f2923] dark:text-[#a39787] dark:hover:text-[#f5f0eb]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
