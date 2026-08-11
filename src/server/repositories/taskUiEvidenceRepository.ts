import db from '../../db/index.js';
import type { TaskUiEvidence, UiSpecV1 } from '../domain/uiPreview.js';

export type TaskUiEvidenceOutcome = 'inserted' | 'same-revision' | 'superseded' | 'stale';

type DatabaseLike = any;

function nowIso() {
  return new Date().toISOString();
}

function parseEvidence(row: any): TaskUiEvidence | null {
  if (!row) return null;
  return {
    evidenceId: row.evidence_id,
    taskId: row.task_id,
    previewId: row.preview_id,
    frozenRevision: Number(row.frozen_revision),
    frozenSpec: JSON.parse(row.frozen_spec_json),
    screenshotArtifactId: row.screenshot_artifact_id,
    screenshotWidth: Number(row.screenshot_width),
    screenshotHeight: Number(row.screenshot_height),
    screenshotSha256: row.screenshot_sha256 ?? null,
    isCurrent: Number(row.is_current) === 1,
    createdAt: row.created_at,
    supersededAt: row.superseded_at ?? null,
    supersededByEvidenceId: row.superseded_by_evidence_id ?? null,
  };
}

export interface RecordTaskUiEvidenceInput {
  evidenceId: string;
  taskId: string;
  previewId: string;
  frozenRevision: number;
  frozenSpec: UiSpecV1;
  screenshotArtifactId: string;
  screenshotWidth: number;
  screenshotHeight: number;
  screenshotSha256?: string | null;
  createdAt?: string;
}

export function createTaskUiEvidenceRepository(database: DatabaseLike = db) {
  function getCurrentEvidence(taskId: string, previewId: string) {
    return parseEvidence(database.prepare(`
      SELECT * FROM task_ui_evidence
      WHERE task_id = ? AND preview_id = ? AND is_current = 1
    `).get(taskId, previewId));
  }

  function listEvidence(taskId: string, previewId?: string) {
    const rows = previewId
      ? database.prepare(`
          SELECT * FROM task_ui_evidence
          WHERE task_id = ? AND preview_id = ?
          ORDER BY frozen_revision DESC, created_at DESC, evidence_id DESC
        `).all(taskId, previewId)
      : database.prepare(`
          SELECT * FROM task_ui_evidence
          WHERE task_id = ?
          ORDER BY created_at DESC, evidence_id DESC
        `).all(taskId);
    return (rows as any[]).map((row) => parseEvidence(row)!);
  }

  function recordEvidence(input: RecordTaskUiEvidenceInput): { outcome: TaskUiEvidenceOutcome; evidence: TaskUiEvidence } {
    const work = () => {
      const current = getCurrentEvidence(input.taskId, input.previewId);
      if (current) {
        if (current.frozenRevision > input.frozenRevision) return { outcome: 'stale' as const, evidence: current };
        if (current.frozenRevision === input.frozenRevision) return { outcome: 'same-revision' as const, evidence: current };
      }

      const sameRevision = parseEvidence(database.prepare(`
        SELECT * FROM task_ui_evidence
        WHERE task_id = ? AND preview_id = ? AND frozen_revision = ?
      `).get(input.taskId, input.previewId, input.frozenRevision));
      if (sameRevision) return { outcome: 'same-revision' as const, evidence: sameRevision };

      const createdAt = input.createdAt || nowIso();
      if (current) {
        database.prepare(`
          UPDATE task_ui_evidence
          SET is_current = 0, superseded_at = ?, superseded_by_evidence_id = ?
          WHERE evidence_id = ? AND is_current = 1
        `).run(createdAt, input.evidenceId, current.evidenceId);
      }

      database.prepare(`
        INSERT INTO task_ui_evidence (
          evidence_id, task_id, preview_id, frozen_revision, frozen_spec_json,
          screenshot_artifact_id, screenshot_width, screenshot_height, screenshot_sha256,
          is_current, created_at, superseded_at, superseded_by_evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL)
      `).run(
        input.evidenceId,
        input.taskId,
        input.previewId,
        input.frozenRevision,
        JSON.stringify(input.frozenSpec),
        input.screenshotArtifactId,
        input.screenshotWidth,
        input.screenshotHeight,
        input.screenshotSha256 ?? null,
        createdAt,
      );
      const inserted = parseEvidence(database.prepare('SELECT * FROM task_ui_evidence WHERE evidence_id = ?').get(input.evidenceId))!;
      return { outcome: current ? 'superseded' as const : 'inserted' as const, evidence: inserted };
    };

    const transaction = database.transaction(work);
    return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction();
  }

  return { recordEvidence, getCurrentEvidence, listEvidence };
}

export type TaskUiEvidenceRepository = ReturnType<typeof createTaskUiEvidenceRepository>;
