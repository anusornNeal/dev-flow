import React, { useEffect } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { TaskImage } from '../types';

interface ImageViewerProps {
  image: TaskImage | null;
  onClose: () => void;
}

export default function ImageViewer({ image, onClose }: ImageViewerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (image) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--df-color-backdrop)] p-4 backdrop-blur-sm animate-fade-in" role="dialog" aria-modal="true" aria-label={`Image viewer: ${image.filename}`} onClick={onClose}>
      <div 
        className="relative max-w-full max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute -top-12 right-0 flex items-center gap-3">
          <a 
            href={image.url} 
            target="_blank" 
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg border border-df-border bg-df-surface/90 px-3 py-1.5 font-mono text-sm text-df-text transition-colors hover:bg-df-surface-raised"
          >
            <ExternalLink size={16} /> Open
          </a>
          <button 
            type="button"
            onClick={onClose}
            aria-label="Close image viewer"
            className="df-icon-button bg-df-surface/90"
          >
            <X size={24} />
          </button>
        </div>
        
        <img 
          src={image.url} 
          alt={image.filename} 
          className="max-h-[85vh] max-w-[90vw] rounded-lg border border-df-border bg-df-canvas object-contain shadow-[var(--df-shadow-lg)]"
        />
        <div className="mt-2 max-w-[90vw] break-words rounded-md bg-df-surface/90 px-2 py-1 text-center font-mono text-xs text-df-text-muted">
          {image.filename}
        </div>
      </div>
    </div>
  );
}
