/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Terminal, Cat } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  if (!content) {
    return <span className="text-[#8c7463] italic font-mono text-xs">No specifications details provided yet. =^.^=</span>;
  }

  // Simple and highly robust custom renderer for dev notebooks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 text-xs leading-relaxed font-sans text-[#413129]">
      {parts.map((part, index) => {
        // Code Block
        if (part.startsWith('```')) {
          const match = part.match(/```(\w*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : '';
          const code = match ? match[2] : part.slice(3, -3);

          return (
            <div key={index} className="border border-[#ebdcb9] rounded-2xl overflow-hidden bg-[#faf8f3] my-3 shadow-3xs">
              <div className="bg-[#f5eedf] px-4 py-2 border-b border-[#ebdcb9] flex justify-between items-center text-[10px] text-[#715c4f] font-mono">
                <span className="flex items-center gap-1.5 uppercase font-extrabold text-[#715c4d]">
                  <Terminal size={12} className="text-[#bf8a50]" />
                  {lang || 'source code'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(code.trim());
                    alert('Code copied to clipboard! 🐾');
                  }}
                  className="hover:text-[#3a2010] px-2.5 py-0.5 rounded-xl border border-[#ebdcb9] bg-white text-[9px] transition-all font-bold"
                >
                  Copy
                </button>
              </div>
              <pre className="p-4 overflow-x-auto text-[11px] font-mono whitespace-pre text-[#915d2a] leading-relaxed scrollbar-thin font-bold bg-[#fffdfa]">
                <code>{code.trim()}</code>
              </pre>
            </div>
          );
        }

        // Standard Text: Compile headers, bullets, inline code
        const lines = part.split('\n');
        return (
          <div key={index} className="space-y-1.5">
            {lines.map((line, lineIdx) => {
              const trimmed = line.trim();

              // H3
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={lineIdx} className="text-[#3c2a1a] font-extrabold font-sans text-xs mt-3 flex items-center gap-1.5">
                    <span className="w-1.5 h-3 bg-[#e5a93b] rounded-full inline-block" />
                    {trimmed.replace('### ', '')}
                  </h4>
                );
              }
              // H2
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lineIdx} className="text-[#3c2a1a] font-black font-sans text-xs mt-4 flex items-center gap-1.5">
                    <span className="w-2 h-3.5 bg-[#d89745] rounded-full inline-block" />
                    {trimmed.replace('## ', '')}
                  </h3>
                );
              }
              // Bullet Points
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                return (
                  <div key={lineIdx} className="pl-4 flex items-start gap-2 text-xs font-semibold text-[#5c493c]">
                    <span className="text-[#d89745] mt-1 select-none font-extrabold">🐾</span>
                    <span>{parseInlineCode(trimmed.substring(2))}</span>
                  </div>
                );
              }
              // Numbered list items
              if (/^\d+\.\s/.test(trimmed)) {
                const match = trimmed.match(/^(\d+)\.\s(.*)/);
                const number = match ? match[1] : '';
                const text = match ? match[2] : trimmed;
                return (
                  <div key={lineIdx} className="pl-4 flex items-start gap-2 text-xs font-semibold text-[#5c493c]">
                    <span className="text-[#df9433] font-mono mt-0.5 text-[10px] font-extrabold">{number}.</span>
                    <span>{parseInlineCode(text)}</span>
                  </div>
                );
              }

              // Empty lines
              if (trimmed === '') {
                return <div key={lineIdx} className="h-1" />;
              }

              // Standard line
              return (
                <p key={lineIdx} className="text-[#5c493c] font-semibold">
                  {parseInlineCode(line)}
                </p>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Inline code renderer e.g. `const test` -> render tag
function parseInlineCode(text: string) {
  const codeRegex = /`([^`]+)`/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = codeRegex.exec(text)) !== null) {
    // Add text before code
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }
    // Add code segment
    parts.push(
      <code key={match.index} className="px-2 py-0.5 bg-[#fefcf8] border border-[#e5d4bb] rounded-lg text-[10px] font-mono text-[#a46c24] font-bold shadow-3xs">
        {match[1]}
      </code>
    );
    lastIndex = codeRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}
