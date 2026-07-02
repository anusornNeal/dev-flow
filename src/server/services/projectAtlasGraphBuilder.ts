import path from 'node:path';
import type { AtlasEdge, AtlasNode, AtlasScanStats, ProjectAtlas } from '../../types.js';

export interface AtlasScannedFile {
  path: string;
  extension: string;
  size: number;
  content: string;
  symbols: string[];
  imports: string[];
  routes: string[];
  metadata: Record<string, unknown>;
}

export interface BuildAtlasGraphInput {
  projectId: string;
  root: string;
  files: AtlasScannedFile[];
  skippedDirectories: string[];
  truncated: boolean;
  warnings: string[];
  errors: string[];
  startedAt: number;
}

export function buildAtlasGraphFromScan(input: BuildAtlasGraphInput): ProjectAtlas {
  const nodes = new Map<string, AtlasNode>();
  const edges = new Map<string, AtlasEdge>();

  addNode(nodes, {
    id: `project:${input.projectId}`,
    label: path.basename(input.root),
    kind: 'project',
    verified: { source: 'verified', description: 'Atlas scan project root' },
  });

  for (const file of input.files) {
    addContainment(nodes, edges, input.projectId, file.path);
    addNode(nodes, {
      id: fileNodeId(file.path),
      label: path.basename(file.path),
      kind: resolveNodeKind(file),
      path: file.path,
      verified: { source: 'verified', description: 'File discovered by deterministic Atlas scanner', evidence: file.path },
      metadata: {
        extension: file.extension,
        size: file.size,
        symbols: file.symbols,
        ...file.metadata,
      },
    });
  }

  const filePaths = new Set(input.files.map((file) => file.path));
  for (const file of input.files) {
    for (const importPath of file.imports) {
      const target = resolveImportTarget(file.path, importPath, filePaths);
      if (target) {
        addEdge(edges, {
          id: stableEdgeId('imports', fileNodeId(file.path), fileNodeId(target)),
          source: fileNodeId(file.path),
          target: fileNodeId(target),
          kind: 'imports',
          fact: { source: 'verified', description: `Import '${importPath}' resolves to ${target}` },
        });
      }
    }
    const testTarget = resolveLikelyTestTarget(file.path, filePaths);
    if (testTarget) {
      addEdge(edges, {
        id: stableEdgeId('tests', fileNodeId(file.path), fileNodeId(testTarget)),
        source: fileNodeId(file.path),
        target: fileNodeId(testTarget),
        kind: 'tests',
        fact: { source: 'verified', description: 'Test linked to source by deterministic path/name heuristic' },
      });
    }
  }

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    edges: Array.from(edges.values()).sort((left, right) => left.id.localeCompare(right.id)),
    domains: [],
    flows: [],
    summary: {
      verified: {
        source: 'verified',
        description: `${input.files.length} files scanned into Project Atlas graph`,
      },
    },
    freshness: {
      generatedAt: new Date(input.startedAt).toISOString(),
      scanMode: 'automatic',
      status: 'fresh',
    },
  };
}

export function buildAtlasScanStats(input: Omit<BuildAtlasGraphInput, 'projectId' | 'root' | 'files'> & { fileCount: number }): AtlasScanStats {
  return {
    scannedFileCount: input.fileCount,
    skippedDirectories: input.skippedDirectories.slice().sort(),
    skippedDirectoryCount: input.skippedDirectories.length,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    truncated: input.truncated,
    warnings: input.warnings,
    errors: input.errors,
  };
}

function addContainment(nodes: Map<string, AtlasNode>, edges: Map<string, AtlasEdge>, projectId: string, filePath: string) {
  const segments = filePath.split('/');
  let parentId = `project:${projectId}`;
  let currentPath = '';
  for (const segment of segments.slice(0, -1)) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const folderId = folderNodeId(currentPath);
    addNode(nodes, {
      id: folderId,
      label: segment,
      kind: 'folder',
      path: currentPath,
      verified: { source: 'verified', description: 'Folder discovered from file path', evidence: currentPath },
    });
    addEdge(edges, {
      id: stableEdgeId('contains', parentId, folderId),
      source: parentId,
      target: folderId,
      kind: 'contains',
      fact: { source: 'verified', description: 'Path containment' },
    });
    parentId = folderId;
  }
  addEdge(edges, {
    id: stableEdgeId('contains', parentId, fileNodeId(filePath)),
    source: parentId,
    target: fileNodeId(filePath),
    kind: 'contains',
    fact: { source: 'verified', description: 'Path containment' },
  });
}

function addNode(nodes: Map<string, AtlasNode>, node: AtlasNode) {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, AtlasEdge>, edge: AtlasEdge) {
  if (!edges.has(edge.id)) edges.set(edge.id, edge);
}

function resolveNodeKind(file: AtlasScannedFile): AtlasNode['kind'] {
  if (file.metadata.test) return 'test';
  if (file.metadata.routeCount) return 'route';
  if (file.metadata.component) return 'component';
  if (file.metadata.database) return 'database';
  if (file.metadata.script) return 'script';
  if (file.metadata.config) return 'config';
  return 'file';
}

function resolveImportTarget(sourcePath: string, importPath: string, filePaths: Set<string>) {
  if (!importPath.startsWith('.')) return null;
  const sourceDir = path.posix.dirname(sourcePath);
  const base = path.posix.normalize(path.posix.join(sourceDir, importPath));
  const candidates = [
    base,
    base.replace(/\.(js|jsx|mjs|cjs)$/, '.ts'),
    base.replace(/\.(js|jsx|mjs|cjs)$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => filePaths.has(candidate)) ?? null;
}

function resolveLikelyTestTarget(filePath: string, filePaths: Set<string>) {
  if (!/(^|\/)(tests?|__tests__)\//.test(filePath) && !/\.(test|spec)\.[tj]sx?$/.test(filePath)) return null;
  const normalized = filePath
    .replace(/^tests\//, 'src/')
    .replace(/^test\//, 'src/')
    .replace(/\.test(?=\.[tj]sx?$)/, '')
    .replace(/\.spec(?=\.[tj]sx?$)/, '');
  const basename = path.posix.basename(normalized).replace(/\.[^.]+$/, '').toLowerCase();
  const candidates = Array.from(filePaths).filter((candidate) => {
    if (candidate === filePath) return false;
    const candidateBase = path.posix.basename(candidate).replace(/\.[^.]+$/, '').toLowerCase();
    return candidateBase === basename;
  });
  return candidates.sort((left, right) => left.localeCompare(right))[0] ?? null;
}

function fileNodeId(filePath: string) {
  return `file:${filePath}`;
}

function folderNodeId(folderPath: string) {
  return `folder:${folderPath}`;
}

function stableEdgeId(kind: string, source: string, target: string) {
  return `${kind}:${source}->${target}`;
}
