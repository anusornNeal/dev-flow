const fs = require('fs');
const c = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const lines = c.split('\n');

console.log('=== GET /api/tasks (lines 705-715) ===');
for (let i = 704; i < 716; i++) {
  if (i < lines.length) console.log((i + 1) + ': ' + lines[i]);
}

console.log('\n=== triggerTaskAgent (lines 474-480) ===');
for (let i = 473; i < 481; i++) {
  if (i < lines.length) console.log((i + 1) + ': ' + lines[i]);
}

// Check cleanupStaleActiveRuns function definition
console.log('\n=== cleanupStaleActiveRuns function ===');
for (let i = 334; i < 345; i++) {
  if (i < lines.length) console.log((i + 1) + ': ' + lines[i]);
}