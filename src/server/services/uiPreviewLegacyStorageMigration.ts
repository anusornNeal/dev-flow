export interface LegacyUiPreviewRevisionRecord {
  rowId: string;
  previewId: string;
  revision: number;
}

export interface PreparedUiPreviewLegacyObject {
  key: string;
  bytes: Uint8Array;
}

export interface PreparedUiPreviewLegacyRevision<Manifest> {
  objects: PreparedUiPreviewLegacyObject[];
  manifest: Manifest;
}

export interface LegacyUiPreviewRevisionPage<Row> {
  rows: Row[];
  nextCursor: string | null;
}

export interface UiPreviewLegacyStorageMigrationDependencies<
  Row extends LegacyUiPreviewRevisionRecord,
  Manifest,
> {
  listLegacyRevisions(input: {
    cursor: string | null;
    limit: number;
  }): Promise<LegacyUiPreviewRevisionPage<Row>> | LegacyUiPreviewRevisionPage<Row>;
  isRowMigrated(row: Row): Promise<boolean> | boolean;
  prepareRevision(row: Row): Promise<PreparedUiPreviewLegacyRevision<Manifest>> | PreparedUiPreviewLegacyRevision<Manifest>;
  writeObject(input: {
    row: Row;
    object: PreparedUiPreviewLegacyObject;
  }): Promise<void> | void;
  findManifest(row: Row): Promise<Manifest | null> | Manifest | null;
  insertManifest(input: {
    row: Row;
    manifest: Manifest;
  }): Promise<Manifest> | Manifest;
  verifyObjects(input: {
    row: Row;
    manifest: Manifest;
  }): Promise<void> | void;
  markRowMigrated(input: {
    row: Row;
    manifest: Manifest;
  }): Promise<void> | void;
  maxBatchSize?: number;
  defaultBatchSize?: number;
}

export interface MigrateUiPreviewLegacyStorageBatchInput {
  cursor?: string | null;
  limit?: number;
}

export interface MigrateUiPreviewLegacyStorageBatchResult {
  scanned: number;
  migrated: number;
  replayed: number;
  nextCursor: string | null;
  done: boolean;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCH_SIZE = 100;

function positiveInteger(value: unknown, name: string) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return numeric;
}

function resolveBatchBounds(input: {
  maxBatchSize?: number;
  defaultBatchSize?: number;
}) {
  const maxBatchSize = input.maxBatchSize === undefined
    ? DEFAULT_MAX_BATCH_SIZE
    : positiveInteger(input.maxBatchSize, 'maxBatchSize');
  const defaultBatchSize = input.defaultBatchSize === undefined
    ? Math.min(DEFAULT_BATCH_SIZE, maxBatchSize)
    : positiveInteger(input.defaultBatchSize, 'defaultBatchSize');

  if (defaultBatchSize > maxBatchSize) {
    throw new RangeError('defaultBatchSize cannot exceed maxBatchSize.');
  }
  return { maxBatchSize, defaultBatchSize };
}

function assertPreparedRevision<Manifest>(
  row: LegacyUiPreviewRevisionRecord,
  prepared: PreparedUiPreviewLegacyRevision<Manifest>,
) {
  if (!prepared || typeof prepared !== 'object' || !Array.isArray(prepared.objects)) {
    throw new TypeError(`Prepared legacy revision '${row.rowId}' must provide an objects array.`);
  }
  for (const object of prepared.objects) {
    if (!object || typeof object.key !== 'string' || !object.key) {
      throw new TypeError(`Prepared legacy revision '${row.rowId}' contains an object without a key.`);
    }
    if (!(object.bytes instanceof Uint8Array)) {
      throw new TypeError(`Prepared legacy object '${object.key}' must provide exact Uint8Array bytes.`);
    }
  }
}

export function createUiPreviewLegacyStorageMigration<
  Row extends LegacyUiPreviewRevisionRecord,
  Manifest,
>(deps: UiPreviewLegacyStorageMigrationDependencies<Row, Manifest>) {
  const { maxBatchSize, defaultBatchSize } = resolveBatchBounds(deps);

  async function migrateBatch(
    input: MigrateUiPreviewLegacyStorageBatchInput = {},
  ): Promise<MigrateUiPreviewLegacyStorageBatchResult> {
    const limit = input.limit === undefined ? defaultBatchSize : positiveInteger(input.limit, 'limit');
    if (limit > maxBatchSize) {
      throw new RangeError(`limit cannot exceed maxBatchSize (${maxBatchSize}).`);
    }

    const cursor = input.cursor ?? null;
    const page = await deps.listLegacyRevisions({ cursor, limit });
    if (!page || !Array.isArray(page.rows)) {
      throw new TypeError('listLegacyRevisions must return a rows array.');
    }
    if (page.rows.length > limit) {
      throw new RangeError(`listLegacyRevisions returned ${page.rows.length} rows for a bounded limit of ${limit}.`);
    }
    if (page.nextCursor !== null && typeof page.nextCursor !== 'string') {
      throw new TypeError('listLegacyRevisions nextCursor must be a string or null.');
    }

    let migrated = 0;
    let replayed = 0;

    for (const row of page.rows) {
      if (await deps.isRowMigrated(row)) {
        replayed += 1;
        continue;
      }

      const prepared = await deps.prepareRevision(row);
      assertPreparedRevision(row, prepared);

      // Rewrites are intentionally allowed on retry. A correct content-addressed
      // writer is idempotent, and rewriting before manifest lookup can repair a
      // write that became durable immediately before an interrupted call.
      for (const object of prepared.objects) {
        await deps.writeObject({ row, object });
      }

      // Manifest lookup happens only after every prepared object write has
      // completed. If a prior insert became durable before its caller observed
      // success, reuse that manifest instead of inserting a duplicate.
      const existingManifest = await deps.findManifest(row);
      const manifest = existingManifest ?? await deps.insertManifest({
        row,
        manifest: prepared.manifest,
      });

      // Verification is the durability gate. The legacy fallback remains
      // untouched until every object referenced by the durable manifest has
      // been verified by the injected storage adapter.
      await deps.verifyObjects({ row, manifest });

      // This callback is deliberately last. Implementations may atomically set
      // a compatibility sentinel and/or clear legacy payload columns here.
      await deps.markRowMigrated({ row, manifest });
      migrated += 1;
    }

    return {
      scanned: page.rows.length,
      migrated,
      replayed,
      nextCursor: page.nextCursor,
      done: page.nextCursor === null,
    };
  }

  return { migrateBatch };
}
