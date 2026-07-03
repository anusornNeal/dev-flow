import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-9 min-w-[240px] items-center gap-2 rounded-lg border border-[#2a3542] bg-[#0c1117] px-3 text-[11px] font-mono text-[#9da8b5]">
      <Search size={14} className="text-[#f0b84d]" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[#f8ead3] outline-none placeholder:text-[#687484]"
        placeholder="Search Atlas..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="font-bold text-[#f0b84d]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="text-[#9da8b5] hover:text-[#f8ead3]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
