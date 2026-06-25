import db from '../../db/index';

export type AttachmentKind = 'file' | 'image' | 'spec' | 'design';

export interface AttachmentRecord {
  id: string;
  taskId?: string | null;
  projectId?: string | null;
  kind: AttachmentKind;
  originalName: string;
  storedName: string;
  mimeType?: string | null;
  sizeBytes: number;
  relativePath: string;
  createdAt: string;
  updatedAt?: string | null;
  deletedAt?: string | null;
}

interface AttachmentRow {
  id: string;
  taskId: string | null;
  projectId: string | null;
  kind: string;
  originalName: string;
  storedName: string;
  mimeType: string | null;
  sizeBytes: number;
  relativePath: string;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
}

function rowToRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    kind: (row.kind as AttachmentKind) || 'file',
    originalName: row.originalName,
    storedName: row.storedName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    relativePath: row.relativePath,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export function listAttachmentsForTask(taskId: string): AttachmentRecord[] {
  const rows = db
    .prepare(
      'SELECT * FROM attachments WHERE taskId = ? AND deletedAt IS NULL ORDER BY createdAt DESC',
    )
    .all(taskId) as AttachmentRow[];
  return rows.map(rowToRecord);
}

export function getAttachment(id: string): AttachmentRecord | null {
  const row = db
    .prepare('SELECT * FROM attachments WHERE id = ? AND deletedAt IS NULL')
    .get(id) as AttachmentRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function createAttachment(input: AttachmentRecord): AttachmentRecord {
  db.prepare(
    `INSERT INTO attachments (
      id, taskId, projectId, kind, originalName, storedName, mimeType, sizeBytes, relativePath, createdAt, updatedAt, deletedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.taskId ?? null,
    input.projectId ?? null,
    input.kind,
    input.originalName,
    input.storedName,
    input.mimeType ?? null,
    input.sizeBytes,
    input.relativePath,
    input.createdAt,
    input.updatedAt ?? null,
    input.deletedAt ?? null,
  );
  return getAttachment(input.id) || input;
}

export function softDeleteAttachment(id: string): boolean {
  const existing = getAttachment(id);
  if (!existing) return false;
  const now = new Date().toISOString();
  db.prepare('UPDATE attachments SET deletedAt = ?, updatedAt = ? WHERE id = ?').run(now, now, id);
  return true;
}

export function deleteAttachmentsForTask(taskId: string): void {
  db.prepare('DELETE FROM attachments WHERE taskId = ?').run(taskId);
}
