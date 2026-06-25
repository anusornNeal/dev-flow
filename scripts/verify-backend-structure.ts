import fs from 'fs';
import path from 'path';

const projectRoot = process.cwd();

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function fileExists(relativePath: string) {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

const requiredFiles = [
  'src/server/routes/registerApiRoutes.ts',
  'src/server/routes/tasks.ts',
  'src/server/routes/projects.ts',
  'src/server/routes/skills.ts',
  'src/server/routes/settings.ts',
  'src/server/services/taskService.ts',
  'src/server/services/skillService.ts',
  'src/server/repositories/taskRepository.ts',
  'src/server/repositories/projectRepository.ts',
  'src/server/repositories/skillsRepository.ts',
  'src/server/repositories/settingsRepository.ts',
];

for (const file of requiredFiles) {
  assert(fileExists(file), `Missing expected backend module: ${file}`);
}

const serverSource = fs.readFileSync(path.join(projectRoot, 'server.ts'), 'utf8');

assert(
  serverSource.includes("registerApiRoutes(app"),
  'server.ts must delegate API route wiring to registerApiRoutes(app, ...).',
);

const inlineApiPatterns = [
  "app.get('/api/skills'",
  "app.get('/api/projects'",
  "app.post('/api/tasks'",
  "app.put('/api/tasks/:id'",
  "app.post('/api/settings'",
];

for (const pattern of inlineApiPatterns) {
  assert(
    !serverSource.includes(pattern),
    `server.ts still contains inline API route definition: ${pattern}`,
  );
}

console.log('backend structure verification passed');
