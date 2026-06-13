import React, { useState, useRef, useEffect, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface CustomSelectOption {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
}

export interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  className?: string;
  menuClassName?: string;
  placeholder?: string;
}

export function CustomSelect({ value, onChange, options, className = '', menuClassName = '', placeholder = 'Select...' }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedOption = options.find(opt => opt.value === value);

  return (
    <div className={`relative inline-block text-left ${className}`} ref={containerRef}>
      <div 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between cursor-pointer w-full h-full"
      >
        <div className="flex items-center gap-1.5 truncate flex-1 min-w-0">
          {selectedOption?.icon}
          <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        </div>
        <ChevronDown size={12} className={`shrink-0 opacity-50 ml-1 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </div>
      
      {isOpen && (
        <div className={`absolute top-full left-0 mt-1 min-w-full w-max bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg shadow-xl z-50 py-1 flex flex-col font-mono text-[#8a725f] dark:text-[#f3eadf] overflow-hidden ${menuClassName}`}>
          {options.map(opt => (
            <button
              key={opt.value}
              className={`flex items-center gap-1.5 px-3 py-1.5 hover:bg-[#ebdcb9]/30 dark:hover:bg-[#584a3b]/30 text-left transition-colors w-full min-w-max ${value === opt.value ? 'bg-[#ebdcb9]/50 dark:bg-[#584a3b]/50 font-extrabold text-[#534135] dark:text-white' : 'font-bold'}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.icon}
              <span className="truncate">{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
