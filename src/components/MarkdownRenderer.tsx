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
    return <span className="font-mono text-xs italic text-df-text-muted">No specification details provided yet. =^.^=</span>;
  }

  // Simple and highly robust custom renderer for dev notebooks
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className="space-y-3.5 font-sans text-xs leading-relaxed text-df-text">
      {parts.map((part, index) => {
        // Code Block
        if (part.startsWith('```')) {
          const match = part.match(/```(\w*)\n([\s\S]*?)```/);
          const lang = match ? match[1] : '';
          const code = match ? match[2] : part.slice(3, -3);

          return (
            <div key={index} className="my-3 overflow-hidden rounded-2xl border border-df-border bg-df-surface shadow-[var(--df-shadow-sm)]">
              <div className="flex items-center justify-between border-b border-df-border bg-df-surface-muted px-4 py-2 font-mono text-[10px] text-df-text-muted">
                <span className="flex items-center gap-1.5 font-extrabold uppercase text-[var(--df-color-text-strong)]">
                  <Terminal size={12} className="text-df-accent" />
                  {lang || 'source code'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(code.trim());
                    alert('Code copied to clipboard! 🐾');
                  }}
                  className="rounded-xl border border-df-border bg-df-surface-raised px-2.5 py-0.5 text-[10px] font-bold text-df-text-muted transition-colors hover:border-[var(--df-color-border-strong)] hover:text-[var(--df-color-text-strong)]"
                >
                  Copy
                </button>
              </div>
              <pre className="overflow-x-auto bg-df-surface-raised p-4 font-mono text-[11px] font-bold leading-relaxed text-df-text scrollbar-thin whitespace-pre">
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
                  <h4 key={lineIdx} className="mt-3 flex items-center gap-1.5 font-sans text-xs font-extrabold text-[var(--df-color-text-strong)]">
                    <span className="inline-block h-3 w-1.5 rounded-full bg-df-accent" />
                    {trimmed.replace('### ', '')}
                  </h4>
                );
              }
              // H2
              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={lineIdx} className="mt-4 flex items-center gap-1.5 font-sans text-xs font-black text-[var(--df-color-text-strong)]">
                    <span className="inline-block h-3.5 w-2 rounded-full bg-df-accent" />
                    {trimmed.replace('## ', '')}
                  </h3>
                );
              }
              // Bullet Points
              if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                return (
                  <div key={lineIdx} className="flex items-start gap-2 pl-4 text-xs font-semibold text-df-text">
                    <span className="mt-1 select-none font-extrabold text-df-accent">🐾</span>
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
                  <div key={lineIdx} className="flex items-start gap-2 pl-4 text-xs font-semibold text-df-text">
                    <span className="mt-0.5 font-mono text-[10px] font-extrabold text-df-accent">{number}.</span>
                    <span>{parseInlineCode(text)}</span>
                  </div>
                );
              }

              // Image: ![alt](url)
              const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
              if (imageMatch) {
                const alt = imageMatch[1] || 'Image';
                const src = imageMatch[2];
                const handleClick = (e: React.MouseEvent) => {
                  e.preventDefault();
                  if (src.startsWith('data:')) {
                    const parts = src.split(',');
                    const mime = (parts[0].split(':')[1] || '').split(';')[0] || 'image/png';
                    const byteString = atob(parts[1]);
                    const bytes = new Uint8Array(byteString.length);
                    for (let i = 0; i < byteString.length; i++) {
                      bytes[i] = byteString.charCodeAt(i);
                    }
                    const blob = new Blob([bytes], { type: mime });
                    window.open(URL.createObjectURL(blob), '_blank');
                  } else {
                    window.open(src, '_blank');
                  }
                };
                return (
                  <button
                    key={lineIdx}
                    type="button"
                    onClick={handleClick}
                    aria-label={`Open image: ${alt}`}
                    className="my-2 block max-w-lg overflow-hidden rounded-2xl border border-df-border bg-df-surface-raised p-1 shadow-[var(--df-shadow-sm)]"
                  >
                    <img
                      src={src}
                      alt={alt}
                      className="max-h-64 w-full rounded-xl object-contain transition-opacity hover:opacity-90"
                      referrerPolicy="no-referrer"
                    />
                  </button>
                );
              }

              if (trimmed === '') {
                return <div key={lineIdx} className="h-1" />;
              }

              // Standard line
              return (
                <p key={lineIdx} className="font-semibold text-df-text">
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
      <code key={match.index} className="rounded-lg border border-df-border bg-df-surface-raised px-2 py-0.5 font-mono text-[10px] font-bold text-df-accent shadow-[var(--df-shadow-sm)]">
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
