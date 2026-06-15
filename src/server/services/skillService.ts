import type { AppState } from '../types';
import { readSkillContent } from '../repositories/skillsRepository';

export function getSkillById(state: AppState, skillId: string) {
  return state.skillsRegistry.find((skill) => skill.id === skillId);
}

export function getSkillDetail(state: AppState, skillId: string) {
  const skill = getSkillById(state, skillId);
  if (!skill) return null;
  return { ...skill, content: readSkillContent(skill) };
}

export function updateSkillContent(skill: any, body: any) {
  skill.content = body.content || '';
  if (body.name) skill.name = body.name;
  if (body.description) skill.description = body.description;
}
