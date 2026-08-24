export type QualityDebtEntry = {
  code: string;
  message: string;
  details?: unknown;
  source?: string;
};

export type TaskQualityDebtSummary = {
  status: 'clear' | 'debt';
  count: number;
  codes: string[];
  entries: QualityDebtEntry[];
};

export function summarizeQualityDebt(entries: QualityDebtEntry[] = []): TaskQualityDebtSummary {
  const normalized = entries.map((entry) => ({ ...entry }));
  return {
    status: normalized.length > 0 ? 'debt' : 'clear',
    count: normalized.length,
    codes: [...new Set(normalized.map((entry) => entry.code))],
    entries: normalized,
  };
}
