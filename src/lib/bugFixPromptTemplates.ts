import type { BugThread, Task } from '../types';

export type BugFixPromptVariant = 'standard' | 'minimal' | 'deep-dive' | 'test-first' | 'review-reply';

export const BUG_FIX_PROMPT_VARIANTS: Array<{ id: BugFixPromptVariant; label: string }> = [
  { id: 'standard', label: 'Standard' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'deep-dive', label: 'Deep Dive' },
  { id: 'test-first', label: 'Test First' },
  { id: 'review-reply', label: 'Review Reply' },
];

function latestVersion(bug: BugThread) {
  return bug.versions[bug.versions.length - 1] || null;
}

function baseContext(task: Pick<Task, 'id' | 'displayId' | 'title' | 'status' | 'branch'>, bug: BugThread) {
  const version = latestVersion(bug);
  return [
    `Task: ${task.displayId || task.id} - ${task.title}`,
    `Task status: ${task.status}`,
    task.branch ? `Branch: ${task.branch}` : '',
    `Bug: ${bug.title}`,
    `Bug status: ${bug.status}`,
    `Severity: ${bug.severity}`,
    bug.actual ? `Actual: ${bug.actual}` : '',
    bug.expected ? `Expected: ${bug.expected}` : '',
    bug.evidence ? `Evidence: ${bug.evidence}` : '',
    bug.relatedAreas?.length ? `Related areas: ${bug.relatedAreas.join(', ')}` : '',
    version?.summary ? `Latest attempt summary: ${version.summary}` : '',
    version?.changedFiles?.length ? `Latest changed files: ${version.changedFiles.join(', ')}` : '',
    version?.prompt ? `Previous prompt: ${version.prompt}` : '',
  ].filter(Boolean).join('\n');
}

export function buildBugFixPrompt(
  task: Pick<Task, 'id' | 'displayId' | 'title' | 'status' | 'branch'>,
  bug: BugThread,
  variant: BugFixPromptVariant = 'standard',
) {
  const context = baseContext(task, bug);
  const sharedRules = [
    'Keep the bug embedded in the existing task. Do not create a top-level task for it.',
    'If the same behavior fails again, append a new bug version. If the scope differs, create a new bug thread.',
    'Report changed files, verification run, and remaining risk.',
  ].join('\n');

  if (variant === 'minimal') {
    return `Fix this DevFlow in-task bug with the smallest safe change.\n\n${context}\n\n${sharedRules}`;
  }
  if (variant === 'deep-dive') {
    return `Investigate and fix this DevFlow in-task bug. Start by identifying the failing behavior, likely root cause, and the smallest code path that owns it.\n\n${context}\n\n${sharedRules}`;
  }
  if (variant === 'test-first') {
    return `Use TDD to fix this DevFlow in-task bug. Add or update the smallest failing regression test first, watch it fail, implement the fix, then rerun the targeted verification.\n\n${context}\n\n${sharedRules}`;
  }
  if (variant === 'review-reply') {
    return `Address this reviewer/user follow-up as an in-task bug fix. Preserve existing behavior outside the reported issue and prepare a concise response explaining the fix.\n\n${context}\n\n${sharedRules}`;
  }
  return `Fix this DevFlow in-task bug thread.\n\n${context}\n\n${sharedRules}`;
}
