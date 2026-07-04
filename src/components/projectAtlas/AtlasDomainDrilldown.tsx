import { ArrowLeft, FileCode2, FolderOpen, Network } from 'lucide-react';
import type { AtlasDomainFile, AtlasDomainInspectorViewModel } from '../../lib/projectAtlasViewModel.js';

interface AtlasDomainDrilldownProps {
  inspector: AtlasDomainInspectorViewModel;
  onBack: () => void;
}

export function AtlasDomainDrilldown({ inspector, onBack }: AtlasDomainDrilldownProps) {
  const clusters = buildFileClusters(inspector.files);

  return (
    <div className="relative h-full min-h-[680px] overflow-auto bg-[#f6efe6] text-[#241f1a] dark:bg-[#050914] dark:text-[#f8fafc]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_28%_12%,rgba(245,169,89,0.16),transparent_34%),radial-gradient(circle_at_70%_44%,rgba(59,130,246,0.08),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(154,91,19,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(154,91,19,0.07)_1px,transparent_1px)] [background-size:34px_34px] dark:opacity-20 dark:[background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)]" />

      <div className="relative p-5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[#d8c3a6] bg-[#fffaf2]/94 px-4 py-2 text-[12px] font-black text-[#241f1a] shadow-sm hover:bg-[#fff1d7] dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/94 dark:text-[#f8fafc] dark:hover:bg-[rgba(245,169,89,0.12)]"
        >
          <ArrowLeft size={14} />
          Project <span className="text-[#8a6d55] dark:text-[#94a3b8]">›</span> <span className="uppercase text-[#9a5b13] dark:text-[#f5a959]">{inspector.name}</span>
          <span className="ml-1 text-[10px] font-bold text-[#8a6d55] dark:text-[#94a3b8]">Esc / click to go back</span>
        </button>

        <section className="mx-auto mt-8 max-w-[540px] rounded-2xl border border-[#d8c3a6] bg-[#fffaf2]/96 p-5 shadow-[0_20px_52px_rgba(90,62,26,0.16)] dark:border-[rgba(245,169,89,0.22)] dark:bg-[#0f1724]/96 dark:shadow-[0_20px_56px_rgba(0,0,0,0.42)]">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Domain Detail</p>
              <h2 className="mt-2 text-2xl font-black leading-tight text-[#241f1a] dark:text-[#f8fafc]">{inspector.name}</h2>
              <p className="mt-2 text-[12px] font-semibold leading-5 text-[#685547] dark:text-[#cbd5e1]">{inspector.plainSummary}</p>
            </div>
            <span className="shrink-0 rounded-lg border border-[#ead9c2] bg-[#fff8ec] px-2.5 py-1 text-[10px] font-black uppercase text-[#8a4d0d] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#0b1220] dark:text-[#f5a959]">{inspector.status}</span>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center">
            <Metric label="Files" value={inspector.metrics.files} />
            <Metric label="Nodes" value={inspector.metrics.nodes} />
            <Metric label="Deps" value={inspector.metrics.dependencies} />
            <Metric label="Types" value={inspector.metrics.types} />
          </div>
        </section>

        <div className="mx-auto mt-9 grid max-w-[1180px] gap-7 xl:grid-cols-2">
          {clusters.map((cluster) => (
            <section key={cluster.id} className="rounded-2xl border border-[#d8c3a6] bg-[#fffaf2]/58 p-4 shadow-[0_14px_36px_rgba(90,62,26,0.10)] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#0f1724]/56 dark:shadow-[0_14px_40px_rgba(0,0,0,0.32)]">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]"><FolderOpen size={14} /> {cluster.label}</p>
                <span className="rounded-md border border-[#ead9c2] bg-[#fff8ec] px-2 py-0.5 text-[10px] font-black text-[#8a6d55] dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220] dark:text-[#94a3b8]">{cluster.files.length}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {cluster.files.slice(0, 10).map((file) => <FileCard key={file.id} file={file} />)}
              </div>
              {cluster.files.length > 10 ? <p className="mt-3 text-[11px] font-bold text-[#8a6d55] dark:text-[#94a3b8]">+{cluster.files.length - 10} more files hidden to keep this view readable.</p> : null}
            </section>
          ))}
        </div>

        <section className="mx-auto mt-8 grid max-w-[1180px] gap-5 md:grid-cols-2">
          <RelationshipBox title="Depends on" items={inspector.outgoingDomains.map((item) => item.name)} />
          <RelationshipBox title="Used by" items={inspector.incomingDomains.map((item) => item.name)} />
        </section>
      </div>
    </div>
  );
}

function FileCard({ file }: { file: AtlasDomainFile }) {
  return (
    <article className="rounded-xl border border-[#d8c3a6] bg-[#fffaf2]/96 p-3 shadow-sm dark:border-[rgba(148,163,184,0.16)] dark:bg-[#0b1220]/94">
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#ead9c2] bg-[#fff8ec] text-[#b7741e] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#111827] dark:text-[#f5a959]"><FileCode2 size={14} /></span>
        <span className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-black text-[#241f1a] dark:text-[#f8fafc]">{file.name}</p>
          <p className="mt-1 line-clamp-2 break-all font-mono text-[10px] leading-4 text-[#685547] dark:text-[#cbd5e1]">{file.path}</p>
        </span>
      </div>
    </article>
  );
}

function RelationshipBox({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-2xl border border-[#d8c3a6] bg-[#fffaf2]/70 p-4 dark:border-[rgba(148,163,184,0.16)] dark:bg-[#0f1724]/72">
      <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]"><Network size={14} /> {title}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {items.length ? items.slice(0, 8).map((item) => <span key={item} className="rounded-full border border-[#ead9c2] bg-[#fff8ec] px-2 py-1 text-[10px] font-bold text-[#5c493c] dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220] dark:text-[#dbeafe]">{item}</span>) : <span className="text-[11px] font-semibold text-[#8a6d55] dark:text-[#94a3b8]">No direct domain links.</span>}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-lg border border-[#ead9c2] bg-[#fff8ec] px-2 py-2 dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220]">
      <span className="block text-[16px] font-black text-[#241f1a] dark:text-[#f8fafc]">{value}</span>
      <span className="block text-[9px] font-bold uppercase text-[#8a6d55] dark:text-[#94a3b8]">{label}</span>
    </span>
  );
}

function buildFileClusters(files: AtlasDomainFile[]) {
  const groups = new Map<string, AtlasDomainFile[]>();
  files.forEach((file) => {
    const folder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : 'root';
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  });
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([id, clusterFiles], index) => ({ id: `${id}-${index}`, label: id, files: clusterFiles.sort((left, right) => left.name.localeCompare(right.name)) }));
}
