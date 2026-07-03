import { useState } from 'react';
import type React from 'react';
import { Clipboard, FileCode2, Info, Link2 } from 'lucide-react';
import type { AtlasDomainInspectorViewModel } from '../../lib/projectAtlasViewModel.js';

interface AtlasNodeInspectorProps {
  inspector: AtlasDomainInspectorViewModel | null;
  copied: boolean;
  onCopyContext: () => void;
}

type InspectorTab = 'info' | 'files';

export function AtlasNodeInspector({ inspector, copied, onCopyContext }: AtlasNodeInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('info');

  return (
    <aside className="w-full shrink-0 border-t border-[#584a3b] bg-[#241c15] lg:w-[360px] lg:border-l lg:border-t-0">
      <div className="border-b border-[#584a3b] p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#e0a070]">Inspector</p>
        <div className="mt-3 flex rounded-lg border border-[#584a3b] bg-[#1e1914] p-1">
          <TabButton active={tab === 'info'} icon={<Info size={14} />} label="Info" onClick={() => setTab('info')} />
          <TabButton active={tab === 'files'} icon={<FileCode2 size={14} />} label="Files" onClick={() => setTab('files')} />
        </div>
      </div>

      {inspector ? (
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-4">
          {tab === 'info' ? <InfoTab inspector={inspector} copied={copied} onCopyContext={onCopyContext} /> : <FilesTab inspector={inspector} />}
        </div>
      ) : (
        <div className="p-4">
          <div className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-4">
            <p className="text-sm font-black text-[#f8ead3]">Select a domain</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[#d8c5aa]">Pick a card on the map to inspect health, metrics, technologies, and related files.</p>
          </div>
        </div>
      )}
    </aside>
  );
}

function InfoTab({ inspector, copied, onCopyContext }: { inspector: AtlasDomainInspectorViewModel; copied: boolean; onCopyContext: () => void }) {
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-base font-black text-[#f8ead3]">{inspector.name}</h2>
            <p className="mt-1 text-[10px] font-black uppercase text-[#e0a070]">{inspector.category} · {inspector.status}</p>
          </div>
          <span className="rounded-md border border-[#6d5642] bg-[#2b2119] px-2 py-1 text-[9px] font-black uppercase text-[#d8c5aa]">{inspector.health}</span>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[#d8c5aa]">{inspector.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {inspector.tags.map((tag) => (
            <span key={tag} className="rounded border border-[#6d5642] bg-[#2b2119] px-2 py-1 text-[9px] font-black uppercase text-[#e0a070]">{tag}</span>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-2">
        <Metric label="Files" value={inspector.metrics.files} />
        <Metric label="Nodes" value={inspector.metrics.nodes} />
        <Metric label="Dependencies" value={inspector.metrics.dependencies} />
        <Metric label="Types" value={inspector.metrics.types} />
      </section>

      <section className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#e0a070]">File Types</p>
        <div className="mt-3 space-y-2">
          {Object.entries(inspector.fileTypeCounts).length > 0 ? Object.entries(inspector.fileTypeCounts).map(([type, count]) => (
            <div key={type} className="flex items-center justify-between rounded-md bg-[#2b2119] px-3 py-2 text-[11px] font-bold text-[#f3eadf]">
              <span>.{type}</span>
              <span className="text-[#e0a070]">{count}</span>
            </div>
          )) : <p className="text-[11px] text-[#d8c5aa]">No file type data.</p>}
        </div>
      </section>

      <section className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#e0a070]">Technologies</p>
        <p className="mt-2 text-[11px] leading-relaxed text-[#d8c5aa]">{inspector.technologies.length ? inspector.technologies.join(', ') : 'Unknown'}</p>
      </section>

      <button type="button" onClick={onCopyContext} className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#6d5642] bg-[#2b2119] px-3 py-2 text-[11px] font-extrabold text-[#f8ead3] hover:border-[#e0a070]">
        <Clipboard size={14} /> {copied ? 'Copied Context' : 'Copy Context'}
      </button>
    </div>
  );
}

function FilesTab({ inspector }: { inspector: AtlasDomainInspectorViewModel }) {
  return (
    <div className="space-y-2">
      {inspector.files.length > 0 ? inspector.files.map((file) => (
        <button key={file.id} type="button" disabled className="flex w-full items-start gap-3 rounded-lg border border-[#584a3b] bg-[#1e1914] p-3 text-left opacity-95">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#6d5642] bg-[#2b2119] text-[#e0a070]">
            <FileCode2 size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-black text-[#f8ead3]">{file.name}</span>
            <span className="mt-1 block break-all text-[10px] font-mono leading-4 text-[#d8c5aa]">{file.path}</span>
            <span className="mt-2 inline-flex items-center gap-1 rounded border border-[#6d5642] bg-[#2b2119] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#e0a070]">
              <Link2 size={10} /> {file.type}
            </span>
          </span>
        </button>
      )) : (
        <div className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-4 text-[11px] text-[#d8c5aa]">
          No files are attached to this domain in the current Atlas snapshot.
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[#584a3b] bg-[#1e1914] p-3">
      <p className="text-lg font-black text-[#f8ead3]">{value}</p>
      <p className="mt-1 text-[9px] font-black uppercase text-[#d8c5aa]">{label}</p>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-black ${active ? 'bg-[#e0a070] text-[#17130f]' : 'text-[#d8c5aa] hover:text-[#f8ead3]'}`}>
      {icon}
      {label}
    </button>
  );
}

