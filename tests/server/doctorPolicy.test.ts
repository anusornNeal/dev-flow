import test from 'node:test';
import assert from 'node:assert/strict';
import { doctorHasFailure, doctorResultPrefix, type DoctorCheckResult } from '../../scripts/doctorPolicy.js';

test('doctor advisory warnings remain visible without failing the command', () => {
  const results: DoctorCheckResult[] = [
    { label: 'Node.js', ok: true, detail: 'ok' },
    { label: 'Legacy JSON files', ok: false, severity: 'warning', detail: 'migration recommended' },
  ];

  assert.equal(doctorResultPrefix(results[1]), 'WARN');
  assert.equal(doctorHasFailure(results), false);
});

test('doctor hard health failures remain non-zero failures', () => {
  const results: DoctorCheckResult[] = [
    { label: 'Required SQLite tables', ok: false, detail: 'missing tasks' },
  ];

  assert.equal(doctorResultPrefix(results[0]), 'FAIL');
  assert.equal(doctorHasFailure(results), true);
});
