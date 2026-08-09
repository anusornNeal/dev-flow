export const MAX_FIGMA_AUTHORING_NODES = 8;
const MAX_TEXT_CHARS = 500;
const MAX_ASSETS = 5;
const MAX_EFFECTS = 5;

type FigmaAuthoringProvider = {
  getFigmaFile(fileKey: string): Promise<any>;
  getFigmaDesignSpecs(fileKey: string, nodeIds: string[]): Promise<any[]>;
};

function sourceUrl(fileKey: string, nodeId: string) {
  return `https://www.figma.com/file/${encodeURIComponent(fileKey)}?node-id=${encodeURIComponent(nodeId)}`;
}

function compactNode(spec: any, nodeId: string) {
  return {
    id: spec?.id || nodeId,
    name: spec?.name || 'Unknown',
    type: spec?.type || 'Unknown',
    ...(spec?.bounds ? { bounds: spec.bounds } : {}),
    ...(spec?.text ? { text: String(spec.text).slice(0, MAX_TEXT_CHARS) } : {}),
    ...(spec?.constraints ? { constraints: spec.constraints } : {}),
    ...(spec?.typography ? { typography: spec.typography } : {}),
    ...(spec?.backgroundColor ? { backgroundColor: spec.backgroundColor } : {}),
    ...(spec?.borderColor ? { borderColor: spec.borderColor } : {}),
    ...(spec?.borderWeight !== undefined ? { borderWeight: spec.borderWeight } : {}),
    ...(spec?.cornerRadius !== undefined ? { cornerRadius: spec.cornerRadius } : {}),
    ...(spec?.layout ? { layout: spec.layout } : {}),
    ...(Array.isArray(spec?.assets) && spec.assets.length > 0 ? { assets: spec.assets.slice(0, MAX_ASSETS) } : {}),
    ...(spec?.component ? { component: spec.component } : {}),
    ...(Array.isArray(spec?.effects) && spec.effects.length > 0 ? { effects: spec.effects.slice(0, MAX_EFFECTS) } : {}),
    ...(Number.isFinite(spec?.childCount) ? { childCount: spec.childCount } : {}),
  };
}

function summaryFor(fileKey: string, fileName: string, nodes: any[], refs: Array<{ nodeId: string; url: string }>) {
  const lines = ['## Figma Design Context', `File: ${fileName} (${fileKey})`];
  nodes.forEach((node, index) => {
    const ref = refs[index];
    lines.push('', `### ${node.name} (${ref.nodeId})`, `Source: ${ref.url}`, `Type: ${node.type}`);
    if (node.bounds) lines.push(`Size: ${node.bounds.width ?? 'unknown'} x ${node.bounds.height ?? 'unknown'}`);
    if (node.layout) lines.push(`Layout: ${node.layout.mode ?? 'unknown'}; spacing=${node.layout.spacing ?? 0}; padding=${JSON.stringify(node.layout.padding ?? [])}`);
    if (node.typography) lines.push(`Typography: ${JSON.stringify(node.typography)}`);
    if (node.backgroundColor) lines.push(`Background: ${node.backgroundColor}`);
    if (node.borderColor) lines.push(`Border: ${node.borderColor}${node.borderWeight === undefined ? '' : ` / ${node.borderWeight}`}`);
    if (node.cornerRadius !== undefined) lines.push(`Corner radius: ${node.cornerRadius}`);
    if (node.text) lines.push(`Text: ${node.text}`);
    if (Array.isArray(node.assets) && node.assets.length > 0) lines.push(`Assets: ${node.assets.map((asset: any) => asset.imageRef || asset.type).filter(Boolean).join(', ')}`);
  });
  return lines.join('\n').slice(0, 7000);
}

export async function buildFigmaAuthoringContext(provider: FigmaAuthoringProvider, fileKeyInput: string, nodeIdsInput: string[]) {
  const fileKey = String(fileKeyInput || '').trim();
  if (!fileKey) throw new Error('fileKey is required.');
  const nodeIds = [...new Set((nodeIdsInput || []).map((nodeId) => String(nodeId || '').trim()).filter(Boolean))];
  if (nodeIds.length === 0) throw new Error('At least one nodeId is required.');
  if (nodeIds.length > MAX_FIGMA_AUTHORING_NODES) throw new Error(`Figma authoring context supports at most ${MAX_FIGMA_AUTHORING_NODES} nodes per request.`);

  const [fileData, specs] = await Promise.all([
    provider.getFigmaFile(fileKey),
    provider.getFigmaDesignSpecs(fileKey, nodeIds),
  ]);
  const nodes = nodeIds.map((nodeId, index) => compactNode(specs[index], nodeId));
  const refs = nodeIds.map((nodeId) => ({ fileKey, nodeId, url: sourceUrl(fileKey, nodeId) }));
  const file = {
    fileKey,
    name: fileData?.name || 'Unknown',
    lastModified: fileData?.lastModified,
    version: fileData?.version,
    thumbnailUrl: fileData?.thumbnailUrl,
  };
  return {
    file,
    nodes,
    refs,
    summaryMarkdown: summaryFor(fileKey, file.name, nodes, refs),
    bounds: { requestedNodes: nodeIds.length, maxNodes: MAX_FIGMA_AUTHORING_NODES, textCharsPerNode: MAX_TEXT_CHARS },
  };
}

export function applyFigmaAuthoringContextToTask(task: any, context: { refs: Array<{ url: string }>; summaryMarkdown: string }) {
  const firstRef = context.refs[0];
  if (firstRef?.url) task.sourceUrl = firstRef.url;
  const description = String(task.description || '');
  const alreadyAttached = context.refs.length > 0 && context.refs.every((ref) => description.includes(ref.url));
  if (!alreadyAttached) {
    task.description = description
      ? `${description.trimEnd()}\n\n${context.summaryMarkdown}\n`
      : `${context.summaryMarkdown}\n`;
  }
  return task;
}
