import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-10 w-full items-center gap-3 rounded-xl border border-[#d8c3a6] bg-[#fffaf2] px-4 text-[12px] font-mono text-[#7b6554] shadow-[inset_0_0_18px_rgba(90,62,26,0.06)] dark:border-[rgba(212,165,116,0.16)] dark:bg-[#151515] dark:text-[#a39787] dark:shadow-[inset_0_0_18px_rgba(0,0,0,0.35)]">
      <Search size={16} className="text-[#b7741e] dark:text-[#d4a574]" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[#2f2923] outline-none placeholder:text-[#a98e78] dark:text-[#f5f0eb] dark:placeholder:text-[#6b5f53]"
        placeholder="Search domains by name, summary, file path, or tags..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="rounded-md bg-[#fff1d7] px-2 py-1 font-bold text-[#9a5b13] dark:bg-[rgba(212,165,116,0.16)] dark:text-[#d4a574]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="cursor-pointer text-[#7b6554] hover:text-[#2f2923] dark:text-[#a39787] dark:hover:text-[#f5f0eb]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
