const fs = require('fs');
const c = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const lines = c.split('\n');
console.log('Total lines:', lines.length);
for (const l of lines) {
  if (l.includes('import')) console.log(l);
}