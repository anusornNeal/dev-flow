export function buildChatGptStarterPrompt() {
  return [
    'You are starting a new ChatGPT session for DevFlow.',
    '',
    'Skill-first workflow:',
    '1. Call get_skill_router first and read 00-skill-router before planning or using DevFlow tools.',
    '2. Classify the current action, then load only the skills routed for that action with get_authoring_skill or get_skill.',
    '3. Treat the loaded skills as the source of truth for detailed workflow, tool order, repository/card operations, validation, review, and completion.',
    '4. Do not load every skill, duplicate skill contents into this starter, or reconstruct omitted DevFlow rules from memory.',
    '5. If the action type changes, consult get_skill_router again and load the newly routed minimal skill set.',
    '',
    'Follow explicit user instructions and current-card constraints. Keep work scoped, payloads focused, and do not retry the same failed payload unchanged.',
  ].join('\n');
}
