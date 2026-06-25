import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
}

export default function ConfirmModal({ 
  title, 
  message, 
  onConfirm, 
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel'
}: ConfirmModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      <div className="fixed inset-0" onClick={onCancel} />
      
      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-sm rounded-2xl shadow-2xl relative z-10 overflow-hidden flex flex-col font-sans">
        
        <div className="p-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-[#a46c24] dark:text-[#f3eadf]" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase">
              {title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-5 text-[#5c493c] dark:text-[#f3eadf] text-xs leading-relaxed font-mono">
          <p>{message}</p>
        </div>

        <div className="p-4 bg-[#f4ebd9] dark:bg-[#1e1914] border-t border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="text-[10px] font-mono font-extrabold uppercase px-4 py-2 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119] text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#fff9ed] dark:hover:bg-[#3a2f26] transition-colors cursor-pointer shadow-3xs"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="text-[10px] font-mono font-extrabold uppercase px-4 py-2 rounded-xl bg-[#d89745] dark:bg-[#a46c24] text-white hover:bg-[#c07c28] dark:hover:bg-[#8a581c] transition-colors cursor-pointer shadow-3xs"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
