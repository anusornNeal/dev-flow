import React, { useEffect } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div 
        className="relative max-w-full max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="absolute -top-12 right-0 flex items-center gap-3">
          <a 
            href={image.url} 
            target="_blank" 
            rel="noreferrer"
            className="text-white/70 hover:text-white transition-colors flex items-center gap-1.5 text-sm font-mono bg-black/40 px-3 py-1.5 rounded-lg"
          >
            <ExternalLink size={16} /> Open
          </a>
          <button 
            onClick={onClose}
            className="text-white/70 hover:text-white transition-colors bg-black/40 p-1.5 rounded-lg"
          >
            <X size={24} />
          </button>
        </div>
        
        <img 
          src={image.url} 
          alt={image.filename} 
          className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl border border-white/10 bg-[#1e1914]"
        />
        <div className="absolute -bottom-8 left-0 text-white/50 text-xs font-mono truncate max-w-full text-center w-full">
          {image.filename}
        </div>
      </div>
    </div>
  );
}
