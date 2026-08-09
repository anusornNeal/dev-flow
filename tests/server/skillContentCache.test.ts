import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-skill-cache-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
process.env.DEVFLOW_APP_ROOT = tempDir;
fs.mkdirSync(path.join(tempDir, 'skills'), { recursive: true });

const { clearSkillFileCache, readSkillContent } = await import('../../src/server/repositories/skillsRepository.js');
const { invalidateRepoCacheDependencies } = await import('../../src/server/services/repoCacheInvalidationService.js');

test('readSkillContent reads master skill content from its source file when registry content is empty', () => {
  const skillPath = path.join(tempDir, 'skills', 'cached-skill.md');
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

test('skills dependency invalidation clears a warm skill file cache before the next read', () => {
  clearSkillFileCache();
  const skillPath = path.join(tempDir, 'skills', 'stale-skill.md');
  fs.writeFileSync(skillPath, '# Before\n', 'utf8');
  const skill = { id: 'stale-skill', isCustom: false, content: '' };

  assert.equal(readSkillContent(skill), '# Before\n');
  fs.writeFileSync(skillPath, '# After!\n', 'utf8');

  const invalidation = invalidateRepoCacheDependencies({ reason: 'skill-write', dependencies: ['skills'] });
  const skillsDomain = invalidation.invalidated.find((entry: any) => entry.name === 'skills');
  assert.equal(skillsDomain?.count, 1);
  assert.equal(readSkillContent(skill), '# After!\n');
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
