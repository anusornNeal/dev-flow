import type { BugThread, ChecklistItem, Task } from '../types';

const UNRESOLVED = new Set(['open', 'fixing', 'fixed', 'reopened']);

function isUnresolved(bug: BugThread) {
  return UNRESOLVED.has(bug.status);
}

function latestVersionTime(bug: BugThread) {
  const latest = bug.versions[bug.versions.length - 1];
  return new Date(latest?.createdAt || bug.updatedAt || bug.createdAt || 0).getTime();
}

export function orderBugThreadsForExport(bugs: BugThread[] = []) {
  return bugs.slice().sort((left, right) => {
    const leftUnresolved = isUnresolved(left);
    const rightUnresolved = isUnresolved(right);
    if (leftUnresolved !== rightUnresolved) return leftUnresolved ? -1 : 1;
    return latestVersionTime(right) - latestVersionTime(left);
  });
}

export function buildTaskBugSummaryJson(task: Pick<Task, 'id' | 'displayId' | 'title' | 'status' | 'checklist' | 'bugs'>) {
  const bugThreads = orderBugThreadsForExport(task.bugs || []);
  const unresolved = bugThreads.filter(isUnresolved);
  const checklist = Array.isArray(task.checklist) ? task.checklist : [];
  return {
    task: {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      status: task.status,
    },
    miniTaskProgress: {
      completed: checklist.filter((item: ChecklistItem) => item.completed).length,
      total: checklist.length,
      unfinished: checklist.filter((item: ChecklistItem) => !item.completed).map((item) => item.text),
    },
    unresolvedBugCount: unresolved.length,
    latestUnresolvedBug: unresolved[0] ? {
      id: unresolved[0].id,
      title: unresolved[0].title,
      status: unresolved[0].status,
      severity: unresolved[0].severity,
    } : null,
    bugThreads,
  };
}

export function renderTaskBugSummaryMarkdown(task: Pick<Task, 'id' | 'displayId' | 'title' | 'status' | 'checklist' | 'bugs'>) {
  const summary = buildTaskBugSummaryJson(task);
  const lines = [
    `# Bug Summary: ${task.displayId || task.id}`,
    '',
    `Task: ${task.title}`,
    `Status: ${task.status}`,
    `Mini tasks: ${summary.miniTaskProgress.completed}/${summary.miniTaskProgress.total}`,
    `Open bug count: ${summary.unresolvedBugCount}`,
    '',
  ];

  for (const bug of summary.bugThreads) {
    lines.push(`## ${isUnresolved(bug) ? 'Open' : 'History'}: ${bug.title}`);
    lines.push(`- Status: ${bug.status}`);
    lines.push(`- Source: ${bug.source}`);
    lines.push(`- Severity: ${bug.severity}`);
    if (bug.actual) lines.push(`- Actual: ${bug.actual}`);
    if (bug.expected) lines.push(`- Expected: ${bug.expected}`);
    if (bug.evidence) lines.push(`- Evidence: ${bug.evidence}`);
    if (bug.relatedAreas?.length) lines.push(`- Related areas: ${bug.relatedAreas.join(', ')}`);
    lines.push('- Versions:');
    for (const version of bug.versions) {
      lines.push(`  - v${version.version} [${version.status}] ${version.summary || ''}`.trimEnd());
      lines.push(`    Prompt: ${version.prompt}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
