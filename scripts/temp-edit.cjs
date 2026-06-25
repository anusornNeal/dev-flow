const fs = require('fs');
const c = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const lines = c.split('\n');
const EOL = '\r\n';

// Find cleanupStaleActiveRuns function in the lines
let funcStart = -1;
let funcEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === 'function cleanupStaleActiveRuns(deps: ApiRouteDeps) {' && lines[i].includes('function')) {
    funcStart = i;
  }
  if (funcStart >= 0 && lines[i].trim() === '}' && i > funcStart && funcEnd < 0) {
    funcEnd = i;
    break;
  }
}
console.log('Function lines:', funcStart, '-', funcEnd);

if (funcStart >= 0 && funcEnd >= 0) {
  // Get the exact old function text (preserving \r at end of lines)
  const oldFuncLines = lines.slice(funcStart, funcEnd + 1);
  const oldFunc = oldFuncLines.join('\n');
  console.log('Old func line count:', oldFuncLines.length);
  
  // Build new function
  const newFuncLines = [
    'function cleanupStaleActiveRuns(deps: ApiRouteDeps) {',
    '  const cutoff = new Date(Date.now() - STALE_AGENT_RUN_MS).toISOString();',
    '  const cancelledCount = cancelStaleActiveRuns(cutoff, `Stale active run cancelled after ${STALE_AGENT_RUN_MS / 60000} minutes.`);',
    '  if (cancelledCount > 0) {',
    '    deps.writeAgentLog(\'INFO\', `Cancelled ${cancelledCount} stale active agent run(s).`);',
    '    // Batch-load all agent runs to avoid N+1 loop',
    '    const allRuns = db.prepare(\'SELECT * FROM agent_runs ORDER BY createdAt DESC\').all() as AgentRun[];',
    '    const runsByTaskId = new Map<string, AgentRun[]>();',
    '    for (const run of allRuns) {',
    '      const existing = runsByTaskId.get(run.taskId);',
    '      if (existing) { existing.push(run); }',
    '      else { runsByTaskId.set(run.taskId, [run]); }',
    '    }',
    '    for (const task of deps.state.tasksCache) {',
    '      const taskRuns = runsByTaskId.get(task.id) || [];',
    '      const activeRun = taskRuns.find(r => ACTIVE_AGENT_RUN_STATUSES.includes(r.status as any)) || null;',
    '      const latestRun = taskRuns[0] || null;',
    '      task.activeAgent = activeRun?.agent || undefined;',
    '      task.latestAgentRun = latestRun ? {',
    '        id: latestRun.id,',
    '        status: latestRun.status,',
    '        agent: latestRun.agent,',
    '        errorMessage: latestRun.errorMessage,',
    '        createdAt: latestRun.createdAt,',
    '        startedAt: latestRun.startedAt,',
    '        endedAt: latestRun.endedAt,',
    '      } : undefined;',
    '      task.agentRuns = taskRuns.map((r) => ({ id: r.id, status: r.status, logFile: r.logPath }));',
    '    }',
    '    saveTasks(deps.state);',
    '  }',
    '}',
  ];
  
  // Match line endings of original (preserve \r on lines that end with \r)
  const newFunc = newFuncLines.map((line, i) => {
    const origLine = oldFuncLines[i] || '';
    if (origLine.endsWith('\r')) return line + '\r';
    return line;
  }).join('\n');
  
  // Replace in content
  const newContent = c.replace(oldFunc, newFunc);
  
  if (newContent !== c) {
    fs.writeFileSync('src/server/routes/tasks.ts', newContent, 'utf8');
    console.log('SUCCESS: cleanupStaleActiveRuns N+1 fixed');
  } else {
    console.log('FAILED: Content unchanged');
    console.log('Old func preview:', oldFunc.substring(0, 100));
    console.log('New func preview:', newFunc.substring(0, 100));
  }
} else {
  console.log('FAILED: Function not found');
}

// Check the db import was added
const updatedC = fs.readFileSync('src/server/routes/tasks.ts', 'utf8');
const hasDbImport = updatedC.includes("from '../../db/index'");
console.log('Has db import:', hasDbImport);