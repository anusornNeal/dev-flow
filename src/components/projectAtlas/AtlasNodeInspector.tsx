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
    <aside className="w-full shrink-0 border-t border-[#d8c3a6] bg-[#fffaf2] dark:border-[#584a3b]/50 dark:bg-[#292119] lg:w-[372px] lg:border-l lg:border-t-0">
      <div className="border-b border-[#ead9c2] p-4 dark:border-[rgba(212,165,116,0.10)]">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Inspector</p>
        <div className="mt-3 flex rounded-xl border border-[#d8c3a6] bg-[#f2e3cf] p-1 dark:border-[#584a3b]/50 dark:bg-[#1e1914]">
          <TabButton active={tab === 'info'} icon={<Info size={14} />} label="Info" onClick={() => setTab('info')} />
          <TabButton active={tab === 'files'} icon={<FileCode2 size={14} />} label="Files" onClick={() => setTab('files')} />
        </div>
      </div>

      {inspector ? (
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-4">
          {tab === 'info' ? <InfoTab inspector={inspector} copied={copied} onCopyContext={onCopyContext} /> : <FilesTab inspector={inspector} />}
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <div className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
            <p className="text-xl font-black text-[#241f1a] dark:text-[#f3eadf]">Select a domain</p>
            <p className="mt-2 text-[12px] leading-relaxed text-[#685547] dark:text-[#d8c5aa]">Pick a card on the map to inspect the reading path, dependencies, and related files.</p>
          </div>
          <div className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
            <p className="text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Focus Relationships</p>
            <p className="mt-2 text-[12px] font-semibold leading-relaxed text-[#685547] dark:text-[#d8c5aa]">Select a domain to reveal direct dependencies. The overview stays mostly line-free so the map remains readable.</p>
          </div>
        </div>
      )}
    </aside>
  );
}

function InfoTab({ inspector, copied, onCopyContext }: { inspector: AtlasDomainInspectorViewModel; copied: boolean; onCopyContext: () => void }) {
  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">What this is</p>
            <h2 className="mt-2 break-words text-2xl font-black leading-tight text-[#241f1a] dark:text-[#f3eadf]">{inspector.name}</h2>
            <p className="mt-2 text-[11px] font-black uppercase text-[#9a5b13] dark:text-[#f5a959]">{inspector.category} / {inspector.status}</p>
          </div>
          <span className="rounded-lg border border-[#d8c3a6] bg-[#fffaf2] px-2.5 py-1.5 text-[10px] font-black uppercase text-[#685547] dark:border-[#584a3b]/60 dark:bg-[#1e1914] dark:text-[#d8c5aa]">{inspector.health}</span>
        </div>
        <p className="mt-3 text-[14px] font-medium leading-6 text-[#4f4035] dark:text-[#f3eadf]">{inspector.plainSummary}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {inspector.tags.map((tag) => (
            <span key={tag} className="rounded-full border border-[#d8c3a6] bg-[#fffaf2] px-2.5 py-1 text-[10px] font-black uppercase text-[#9a5b13] dark:border-[rgba(245,169,89,0.14)] dark:bg-[#292119] dark:text-[#f5a959]">{tag}</span>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
        <p className="text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Start here</p>
        <div className="mt-3 space-y-2">
          {inspector.startHereFiles.length > 0 ? inspector.startHereFiles.map((file, index) => (
            <FileRow key={file.id} file={file} prefix={String(index + 1)} />
          )) : <EmptyInspectorText>No recommended entry files for this domain yet.</EmptyInspectorText>}
        </div>
      </section>

      <section className="grid gap-2">
        <RelationshipSection title="Depends on" emptyText="No outgoing domain dependencies in the current Atlas snapshot." relationships={inspector.outgoingDomains} />
        <RelationshipSection title="Used by" emptyText="No incoming domain dependents in the current Atlas snapshot." relationships={inspector.incomingDomains} />
      </section>

      <section className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
        <p className="text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Technical details</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric label="Files" value={inspector.metrics.files} />
          <Metric label="Nodes" value={inspector.metrics.nodes} />
          <Metric label="Dependencies" value={inspector.metrics.dependencies} />
          <Metric label="Types" value={inspector.metrics.types} />
        </div>
        <div className="mt-3 space-y-2">
          {Object.entries(inspector.fileTypeCounts).length > 0 ? Object.entries(inspector.fileTypeCounts).map(([type, count]) => (
            <div key={type} className="flex items-center justify-between rounded-md bg-[#fffaf2] px-3 py-2 text-[11px] font-bold text-[#2f2923] dark:bg-[#111111] dark:text-[#f5f0eb]">
              <span>.{type}</span>
              <span className="text-[#9a5b13] dark:text-[#d6b56d]">{count}</span>
            </div>
          )) : <EmptyInspectorText>No file type data.</EmptyInspectorText>}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#7b6554] dark:text-[#a39787]">{inspector.technologies.length ? inspector.technologies.join(', ') : 'Technologies unknown.'}</p>
      </section>

      <button type="button" onClick={onCopyContext} className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-[#d8c3a6] bg-[#fffaf2] px-3 py-2 text-[11px] font-extrabold text-[#5c493c] hover:border-[#b7741e] hover:bg-[#fff1d7] dark:border-[rgba(212,165,116,0.18)] dark:bg-[rgba(212,165,116,0.10)] dark:text-[#d4a574] dark:hover:bg-[rgba(212,165,116,0.16)]">
        <Clipboard size={14} /> {copied ? 'Copied Context' : 'Copy Context'}
      </button>
    </div>
  );
}

function FilesTab({ inspector }: { inspector: AtlasDomainInspectorViewModel }) {
  return (
    <div className="space-y-2">
      {inspector.files.length > 0 ? inspector.files.map((file) => (
        <FileRow key={file.id} file={file} />
      )) : (
        <div className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 text-[11px] text-[#7b6554] dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#d8c5aa]">
          No files are attached to this domain in the current Atlas snapshot.
        </div>
      )}
    </div>
  );
}

function RelationshipSection({ title, relationships, emptyText }: { title: string; relationships: AtlasDomainInspectorViewModel['incomingDomains']; emptyText: string }) {
  return (
    <section className="rounded-lg border border-[#d8c3a6] bg-[#fff8ec] p-4 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d4a574]">{title}</p>
      <div className="mt-3 space-y-2">
        {relationships.length > 0 ? relationships.map((relationship) => (
          <div key={relationship.id} className="rounded-md border border-[#d8c3a6] bg-[#fffaf2] px-3 py-2 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#111111]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-black text-[#241f1a] dark:text-[#f8fafc]">{relationship.name}</span>
              <span className="rounded border border-[#d8c3a6] px-1.5 py-0.5 text-[8px] font-black uppercase text-[#9a5b13] dark:border-[rgba(212,165,116,0.14)] dark:text-[#d4a574]">{relationship.category}</span>
            </div>
            <p className="mt-1 truncate text-[9px] font-bold text-[#7b6554] dark:text-[#a39787]">{relationship.edgeKinds.join(', ')}</p>
          </div>
        )) : <EmptyInspectorText>{emptyText}</EmptyInspectorText>}
      </div>
    </section>
  );
}

function FileRow({ file, prefix }: { file: AtlasDomainInspectorViewModel['files'][number]; prefix?: string }) {
  return (
    <div className="flex w-full items-start gap-3 rounded-md border border-[#d8c3a6] bg-[#fffaf2] p-3 text-left dark:border-[rgba(212,165,116,0.14)] dark:bg-[#111111]">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#d8c3a6] bg-[#fff8ec] text-[10px] font-black text-[#9a5b13] dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a] dark:text-[#d4a574]">
        {prefix ?? <FileCode2 size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-black text-[#241f1a] dark:text-[#f8fafc]">{file.name}</span>
        <span className="mt-1 block break-all text-[11px] font-mono leading-5 text-[#685547] dark:text-[#d8c5aa]">{file.path}</span>
        <span className="mt-2 inline-flex items-center gap-1 rounded border border-[#d8c3a6] bg-[#fff8ec] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[rgba(212,165,116,0.14)] dark:bg-[#1a1a1a] dark:text-[#d4a574]">
          <Link2 size={10} /> {file.type}
        </span>
      </span>
    </div>
  );
}

function EmptyInspectorText({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-[#d8c3a6] bg-[#fffaf2] px-3 py-2 text-[12px] leading-relaxed text-[#685547] dark:border-[#584a3b]/50 dark:bg-[#292119] dark:text-[#d8c5aa]">{children}</p>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[#d8c3a6] bg-[#fffaf2] p-3 dark:border-[rgba(212,165,116,0.14)] dark:bg-[#111111]">
      <p className="text-2xl font-black text-[#b7741e] dark:text-[#f5a959]">{value}</p>
      <p className="mt-1 text-[10px] font-black uppercase tracking-wider text-[#685547] dark:text-[#b89b82]">{label}</p>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-black ${active ? 'bg-[#e0a070] text-[#17130f] dark:bg-[rgba(212,165,116,0.22)] dark:text-[#d4a574]' : 'text-[#7b6554] hover:bg-[#fff1d7] hover:text-[#2f2923] dark:text-[#a39787] dark:hover:bg-[rgba(212,165,116,0.10)] dark:hover:text-[#f5f0eb]'}`}>
      {icon}
      {label}
    </button>
  );
}
