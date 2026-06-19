import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-skill-cache-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { readSkillContent } = await import('../../src/server/repositories/skillsRepository.js');

test('readSkillContent reads master skill content from its source file when registry content is empty', () => {
  const skillPath = path.join(tempDir, 'skill.md');
  fs.writeFileSync(skillPath, '# Cached Skill\n', 'utf8');

  const content = readSkillContent({
    id: 'cached-skill',
    isCustom: false,
    sourcePath: skillPath,
    filePath: skillPath,
    content: '',
  });

  assert.equal(content, '# Cached Skill\n');
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
