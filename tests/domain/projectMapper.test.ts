import test from 'node:test';
import assert from 'node:assert/strict';
import { toDomainProject, toDtoProject } from '../../src/domain/mappers/projectMapper.js';

test('toDomainProject preserves all known project fields', () => {
  const dto = {
    id: 'p-1',
    name: 'dev-flow',
    repoUrl: 'https://github.com/x/y',
    description: 'local dev board',
    localPath: 'C:/work/dev-flow',
    taskIdPrefix: 'DVF',
  };
  const domain = toDomainProject(dto as any);
  assert.equal(domain.id, 'p-1');
  assert.equal(domain.name, 'dev-flow');
  assert.equal(domain.repoUrl, 'https://github.com/x/y');
  assert.equal(domain.localPath, 'C:/work/dev-flow');
  assert.equal(domain.taskIdPrefix, 'DVF');
});

test('toDomainProject tolerates missing optional fields', () => {
  const domain = toDomainProject({ id: 'p-2', name: 'x' } as any);
  assert.equal(domain.id, 'p-2');
  assert.equal(domain.name, 'x');
  assert.equal(domain.repoUrl, undefined);
});

test('toDtoProject round-trips domain object', () => {
  const domain = { id: 'p-3', name: 'y', repoUrl: 'r', description: 'd', localPath: 'L', taskIdPrefix: 'P' };
  const dto = toDtoProject(domain as any);
  assert.deepEqual(dto, domain);
});
