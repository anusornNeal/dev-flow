import React from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { TaskUiEvidence } from '../../client/uiPreviewClient';

interface UiDesignEvidenceSectionProps {
  evidence: TaskUiEvidence[];
  loading?: boolean;
  loadingMore?: boolean;
  error?: string | null;
  nextCursor?: string | null;
  onRefresh?: () => void;
  onLoadMore?: () => void;
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(nonEmpty);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(nonEmpty);
  return true;
}

function compactSpec(value: unknown): unknown {
  if (Array.isArray(value)) {
    const compacted = value.map(compactSpec).filter(nonEmpty);
    return compacted;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, compactSpec(child)] as const)
        .filter(([, child]) => nonEmpty(child)),
    );
  }
  return value;
}

function byAttachedAtDesc(a: TaskUiEvidence, b: TaskUiEvidence) {
  return String(b.attachedAt || '').localeCompare(String(a.attachedAt || ''));
}

function chooseEvidenceByPreview(evidence: TaskUiEvidence[]) {
  const groups = new Map<string, TaskUiEvidence[]>();
  for (const item of evidence) {
    const list = groups.get(item.previewId) || [];
    list.push(item);
    groups.set(item.previewId, list);
  }

  return Array.from(groups.entries()).map(([previewId, items]) => {
    const deduped = new Map<number, TaskUiEvidence>();
    for (const item of items) {
      const existing = deduped.get(item.frozenRevision);
      if (!existing || (item.current && !existing.current) || byAttachedAtDesc(item, existing) < 0) {
        deduped.set(item.frozenRevision, item);
      }
    }
    const unique = Array.from(deduped.values());
    const explicitCurrent = unique
      .filter((item) => item.current)
      .sort((a, b) => b.frozenRevision - a.frozenRevision || byAttachedAtDesc(a, b));
    const current = explicitCurrent[0]
      || unique.slice().sort((a, b) => b.frozenRevision - a.frozenRevision || byAttachedAtDesc(a, b))[0];
    const previous = unique
      .filter((item) => item !== current)
      .sort((a, b) => b.frozenRevision - a.frozenRevision || byAttachedAtDesc(a, b));
    return { previewId, current, previous };
  }).filter((group) => Boolean(group.current))
    .sort((a, b) => byAttachedAtDesc(a.current, b.current));
}

function SpecSummary({ spec }: { spec: Record<string, unknown> }) {
  const compacted = compactSpec(spec) as Record<string, unknown>;
  const summary = compacted.summary && typeof compacted.summary === 'object'
    ? compacted.summary as Record<string, unknown>
    : null;
  const screen = typeof summary?.screen === 'string' ? summary.screen : null;
  const purpose = typeof summary?.purpose === 'string' ? summary.purpose : null;
  const detailEntries = Object.entries(compacted).filter(([key, value]) => key !== 'schemaVersion' && nonEmpty(value));

  if (!screen && !purpose && detailEntries.length === 0) return null;
  return (
    <div className="space-y-2">
      {(screen || purpose) && (
        <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] px-3 py-2 text-[12px]">
          {screen && <div className="break-words font-extrabold text-[var(--df-color-text-strong)]">{screen}</div>}
          {purpose && <div className="mt-0.5 break-words text-[var(--df-color-text-muted)]">{purpose}</div>}
        </div>
      )}
      <details className="rounded-xl border border-[#eadbc5] bg-white/70 p-3 dark:border-[#584a3b] dark:bg-[#211a15]/80">
        <summary className="cursor-pointer text-[11px] font-extrabold text-[#7d6048] dark:text-[#e2d5ca]">Full structured spec</summary>
        <div className="mt-3 space-y-3">
          {detailEntries.map(([key, value]) => (
            <div key={key}>
              <div className="mb-1 text-[10px] font-black uppercase tracking-[0.08em] text-[#9a6427] dark:text-[#e0a070]">{key}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-[#fbf7f1] p-2 text-[10px] leading-5 text-[#5d493a] dark:bg-[#18130f] dark:text-[#e7d9cc]">{JSON.stringify(value, null, 2)}</pre>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function PreviewLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="df-button df-button--secondary min-h-8 min-w-0 max-w-full cursor-pointer px-2.5 py-1.5 text-[var(--df-color-info)]"
    >
      <ExternalLink size={12} />
      {children}
    </a>
  );
}

function EvidenceMeta({ item }: { item: TaskUiEvidence }) {
  return (
    <div className="df-break-technical flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-[var(--df-color-text-muted)]">
      <span>Revision {item.frozenRevision}</span>
      {item.latestRevision > item.frozenRevision && <span>Latest {item.latestRevision}</span>}
      {item.attachedAt && <span>{new Date(item.attachedAt).toLocaleString()}</span>}
    </div>
  );
}

function withPrimaryScreen(href: string, primaryScreenId?: string | null) {
  if (!href || !primaryScreenId) return href;
  const hashIndex = href.indexOf('#');
  const base = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : '';
  const encodedScreenId = encodeURIComponent(primaryScreenId);
  const screenParam = /([?&])screenId=[^&#]*/;
  const withScreen = screenParam.test(base)
    ? base.replace(screenParam, `$1screenId=${encodedScreenId}`)
    : `${base}${base.includes('?') ? '&' : '?'}screenId=${encodedScreenId}`;
  return `${withScreen}${hash}`;
}

function CurrentEvidenceCard({ item, previous }: { item: TaskUiEvidence; previous: TaskUiEvidence[] }) {
  const title = item.title || item.previewId;
  const frozenPreviewUrl = withPrimaryScreen(item.frozenPreviewUrl, item.primaryScreenId);
  return (
    <article className="overflow-hidden rounded-2xl border border-[#eadbc5] bg-white/80 dark:border-[#584a3b] dark:bg-[#292119]/70">
      {item.screenshotUrl && frozenPreviewUrl ? (
        <a
          href={frozenPreviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open Design: ${title}`}
          className="group relative block cursor-pointer border-b border-[#eadbc5] dark:border-[#584a3b]"
        >
          <img src={item.screenshotUrl} alt={`${title} UI preview`} className="max-h-[420px] w-full object-contain" />
          <span className="pointer-events-none absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg border border-white/70 bg-black/70 px-2.5 py-1.5 text-[11px] font-extrabold text-white shadow-sm">
            <ExternalLink size={12} /> Open Design
          </span>
        </a>
      ) : item.screenshotUrl ? (
        <img src={item.screenshotUrl} alt={`${title} UI preview`} className="max-h-[420px] w-full border-b border-[#eadbc5] object-contain dark:border-[#584a3b]" />
      ) : null}
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="break-words text-[13px] font-black text-[var(--df-color-text-strong)]">{title}</div>
            <EvidenceMeta item={item} />
          </div>
          {item.latestRevision > item.frozenRevision && item.latestPreviewUrl && (
            <div className="flex flex-wrap gap-2">
              <PreviewLink href={item.latestPreviewUrl}>Open Latest</PreviewLink>
            </div>
          )}
        </div>
        <SpecSummary spec={item.spec} />
        {previous.length > 0 && (
          <details className="rounded-xl border border-[#eadbc5] p-3 dark:border-[#584a3b]">
            <summary className="cursor-pointer text-[11px] font-extrabold text-[#7d6048] dark:text-[#e2d5ca]">Previous revisions ({previous.length})</summary>
            <div className="mt-3 space-y-2">
              {previous.map((older) => (
                <div key={older.evidenceId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#f8f1e6] px-3 py-2 dark:bg-[#211a15]">
                  <EvidenceMeta item={older} />
                  {older.frozenPreviewUrl && <PreviewLink href={withPrimaryScreen(older.frozenPreviewUrl, older.primaryScreenId)}>Open Preview</PreviewLink>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

export default function UiDesignEvidenceSection({
  evidence,
  loading = false,
  loadingMore = false,
  error = null,
  nextCursor = null,
  onRefresh,
  onLoadMore,
}: UiDesignEvidenceSectionProps) {
  const groups = chooseEvidenceByPreview(evidence);
  if (groups.length === 0 && !loading && !error) return null;

  return (
    <section className="df-surface min-w-0 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="df-heading-sm uppercase tracking-[0.08em]">UI Design</h3>
          <p className="df-meta mt-1 break-words">Frozen task evidence. Preview links refresh with the current DevFlow runtime.</p>
        </div>
        {onRefresh && (
          <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#dfccb1] bg-white px-2.5 py-1.5 text-[11px] font-extrabold text-[#7d6048] disabled:cursor-default disabled:opacity-50 dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#e2d5ca]">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {error && (
        <div className="df-feedback df-feedback--danger mb-3">
          <div className="df-feedback__summary">UI Design evidence unavailable</div>
          <div className="df-feedback__detail df-break-technical">{error}</div>
        </div>
      )}

      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => <CurrentEvidenceCard key={group.previewId} item={group.current} previous={group.previous} />)}
        </div>
      ) : loading ? (
        <div className="py-5 text-center text-[12px] font-semibold text-[#927d6c] dark:text-[#ad9d91]">Loading UI Design evidence…</div>
      ) : null}

      {nextCursor && onLoadMore && (
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className="mt-3 w-full cursor-pointer rounded-lg border border-[#dfccb1] bg-white px-3 py-2 text-[11px] font-extrabold text-[#7d6048] disabled:cursor-default disabled:opacity-50 dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#e2d5ca]">
          {loadingMore ? 'Loading previous revisions…' : 'Load previous revisions'}
        </button>
      )}
    </section>
  );
}
