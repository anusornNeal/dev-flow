import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-9 min-w-[240px] items-center gap-2 rounded-lg border border-[#584a3b] bg-[#1e1914] px-3 text-[11px] font-mono text-[#d8c5aa]">
      <Search size={14} className="text-[#e0a070]" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[#f8ead3] outline-none placeholder:text-[#9b8271]"
        placeholder="Search Atlas..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="font-bold text-[#d6b56d]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="text-[#d8c5aa] hover:text-[#f8ead3]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
