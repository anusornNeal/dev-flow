import React, { ReactNode, useEffect, useId, useRef, useState } from 'react';
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
  disabled?: boolean;
  ariaLabel?: string;
}

export type CustomSelectKeyAction =
  | { type: 'open'; index: number }
  | { type: 'highlight'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close' }
  | { type: 'none' };

export function resolveCustomSelectKeyAction(
  key: string,
  highlightedIndex: number,
  itemCount: number,
  isOpen: boolean,
): CustomSelectKeyAction {
  if (key === 'Escape') return isOpen ? { type: 'close' } : { type: 'none' };
  if (itemCount <= 0) return { type: 'none' };

  if (!isOpen) {
    if (key === 'ArrowDown') return { type: 'open', index: 0 };
    if (key === 'ArrowUp') return { type: 'open', index: itemCount - 1 };
    return { type: 'none' };
  }

  const current = highlightedIndex >= 0 && highlightedIndex < itemCount ? highlightedIndex : 0;
  if (key === 'ArrowDown') return { type: 'highlight', index: (current + 1) % itemCount };
  if (key === 'ArrowUp') return { type: 'highlight', index: (current - 1 + itemCount) % itemCount };
  if (key === 'Home') return { type: 'highlight', index: 0 };
  if (key === 'End') return { type: 'highlight', index: itemCount - 1 };
  if (key === 'Enter' || key === ' ') return { type: 'select', index: current };
  return { type: 'none' };
}

function optionTitle(label: ReactNode) {
  return typeof label === 'string' || typeof label === 'number' ? String(label) : undefined;
}

export function CustomSelect({
  value,
  onChange,
  options,
  className = '',
  menuClassName = '',
  placeholder = 'Select...',
  disabled = false,
  ariaLabel,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const accessibleLabel = ariaLabel || 'Select option';

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  const open = () => {
    if (disabled || options.length === 0) return;
    setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setIsOpen(true);
  };

  const close = (restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const action = resolveCustomSelectKeyAction(event.key, highlightedIndex, options.length, isOpen);
    if (action.type === 'none') return;
    event.preventDefault();

    if (action.type === 'open') {
      setHighlightedIndex(action.index);
      setIsOpen(true);
    } else if (action.type === 'highlight') {
      setHighlightedIndex(action.index);
    } else if (action.type === 'select') {
      choose(action.index);
    } else if (action.type === 'close') {
      close(true);
    }
  };

  return (
    <div className={`df-select-root relative inline-block min-w-0 text-left ${className}`} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={accessibleLabel}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleKeyDown}
        className="df-select-trigger df-focus-ring flex h-full w-full min-w-0 cursor-pointer items-center justify-between text-left disabled:cursor-not-allowed"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selectedOption?.icon && <span className="shrink-0">{selectedOption.icon}</span>}
          <span className="min-w-0 flex-1 truncate" title={optionTitle(selectedOption?.label ?? placeholder)}>
            {selectedOption ? selectedOption.label : placeholder}
          </span>
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          className={`ml-1 shrink-0 opacity-60 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={accessibleLabel}
          className={`df-popover df-select-menu absolute left-0 top-full z-50 mt-1 flex min-w-full flex-col overflow-hidden ${menuClassName}`}
        >
          {options.map((option, index) => {
            const selected = value === option.value;
            const highlighted = highlightedIndex === index;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                title={optionTitle(option.label)}
                className={`df-select-option flex w-full min-w-0 items-center gap-2 text-left ${selected ? 'is-selected' : ''} ${highlighted ? 'is-highlighted' : ''}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={(event) => {
                  event.stopPropagation();
                  choose(index);
                }}
              >
                {option.icon && <span className="shrink-0">{option.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
