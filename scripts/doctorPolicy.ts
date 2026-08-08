export type DoctorCheckResult = {
  label: string;
  ok: boolean;
  detail: string;
  severity?: 'warning' | 'error';
};

export function doctorResultPrefix(result: DoctorCheckResult) {
  if (result.ok) return 'OK';
  return result.severity === 'warning' ? 'WARN' : 'FAIL';
}

export function doctorHasFailure(results: DoctorCheckResult[]) {
  return results.some((result) => !result.ok && result.severity !== 'warning');
}
