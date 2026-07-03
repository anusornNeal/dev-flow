import { useState } from 'react';
import { Download } from 'lucide-react';
import type { AtlasNode, ProjectAtlas } from '../../types.js';
import type { AtlasGraphViewModel } from '../../lib/projectAtlasViewModel.js';
import { exportAtlasJson, renderAtlasMarkdown, renderAtlasMermaid, renderAtlasSvg } from '../../lib/projectAtlasExport.js';

interface AtlasExportMenuProps {
  atlas: ProjectAtlas | null;
  view: AtlasGraphViewModel | null;
  selectedNode: AtlasNode | null;
}

export function AtlasExportMenu({ atlas, view, selectedNode }: AtlasExportMenuProps) {
  const [open, setOpen] = useState(false);
  const disabled = !atlas || !view;

  const exportText = (extension: string, mimeType: string, content: string) => {
    downloadBlob(`project-atlas.${extension}`, new Blob([content], { type: mimeType }));
    setOpen(false);
  };

  const exportPng = async () => {
    if (!view) return;
    const svg = renderAtlasSvg(view);
    const png = await svgToPngBlob(svg);
    downloadBlob('project-atlas.png', png);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        className="h-9 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 text-[11px] font-extrabold text-[#6d5a4d] dark:text-[#f3eadf] disabled:opacity-60"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Download size={14} className="mr-1 inline" /> Export
      </button>
      {open && atlas && view && (
        <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-[#d8c5aa] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] p-2 shadow-xl">
          <ExportAction label="Full JSON" onClick={() => exportText('json', 'application/json', exportAtlasJson(atlas))} />
          <ExportAction label="Markdown Overview" onClick={() => exportText('md', 'text/markdown', renderAtlasMarkdown(atlas, { selectedNodeId: selectedNode?.id }))} />
          <ExportAction label="Mermaid Diagram" onClick={() => exportText('mmd', 'text/plain', renderAtlasMermaid(atlas))} />
          <ExportAction label="Visible SVG" onClick={() => exportText('svg', 'image/svg+xml', renderAtlasSvg(view))} />
          <ExportAction label="Visible PNG" onClick={exportPng} />
        </div>
      )}
    </div>
  );
}

function ExportAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md px-3 py-2 text-left text-[11px] font-bold text-[#5c493c] hover:bg-[#fff1d7] dark:text-[#f3eadf] dark:hover:bg-[#3a2f26]"
    >
      {label}
    </button>
  );
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function svgToPngBlob(svg: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width || 960;
      canvas.height = image.height || 640;
      const context = canvas.getContext('2d');
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas unavailable'));
        return;
      }
      context.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error('PNG export failed'));
      }, 'image/png');
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG image load failed'));
    };
    image.src = url;
  });
}
