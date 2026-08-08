import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveFileRef } from './fileReferenceService';
import type { SafeEditOperation } from './safeEditFileService';
import { prepareEditPlan, type PreparedEditPlanResult } from './preparedEditService';

const SUPPORTED_VERSIONS = [1] as const;
const MAX_STRING_TABLE_ENTRIES = 1_000;
const MAX_FILE_TUPLES = 100;
const MAX_OPERATIONS_PER_FILE = 1_000;

type StringSlot = string | number;
type CompactOperation = [string, ...unknown[]];
type CompactFileTuple = [string, CompactOperation[]];

export type DecodedStenoFile = {
  filePath: string;
  expectedSha256: string;
  edits: SafeEditOperation[];
};

export type StenoDiagnostics = {
  protocolVersion: 1;
  stringTableEntries: number;
  stringReferences: number;
  expandedOperations: number;
  files: number;
};

export type DecodedStenoEditRequest = {
  files: DecodedStenoFile[];
  diagnostics: StenoDiagnostics;
};

function invalidArgs(message: string, details?: unknown): never {
  throw createApiError(400, 'INVALID_ARGS', message, { retryable: false, details });
}

function validateVersion(value: unknown): 1 {
  if (value !== 1) {
    throw createApiError(400, 'EDIT_PROTOCOL_VERSION_UNSUPPORTED', `Unsupported Steno Edit protocol version '${String(value)}'.`, {
      retryable: false,
      details: {
        supportedVersions: [...SUPPORTED_VERSIONS],
        guidance: 'Send v=1 or use the legacy safe-edit tools.',
      },
    });
  }
  return 1;
}

function readStringTable(value: unknown) {
  if (value === undefined) return [] as string[];
  if (!Array.isArray(value)) {
    throw createApiError(400, 'EDIT_DICT_REF_INVALID', 's must be an array of literal UTF-8 strings.', { retryable: false });
  }
  if (value.length > MAX_STRING_TABLE_ENTRIES) {
    throw createApiError(400, 'EDIT_DICT_REF_INVALID', `s contains ${value.length} entries; maximum is ${MAX_STRING_TABLE_ENTRIES}.`, { retryable: false });
  }
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string') {
      throw createApiError(400, 'EDIT_DICT_REF_INVALID', `s[${index}] must be a literal string. Nested or recursive references are not supported.`, { retryable: false });
    }
  }
  return value as string[];
}

function resolveStringSlot(slot: unknown, strings: string[], label: string, diagnostics: StenoDiagnostics) {
  if (typeof slot === 'string') return slot;
  if (typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < strings.length) {
    diagnostics.stringReferences += 1;
    return strings[slot];
  }
  throw createApiError(400, 'EDIT_DICT_REF_INVALID', `${label} must be a literal string or a valid non-negative index into s.`, {
    retryable: false,
    details: {
      provided: slot,
      stringTableEntries: strings.length,
      guidance: 'Fix the string-table index or send the literal string directly.',
    },
  });
}

function occurrence(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) invalidArgs(`${label} occurrence must be a positive 1-based integer.`);
  return Number(value);
}

function assertTupleLength(tuple: CompactOperation, expectedMin: number, expectedMax: number, opcode: string) {
  if (tuple.length < expectedMin || tuple.length > expectedMax) {
    invalidArgs(`${opcode} tuple must contain ${expectedMin}${expectedMin === expectedMax ? '' : `-${expectedMax}`} entries including the opcode.`);
  }
}

function decodeOperation(raw: unknown, strings: string[], diagnostics: StenoDiagnostics, operationIndex: number): SafeEditOperation {
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== 'string') {
    invalidArgs(`Operation ${operationIndex} must be a compact operation tuple.`);
  }
  const tuple = raw as CompactOperation;
  const opcode = tuple[0];

  if (opcode === 'R') {
    assertTupleLength(tuple, 3, 4, opcode);
    return {
      type: 'replace',
      find: resolveStringSlot(tuple[1], strings, `R[${operationIndex}].find`, diagnostics),
      replaceWith: resolveStringSlot(tuple[2], strings, `R[${operationIndex}].replacement`, diagnostics),
      occurrence: occurrence(tuple[3], `R[${operationIndex}]`),
    };
  }
  if (opcode === 'IB') {
    assertTupleLength(tuple, 3, 4, opcode);
    return {
      type: 'insert_before',
      find: resolveStringSlot(tuple[1], strings, `IB[${operationIndex}].find`, diagnostics),
      content: resolveStringSlot(tuple[2], strings, `IB[${operationIndex}].text`, diagnostics),
      occurrence: occurrence(tuple[3], `IB[${operationIndex}]`),
    };
  }
  if (opcode === 'IA') {
    assertTupleLength(tuple, 3, 4, opcode);
    return {
      type: 'insert_after',
      find: resolveStringSlot(tuple[1], strings, `IA[${operationIndex}].find`, diagnostics),
      content: resolveStringSlot(tuple[2], strings, `IA[${operationIndex}].text`, diagnostics),
      occurrence: occurrence(tuple[3], `IA[${operationIndex}]`),
    };
  }
  if (opcode === 'DB') {
    assertTupleLength(tuple, 3, 4, opcode);
    return {
      type: 'delete_between',
      start: resolveStringSlot(tuple[1], strings, `DB[${operationIndex}].start`, diagnostics),
      end: resolveStringSlot(tuple[2], strings, `DB[${operationIndex}].end`, diagnostics),
      occurrence: occurrence(tuple[3], `DB[${operationIndex}]`),
    };
  }

  invalidArgs(`Unsupported Steno Edit opcode '${opcode}'. Supported opcodes are R, IB, IA, DB.`);
}

export function decodeStenoEditRequest(
  state: AppState,
  args: Record<string, any>,
  options: { nowMs?: number } = {},
): DecodedStenoEditRequest {
  const protocolVersion = validateVersion(args.v);
  const strings = readStringTable(args.s);
  if (!Array.isArray(args.f) || args.f.length === 0) invalidArgs('f must contain at least one [fileRef, operations] tuple.');
  if (args.f.length > MAX_FILE_TUPLES) invalidArgs(`f contains ${args.f.length} files; maximum is ${MAX_FILE_TUPLES}.`);

  const diagnostics: StenoDiagnostics = {
    protocolVersion,
    stringTableEntries: strings.length,
    stringReferences: 0,
    expandedOperations: 0,
    files: args.f.length,
  };

  const files = (args.f as unknown[]).map((rawFile, fileIndex): DecodedStenoFile => {
    if (!Array.isArray(rawFile) || rawFile.length !== 2 || typeof rawFile[0] !== 'string' || !Array.isArray(rawFile[1])) {
      invalidArgs(`f[${fileIndex}] must be [fileRef, operations].`);
    }
    const [fileRef, rawOperations] = rawFile as CompactFileTuple;
    if (rawOperations.length === 0) invalidArgs(`f[${fileIndex}] must contain at least one operation.`);
    if (rawOperations.length > MAX_OPERATIONS_PER_FILE) invalidArgs(`f[${fileIndex}] contains too many operations.`);

    const resolved = resolveFileRef(state, args, fileRef, options);
    const edits = rawOperations.map((operation, operationIndex) => decodeOperation(operation, strings, diagnostics, operationIndex));
    diagnostics.expandedOperations += edits.length;
    return {
      filePath: resolved.filePath,
      expectedSha256: resolved.revision.sha256,
      edits,
    };
  });

  return { files, diagnostics };
}

export type PrepareCompactEditResult = PreparedEditPlanResult & {
  compact?: StenoDiagnostics & {
    incomingBytes: number;
    expandedEditBytes: number;
  };
};

export function prepareCompactEdit(state: AppState, args: Record<string, any>): PrepareCompactEditResult {
  const incomingBytes = Buffer.byteLength(JSON.stringify({ v: args.v, s: args.s, f: args.f }), 'utf8');
  const decoded = decodeStenoEditRequest(state, args);
  const expandedEditBytes = Buffer.byteLength(JSON.stringify(decoded.files.map((file) => file.edits)), 'utf8');
  const result = prepareEditPlan(state, {
    projectId: args.projectId,
    projectName: args.projectName,
    repo: args.repo,
    repoUrl: args.repoUrl,
    localPath: args.localPath,
    ttlMs: args.ttlMs,
    maxPayloadBytes: args.maxPayloadBytes,
    maxFileBytes: args.maxFileBytes,
    files: decoded.files,
  });
  return {
    ...result,
    compact: {
      ...decoded.diagnostics,
      incomingBytes,
      expandedEditBytes,
    },
  };
}
