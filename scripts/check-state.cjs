const fs = require('fs');
const c = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const lines = c.split('\n');
console.log('Total lines:', lines.length);

// Check for any stray import from db
console.log('\ndb imports:');
lines.filter(l => l.includes('db/index')).forEach(l => console.log(l.trim()));

// Check final saveTasks count
console.log('\nsaveTasks calls:');
lines.filter(l => l.includes('saveTasks(deps.state)')).forEach(l => console.log(l.trim()));

// Check cleanup count (excluding function def)
console.log('\ncleanupStaleActiveRuns calls (non-def):');
lines.filter(l => l.includes('cleanupStaleActiveRuns') && !l.includes('function cleanupStaleActiveRuns')).forEach(l => console.log(l.trim()));

// Check loadTasks - should be 0
console.log('\nloadTasks calls:');
lines.filter(l => l.includes('loadTasks(deps.state)')).forEach(l => console.log(l.trim()));

// Check throttle var
console.log('\nthrottle variables:');
lines.filter(l => l.includes('lastCleanupCheck') || l.includes('CLEANUP_INTERVAL')).forEach(l => console.log(l.trim()));