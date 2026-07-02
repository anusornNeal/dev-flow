import { Clipboard, FileSearch, Route, Share2 } from 'lucide-react';
import type React from 'react';
import type { AtlasDomain, AtlasNode, ProjectAtlas } from '../../types.js';
import { buildNodeRelationships, type AtlasRelationshipGroup } from '../../lib/projectAtlasViewModel.js';

interface AtlasNodeInspectorProps {
  atlas: ProjectAtlas | null;
  node: AtlasNode | null;
  copied: boolean;
  onCopyContext: () => void;
}

export function AtlasNodeInspector({ atlas, node, copied, onCopyContext }: AtlasNodeInspectorProps) {
  const domain = atlas && node ? findNodeDomain(atlas.domains, node) : null;
  const relationships = atlas && node ? buildNodeRelationships(atlas, node.id) : [];
  const source = node ? getSourceLabel(node) : null;
  const summary = node ? node.userEdited?.notes ?? node.verified?.description ?? node.inferred?.summary : null;

  return (
    <aside className="w-full lg:w-80 shrink-0 border-t lg:border-t-0 lg:border-l border-[#e5d4bb] dark:border-[#584a3b] bg-[#f4ebd9] dark:bg-[#292119] p-4 overflow-y-auto">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#8a6e5a] dark:text-[#d6b56d]">Node Inspector</p>
      {node ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="break-words text-sm font-extrabold text-[#3c2a1a] dark:text-[#f3eadf]">{node.label}</h2>
                <p className="mt-1 text-[10px] font-mono text-[#8a6e5a] dark:text-[#d6b56d]">{node.kind}</p>
              </div>
              {source && <span className="rounded-md bg-[#fff1d7] dark:bg-[#3a2f26] px-2 py-1 text-[9px] font-black uppercase text-[#9a5b13] dark:text-[#d6b56d]">{source}</span>}
            </div>
            {node.path && <p className="mt-3 break-all text-[11px] font-mono text-[#5c493c] dark:text-[#f3eadf]">{node.path}</p>}
            {domain && <p className="mt-3 text-[11px] font-bold text-[#6d5a4d] dark:text-[#f3eadf]">Domain: {domain.name}</p>}
            {summary && <p className="mt-3 text-[11px] leading-relaxed text-[#5c493c] dark:text-[#f3eadf]">{summary}</p>}
          </div>

          <div className="rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#8a6e5a] dark:text-[#d6b56d]">Relationships</p>
            {relationships.length > 0 ? (
              <div className="mt-3 space-y-3">
                {relationships.map((group) => <RelationshipGroup key={group.kind} group={group} />)}
              </div>
            ) : (
              <p className="mt-2 text-[11px] font-mono text-[#6d5a4d] dark:text-[#f3eadf]">No direct relationships in the current Atlas snapshot.</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-2">
            <button type="button" onClick={onCopyContext} className="flex items-center gap-2 rounded-lg border border-[#d8c5aa] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 py-2 text-[11px] font-extrabold text-[#5c493c] dark:text-[#f3eadf]">
              <Clipboard size={14} /> {copied ? 'Copied Context' : 'Copy Context'}
            </button>
            <InspectorPlaceholder icon={<FileSearch size={14} />} label="Find Related Tasks" />
            <InspectorPlaceholder icon={<Route size={14} />} label="Create Agent Route" />
            <InspectorPlaceholder icon={<Share2 size={14} />} label="Export Mermaid" />
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[11px] font-mono leading-relaxed text-[#6d5a4d] dark:text-[#f3eadf]">Select a graph node to inspect its summary and relationships.</p>
      )}
    </aside>
  );
}

function RelationshipGroup({ group }: { group: AtlasRelationshipGroup }) {
  const incoming = group.incoming.map((item) => item.node.label).sort();
  const outgoing = group.outgoing.map((item) => item.node.label).sort();
  return (
    <div>
      <p className="text-[10px] font-black uppercase text-[#a46c24] dark:text-[#d6b56d]">{group.kind}</p>
      {incoming.length > 0 && <p className="mt-1 text-[11px] text-[#5c493c] dark:text-[#f3eadf]">From: {incoming.join(', ')}</p>}
      {outgoing.length > 0 && <p className="mt-1 text-[11px] text-[#5c493c] dark:text-[#f3eadf]">To: {outgoing.join(', ')}</p>}
    </div>
  );
}

function InspectorPlaceholder({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button type="button" disabled className="flex items-center gap-2 rounded-lg border border-[#d8c5aa] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 py-2 text-[11px] font-extrabold text-[#5c493c] dark:text-[#f3eadf] opacity-60">
      {icon} {label}
    </button>
  );
}

function findNodeDomain(domains: AtlasDomain[], node: AtlasNode) {
  return domains.find((domain) => domain.id === node.id || domain.nodeIds.includes(node.id)) ?? null;
}

function getSourceLabel(node: AtlasNode) {
  if (node.userEdited) return 'user-edited';
  if (node.verified) return 'verified';
  if (node.inferred) return 'inferred';
  if (node.metadata?.origin) return String(node.metadata.origin);
  return 'verified';
}
