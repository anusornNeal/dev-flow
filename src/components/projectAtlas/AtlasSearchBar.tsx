import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-9 min-w-[240px] items-center gap-2 rounded-lg border border-[#e5d4bb] bg-[#fffdfa] px-3 text-[11px] font-mono text-[#7b6554] shadow-sm">
      <Search size={14} className="text-[#c9872c]" />
      <input
        className="min-w-0 flex-1 bg-transparent text-[#3f342b] outline-none placeholder:text-[#a98e78]"
        placeholder="Search Atlas..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="font-bold text-[#9a5b13]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="cursor-pointer text-[#7b6554] hover:text-[#3f342b]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
