import fs from 'node:fs';
import path from 'node:path';
import type { ProjectAtlasScanResult } from '../../types.js';
import { getProjectRulesContext } from './projectRulesService.js';
import { buildAtlasGraphFromScan, buildAtlasScanStats, type AtlasScannedFile } from './projectAtlasGraphBuilder.js';

export interface ScanProjectForAtlasInput {
  projectId: string;
  root: string;
  path?: string;
  includeIgnored?: boolean;
}

interface EffectiveScanRules {
  ignoreDirectories: Set<string>;
  includeDirectories: Set<string>;
  maxFiles: number;
  maxFileBytes: number;
}

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.sql', '.xml']);

export function scanProjectForAtlas(input: ScanProjectForAtlasInput): ProjectAtlasScanResult {
  const startedAt = Date.now();
  const root = path.resolve(input.root);
  const basePath = path.resolve(root, input.path ?? '.');
  const rules = loadEffectiveScanRules(root);
  const skippedDirectories = new Set<string>();
  const warnings: string[] = [];
  const errors: string[] = [];
  const files: AtlasScannedFile[] = [];
  let truncated = false;

  if (!basePath.startsWith(root)) {
    throw new Error('Atlas scan path must stay inside the project root.');
  }

  walkAtlasFiles(root, basePath, {
    includeIgnored: input.includeIgnored === true,
    rules,
    skippedDirectories,
    files,
    warnings,
    errors,
    markTruncated: () => {
      truncated = true;
    },
  });

  const atlas = buildAtlasGraphFromScan({
    projectId: input.projectId,
    root,
    files,
    skippedDirectories: Array.from(skippedDirectories),
    truncated,
    warnings,
    errors,
    startedAt,
  });
  const scanStats = buildAtlasScanStats({
    fileCount: files.length,
    skippedDirectories: Array.from(skippedDirectories),
    truncated,
    warnings,
    errors,
    startedAt,
  });
  return { atlas, scanStats };
}

function walkAtlasFiles(
  root: string,
  currentPath: string,
  options: {
    includeIgnored: boolean;
    rules: EffectiveScanRules;
    skippedDirectories: Set<string>;
    files: AtlasScannedFile[];
    warnings: string[];
    errors: string[];
    markTruncated: () => void;
  },
) {
  if (options.files.length >= options.rules.maxFiles) {
    options.markTruncated();
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch (error) {
    options.errors.push(`Unable to read ${toRelativePath(root, currentPath)}: ${formatError(error)}`);
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (options.files.length >= options.rules.maxFiles) {
      options.markTruncated();
      return;
    }
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = toRelativePath(root, fullPath);
    if (entry.isDirectory()) {
      if (!options.includeIgnored && shouldSkipDirectory(relativePath, entry.name, options.rules)) {
        options.skippedDirectories.add(relativePath);
        continue;
      }
      walkAtlasFiles(root, fullPath, options);
      continue;
    }

    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SCANNABLE_EXTENSIONS.has(extension)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.size > options.rules.maxFileBytes) {
      options.warnings.push(`Skipped oversized file ${relativePath}`);
      continue;
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      options.files.push(buildScannedFile(relativePath, extension, stat.size, content));
    } catch (error) {
      options.errors.push(`Unable to read ${relativePath}: ${formatError(error)}`);
    }
  }
}

function buildScannedFile(filePath: string, extension: string, size: number, content: string): AtlasScannedFile {
  const symbols = extractSymbols(content, extension);
  const routes = extractRoutes(content);
  return {
    path: filePath,
    extension,
    size,
    content,
    symbols,
    imports: extractImports(content),
    routes,
    metadata: {
      routeCount: routes.length,
      routes,
      component: extension === '.tsx' && isReactComponent(content, symbols),
      service: /(^|\/)(services?|useCases?)\//i.test(filePath),
      repository: /(^|\/)repositories\//i.test(filePath),
      database: /(^|\/)(db|database|migrations?)\//i.test(filePath) || /\.sql$/i.test(filePath),
      script: /^scripts\//i.test(filePath),
      config: /(^|\/)(config|\.github)\//i.test(filePath) || ['package.json', 'tsconfig.json', 'vite.config.ts'].includes(filePath),
      test: /(^|\/)(tests?|__tests__)\//i.test(filePath) || /\.(test|spec)\.[tj]sx?$/i.test(filePath),
      devflow: /(^|\/)(tasks?|agent|skills?)\b/i.test(filePath),
    },
  };
}

function extractSymbols(content: string, extension: string) {
  if (extension === '.json' || extension === '.md' || extension === '.sql') return [];
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) symbols.add(match[1]);
      if (symbols.size >= 40) return Array.from(symbols);
    }
  }
  return Array.from(symbols);
}

function extractImports(content: string) {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }
  return Array.from(imports).sort();
}

function extractRoutes(content: string) {
  const routes = new Set<string>();
  const routePattern = /\b(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const match of content.matchAll(routePattern)) {
    if (match[1]) routes.add(match[1]);
  }
  return Array.from(routes).sort();
}

function isReactComponent(content: string, symbols: string[]) {
  return symbols.some((symbol) => /^[A-Z]/.test(symbol)) && /<[\w.]+[\s>]/.test(content);
}

function loadEffectiveScanRules(root: string): EffectiveScanRules {
  const rules = getProjectRulesContext(root).files;
  const includeDirectories = new Set(rules.includeDirectories.map(normalizeRulePath));
  const ignoreDirectories = new Set(rules.ignoreDirectories.map(normalizeRulePath));
  for (const includeDir of includeDirectories) {
    ignoreDirectories.delete(includeDir);
  }
  return {
    ignoreDirectories,
    includeDirectories,
    maxFiles: rules.maxFiles,
    maxFileBytes: rules.maxFileBytes,
  };
}

function shouldSkipDirectory(relativePath: string, entryName: string, rules: EffectiveScanRules) {
  if (entryName.startsWith('.') && !rules.includeDirectories.has(entryName)) return true;
  const normalizedRelativePath = normalizeRulePath(relativePath);
  const normalizedEntryName = normalizeRulePath(entryName);
  return rules.ignoreDirectories.has(normalizedEntryName) || rules.ignoreDirectories.has(normalizedRelativePath);
}

function normalizeRulePath(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function toRelativePath(root: string, targetPath: string) {
  return path.relative(root, targetPath).replace(/\\/g, '/') || '.';
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
