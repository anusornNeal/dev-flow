import db from '../../db/index.js';

export type PersistedVerificationResourceSample = {
  status: 'succeeded' | 'failed' | 'timed_out';
  durationMs: number;
  censoredLowerBoundMs?: number;
  cpuRatio?: number;
  memoryBytes?: number;
  processCount?: number;
  systemCpuRatio?: number;
  memoryPressureRatio?: number;
  treeAccounting?: boolean;
  recordedAt: number;
};

const MAX_SAMPLES_PER_PROFILE = 24;
const MAX_PROFILES = 256;

function optionalNumber(value: unknown) {
  if (value == null) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function loadVerificationResourceProfileSamples(profileKey: string): PersistedVerificationResourceSample[] {
  const rows = db.prepare(`
    SELECT status, duration_ms, censored_lower_bound_ms, cpu_ratio, memory_bytes, process_count,
           system_cpu_ratio, memory_pressure_ratio, tree_accounting, recorded_at
    FROM verification_resource_profile_samples
    WHERE profile_key = ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT ?
  `).all(profileKey, MAX_SAMPLES_PER_PROFILE) as any[];
  return rows.reverse().map((row) => ({
    status: row.status,
    durationMs: Number(row.duration_ms || 0),
    ...(optionalNumber(row.censored_lower_bound_ms) !== undefined ? { censoredLowerBoundMs: optionalNumber(row.censored_lower_bound_ms) } : {}),
    ...(optionalNumber(row.cpu_ratio) !== undefined ? { cpuRatio: optionalNumber(row.cpu_ratio) } : {}),
    ...(optionalNumber(row.memory_bytes) !== undefined ? { memoryBytes: optionalNumber(row.memory_bytes) } : {}),
    ...(optionalNumber(row.process_count) !== undefined ? { processCount: optionalNumber(row.process_count) } : {}),
    ...(optionalNumber(row.system_cpu_ratio) !== undefined ? { systemCpuRatio: optionalNumber(row.system_cpu_ratio) } : {}),
    ...(optionalNumber(row.memory_pressure_ratio) !== undefined ? { memoryPressureRatio: optionalNumber(row.memory_pressure_ratio) } : {}),
    ...(row.tree_accounting == null ? {} : { treeAccounting: Boolean(row.tree_accounting) }),
    recordedAt: Number(row.recorded_at || 0),
  }));
}

export function persistVerificationResourceProfileSample(
  profileKey: string,
  descriptor: unknown,
  sample: PersistedVerificationResourceSample,
) {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO verification_resource_profile_samples (
        profile_key, descriptor_json, status, duration_ms, censored_lower_bound_ms,
        cpu_ratio, memory_bytes, process_count, system_cpu_ratio, memory_pressure_ratio,
        tree_accounting, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileKey,
      JSON.stringify(descriptor),
      sample.status,
      Math.max(0, Math.round(sample.durationMs)),
      sample.censoredLowerBoundMs == null ? null : Math.max(0, Math.round(sample.censoredLowerBoundMs)),
      sample.cpuRatio ?? null,
      sample.memoryBytes == null ? null : Math.max(0, Math.round(sample.memoryBytes)),
      sample.processCount == null ? null : Math.max(0, Math.round(sample.processCount)),
      sample.systemCpuRatio ?? null,
      sample.memoryPressureRatio ?? null,
      sample.treeAccounting == null ? null : sample.treeAccounting ? 1 : 0,
      Math.max(0, Math.round(sample.recordedAt)),
    );

    db.prepare(`
      DELETE FROM verification_resource_profile_samples
      WHERE profile_key = ? AND id NOT IN (
        SELECT id FROM verification_resource_profile_samples
        WHERE profile_key = ?
        ORDER BY recorded_at DESC, id DESC
        LIMIT ?
      )
    `).run(profileKey, profileKey, MAX_SAMPLES_PER_PROFILE);

    const profileRows = db.prepare(`
      SELECT profile_key, MAX(recorded_at) AS updated_at
      FROM verification_resource_profile_samples
      GROUP BY profile_key
      ORDER BY updated_at DESC, profile_key DESC
    `).all() as Array<{ profile_key: string; updated_at: number }>;
    if (profileRows.length > MAX_PROFILES) {
      const deleteProfile = db.prepare('DELETE FROM verification_resource_profile_samples WHERE profile_key = ?');
      for (const row of profileRows.slice(MAX_PROFILES)) deleteProfile.run(row.profile_key);
    }
  })();
}

export function clearVerificationResourceProfileSamplesForTests() {
  db.prepare('DELETE FROM verification_resource_profile_samples').run();
}

export function getVerificationResourceProfilePersistenceLimits() {
  return { maxProfiles: MAX_PROFILES, maxSamplesPerProfile: MAX_SAMPLES_PER_PROFILE };
}
