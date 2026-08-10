import type { Migration } from './runner.js';

function hasColumn(db: any, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === column);
}

export const mcpToolJobVerificationLifecycleMigration: Migration = {
  id: '015-mcp-tool-job-verification-lifecycle',
  up: (db) => {
    const columns: Array<[string, string]> = [
      ['verification_series_key', 'TEXT'],
      ['verification_candidate_key', 'TEXT'],
      ['verification_generation', 'INTEGER'],
      ['verification_evidence_intent', 'TEXT'],
      ['superseded_by_candidate_key', 'TEXT'],
      ['superseded_by_generation', 'INTEGER'],
      ['superseded_at', 'TEXT'],
    ];
    for (const [column, type] of columns) {
      if (!hasColumn(db, 'mcp_tool_jobs', column)) {
        db.exec(`ALTER TABLE mcp_tool_jobs ADD COLUMN ${column} ${type};`);
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_jobs_verification_series_generation
        ON mcp_tool_jobs(verification_series_key, verification_generation);
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_jobs_superseded_status
        ON mcp_tool_jobs(superseded_at, status);
    `);
  },
};
