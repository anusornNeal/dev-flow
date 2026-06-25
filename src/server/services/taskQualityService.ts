const IMPLEMENTATION_READY_STATUSES = new Set(['todo', 'in-progress', 'ready-for-review']);
const JIRA_DEPENDENCY_PATTERN = /\b(read|open|check|see|refer to|look at)\s+(the\s+)?(jira|attachment|comment|sourceurl|source url|spec link)\b/i;
const GENERIC_CHECKLIST_PATTERN = /^(read jira|understand task|fix bug|test|implement|check jira|open attachment)\.?$/i;
const TODO_EXECUTION_INTENT_PATTERN = /\b(explicitly asked|user asked|user requested|queue|queued|start|started|execute|execution|ready for execution|move(?:d)?\s+(?:this\s+)?(?:card|task|work)?\s*(?:to\s+)?todo|assigned for implementation|begin implementation|run agent|send to codex|send to antigravity|send to claude)\b/i;
const FRONTEND_HINT_PATTERN = /\b(frontend|ui|screen|compose|fragment|activity|viewmodel|navigation|route|layout|copy)\b/i;
const BACKEND_HINT_PATTERN = /\b(backend|api|dto|model|mapper|repository|persistence|database|schema|cache|contract|service)\b/i;
const PLANNED_CHILD_PATTERN = /\b(parent\/child|child card|child cards|subtask|subtasks|child breakdown|child boundaries)\b/i;

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

function joinedTaskText(task: any) {
  const checklistText = Array.isArray(task.checklist)
    ? task.checklist.map((item: any) => text(item?.text)).join('\n')
    : '';
  const targetFilesText = Array.isArray(task.targetFiles)
    ? task.targetFiles.map((entry: unknown) => text(entry)).join('\n')
    : '';
  const tagsText = Array.isArray(task.tags)
    ? task.tags.map((entry: unknown) => text(entry)).join('\n')
    : '';
  return [
    text(task.title),
    text(task.description),
    text(task.repoContext),
    text(task.reasoning),
    text(task.acceptanceCriteria),
    text(task.verification),
    text(task.category),
    checklistText,
    targetFilesText,
    tagsText,
  ].filter(Boolean).join('\n');
}

function hasExplicitTodoIntent(task: any) {
  return TODO_EXECUTION_INTENT_PATTERN.test([text(task.reasoning), text(task.description)].filter(Boolean).join('\n'));
}

function shouldSuggestChildCards(task: any) {
  const joined = joinedTaskText(task);
  const targetFileCount = Array.isArray(task.targetFiles) ? task.targetFiles.filter((entry: unknown) => text(entry)).length : 0;
  const checklistCount = Array.isArray(task.checklist) ? task.checklist.length : 0;
  const hasFrontendAndBackend = FRONTEND_HINT_PATTERN.test(joined) && BACKEND_HINT_PATTERN.test(joined);
  const likelyLargeChecklist = checklistCount >= 7;
  const likelyManyFiles = targetFileCount >= 6;
  const alreadyChild = text(task.parentId).length > 0;
  const alreadyPlansChildren = PLANNED_CHILD_PATTERN.test(joined);
  return !alreadyChild && !alreadyPlansChildren && (hasFrontendAndBackend || likelyLargeChecklist || likelyManyFiles);
}

export function validateTaskQuality(task: any): TaskQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (shouldSuggestChildCards(task)) {
    warnings.push('This looks like multi-slice work. Prefer a backlog parent card plus focused child/subtask cards instead of one large card or a long checklist.');
  }

  if (!isImplementationReadyTask(task)) {
    return { ok: true, errors, warnings };
  }

  if (String(task?.status || 'backlog') === 'todo' && !hasExplicitTodoIntent(task)) {
    errors.push('Cards must default to backlog. Use status todo only when reasoning or description states the user explicitly asked to queue/start/execute the work.');
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
