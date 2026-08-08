import test from 'node:test';
import assert from 'node:assert/strict';

const projectId = 'project-benchmark-compact-edit';
const planId = 'edit-plan-12345678-1234-4234-8234-123456789abc';
const filePaths = [
  'src/server/example.ts',
  'app/src/main/kotlin/Example.kt',
  'tools/example.py',
  'cmd/example.go',
  'docs/example.md',
];

const anchors = [
  'DEVFLOW_TIMEOUT=30000',
  'DEVFLOW_RETRIES=2',
  'DEVFLOW_MODE=legacy',
];
const replacements = [
  'DEVFLOW_TIMEOUT=60000',
  'DEVFLOW_RETRIES=3',
  'DEVFLOW_MODE=compact',
];

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

const files = filePaths.map((filePath, index) => ({
  filePath,
  fileRef: `file-ref-12345678-1234-4234-8234-123456789ab${index}`,
  expectedSha256: `${index}`.repeat(64),
  edits: anchors.map((find, opIndex) => ({
    type: 'replace',
    find,
    replaceWith: replacements[opIndex],
    occurrence: 1,
  })),
}));

function buildUnifiedPatch() {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(`--- a/${file.filePath}`, `+++ b/${file.filePath}`);
    for (let index = 0; index < anchors.length; index += 1) {
      lines.push('@@ -1 +1 @@', `-${anchors[index]}`, `+${replacements[index]}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function stringTable() {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const edit of file.edits) {
      counts.set(edit.find, (counts.get(edit.find) || 0) + 1);
      counts.set(edit.replaceWith, (counts.get(edit.replaceWith) || 0) + 1);
    }
  }
  return Array.from(counts.entries()).filter(([, count]) => count > 1).map(([value]) => value);
}

function compactPayload(useTable: boolean) {
  const s = useTable ? stringTable() : [];
  const indexes = new Map(s.map((value, index) => [value, index]));
  const slot = (value: string) => indexes.has(value) ? indexes.get(value)! : value;
  return {
    projectId,
    v: 1,
    ...(useTable ? { s } : {}),
    f: files.map((file) => [
      file.fileRef,
      file.edits.map((edit) => ['R', slot(edit.find), slot(edit.replaceWith), edit.occurrence]),
    ]),
  };
}

test('Steno Edit v1 transport benchmark beats legacy edit payloads on one identical multi-ecosystem workload', () => {
  const verbosePrepare = {
    projectId,
    files: files.map(({ filePath, expectedSha256, edits }) => ({ filePath, expectedSha256, edits })),
  };
  const verboseResendApply = { ...verbosePrepare, mode: 'apply' };
  const verbosePlanApply = { projectId, editPlanId: planId };
  const patch = buildUnifiedPatch();
  const patchPreview = { projectId, patch, dryRun: true };
  const patchApply = { projectId, patch, dryRun: false };
  const stenoNoTable = compactPayload(false);
  const stenoTable = compactPayload(true);
  const compactApply = { editPlanId: planId };

  const result = {
    fixture: { files: files.length, operationsPerFile: anchors.length, ecosystems: ['TypeScript', 'Kotlin', 'Python', 'Go', 'Markdown'] },
    legacyUnifiedPatch: {
      prepareBytes: bytes(patchPreview),
      applyBytes: bytes(patchApply),
      totalBytes: bytes(patchPreview) + bytes(patchApply),
    },
    legacyVerboseResend: {
      prepareBytes: bytes(verbosePrepare),
      applyBytes: bytes(verboseResendApply),
      totalBytes: bytes(verbosePrepare) + bytes(verboseResendApply),
    },
    existingVerbosePlanId: {
      prepareBytes: bytes(verbosePrepare),
      applyBytes: bytes(verbosePlanApply),
      totalBytes: bytes(verbosePrepare) + bytes(verbosePlanApply),
    },
    stenoNoTable: {
      prepareBytes: bytes(stenoNoTable),
      applyBytes: bytes(compactApply),
      totalBytes: bytes(stenoNoTable) + bytes(compactApply),
    },
    stenoStringTable: {
      prepareBytes: bytes(stenoTable),
      applyBytes: bytes(compactApply),
      totalBytes: bytes(stenoTable) + bytes(compactApply),
      stringTableEntries: stringTable().length,
    },
  };

  const tableTotal = result.stenoStringTable.totalBytes;
  const ratios = {
    vsUnifiedPatch: Number((result.legacyUnifiedPatch.totalBytes / tableTotal).toFixed(2)),
    vsVerboseResend: Number((result.legacyVerboseResend.totalBytes / tableTotal).toFixed(2)),
    vsExistingVerbosePlanId: Number((result.existingVerbosePlanId.totalBytes / tableTotal).toFixed(2)),
    tableVsNoTable: Number((result.stenoNoTable.totalBytes / tableTotal).toFixed(2)),
  };

  console.log(`[steno-benchmark] ${JSON.stringify({ ...result, ratios })}`);

  assert.equal(result.stenoStringTable.stringTableEntries, 6);
  assert.equal(result.stenoStringTable.applyBytes, bytes({ editPlanId: planId }));
  assert.equal(result.stenoStringTable.totalBytes < result.stenoNoTable.totalBytes, true);
  assert.equal(ratios.vsUnifiedPatch >= 2, true);
  assert.equal(ratios.vsVerboseResend >= 3, true);
  assert.equal(ratios.vsExistingVerbosePlanId >= 2, true);
});
