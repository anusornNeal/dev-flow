import fs from 'fs';
import path from 'path';
import { getDevFlowAppRoot } from '../../lib/devFlowPaths';

export interface ProjectRulesContext {
  title: string;
  workflow: string[];
}

const FALLBACK_PROJECT_RULES: ProjectRulesContext = {
  title: 'DevFlow Workflow Rules',
  workflow: [
    'Move todo cards to in-progress before implementation starts.',
    'Use the card branch. If the card has no branch, default to develop.',
    'Handle every checklist item or mini task.',
    'Do not silently skip checklist items. If an item is not applicable, report the reason.',
    'When implementation is complete, push the work to the active branch first.',
    'Push the work to the active branch before moving the card to ready-for-review.',
    'Do not move a card to ready-for-review before code is pushed.',
  ],
};

function normalizeRules(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  const rules = value
    .map((rule) => typeof rule === 'string' ? rule.trim() : '')
    .filter(Boolean);
  return rules.length > 0 ? rules : fallback;
}

export function getProjectRulesContext(baseDir = getDevFlowAppRoot()): ProjectRulesContext {
  const rulesPath = path.join(baseDir, 'config', 'project-rules.json');
  if (!fs.existsSync(rulesPath)) return FALLBACK_PROJECT_RULES;

  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    return {
      title: typeof parsed?.title === 'string' && parsed.title.trim()
        ? parsed.title.trim()
        : FALLBACK_PROJECT_RULES.title,
      workflow: normalizeRules(parsed?.workflow, FALLBACK_PROJECT_RULES.workflow),
    };
  } catch (error) {
    console.error('Error parsing project-rules.json', error);
    return FALLBACK_PROJECT_RULES;
  }
}
