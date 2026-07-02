import { Search, X } from 'lucide-react';

interface AtlasSearchBarProps {
  query: string;
  resultCount: number;
  onQueryChange: (query: string) => void;
}

export function AtlasSearchBar({ query, resultCount, onQueryChange }: AtlasSearchBarProps) {
  return (
    <label className="flex h-9 min-w-[220px] items-center gap-2 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 text-[11px] font-mono text-[#8a6e5a] dark:text-[#f3eadf]">
      <Search size={14} />
      <input
        className="min-w-0 flex-1 bg-transparent outline-none"
        placeholder="Search Atlas..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      {query && (
        <span className="font-bold text-[#a46c24] dark:text-[#d6b56d]">{resultCount}</span>
      )}
      {query && (
        <button type="button" onClick={() => onQueryChange('')} className="text-[#8a6e5a] dark:text-[#f3eadf]" aria-label="Clear Atlas search">
          <X size={14} />
        </button>
      )}
    </label>
  );
}
