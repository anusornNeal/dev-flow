const fs = require('fs');
const c = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const lines = c.split('\n');

// Show context around each remaining saveTasks
const saveTasksLines = [];
lines.forEach((l, i) => { if (l.includes('saveTasks(deps.state)')) saveTasksLines.push(i); });
for (const i of saveTasksLines) {
  const start = Math.max(0, i - 3);
  const end = Math.min(lines.length, i + 3);
  console.log('--- Line ' + (i + 1) + ' ---');
  for (let j = start; j < end; j++) console.log(lines[j]);
}