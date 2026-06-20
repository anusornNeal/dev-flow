const IMPLEMENTATION_READY_STATUSES = new Set(['todo', 'in-progress', 'ready-for-review']);
const JIRA_DEPENDENCY_PATTERN = /\b(read|open|check|see|refer to|look at)\s+(the\s+)?(jira|attachment|comment|sourceurl|source url|spec link)\b/i;
const GENERIC_CHECKLIST_PATTERN = /^(read jira|understand task|fix bug|test|implement|check jira|open attachment)\.?$/i;

export interface TaskQualityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function isImplementationReadyTask(task: any) {
  return IMPLEMENTATION_READY_STATUSES.has(String(task?.status || 'backlog'));
}

function hasImplementationMap(repoContext: string) {
  return /implementation map\s*:/i.test(repoContext)
    && /file\s*:/i.test(repoContext)
    && /(class\/function|function|method|composable|route|mapper|helper)\s*:/i.test(repoContext)
    && /(current behavior|expected change|change)\s*:/i.test(repoContext);
}

function hasExternalDependencyText(task: any) {
  const checklistText = Array.isArray(task.checklist)
    ? task.checklist.map((item: any) => text(item?.text)).join('\n')
    : '';
  return [
    text(task.description),
    text(task.repoContext),
    text(task.reasoning),
    text(task.acceptanceCriteria),
    text(task.verification),
    checklistText,
  ].some((entry) => JIRA_DEPENDENCY_PATTERN.test(entry));
}

export function validateTaskQuality(task: any): TaskQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isImplementationReadyTask(task)) {
    return { ok: true, errors, warnings };
  }

  const repoContext = text(task.repoContext);
  if (!hasImplementationMap(repoContext)) {
    errors.push('Implementation-ready cards must include an Implementation map in repoContext with File, Class/function, Current behavior, and Expected change entries.');
  }

  if (!Array.isArray(task.targetFiles) || task.targetFiles.filter((entry: unknown) => text(entry)).length === 0) {
    errors.push('Implementation-ready cards must include focused targetFiles.');
  }

  if (hasExternalDependencyText(task)) {
    errors.push('Implementation-ready cards must not depend on Jira, attachments, comments, sourceUrl, or external specs for required details.');
  }

  if (Array.isArray(task.checklist)) {
    const genericItems = task.checklist
      .map((item: any) => text(item?.text))
      .filter((entry: string) => GENERIC_CHECKLIST_PATTERN.test(entry));
    if (genericItems.length > 0) {
      errors.push(`Checklist items must be concrete implementation steps, not generic placeholders: ${genericItems.join(', ')}`);
    }
  }

  if (!text(task.acceptanceCriteria)) {
    warnings.push('Acceptance criteria should be filled before assigning implementation work.');
  }
  if (!text(task.verification)) {
    warnings.push('Verification should name targeted tests, build commands, or manual checks.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function validateTaskQualityForMutation(task: any): string | null {
  const result = validateTaskQuality(task);
  return result.ok ? null : result.errors.join(' ');
}
