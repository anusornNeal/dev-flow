import type { EditState } from '../../viewModels/drawerUtils.js';

export interface AgentSectionProps {
  edit: EditState;
  onChange: <K extends keyof EditState>(field: K, value: EditState[K]) => void;
  readOnly?: boolean;
}

export function AgentSection({ edit, onChange, readOnly }: AgentSectionProps) {
  return (
    <section data-section="agent" aria-label="Agent Configuration">
      <select
        value={(edit as any).agent || ''}
        onChange={(e) => onChange('agent' as any, e.target.value as any)}
        disabled={readOnly}
        aria-label="Agent"
      >
        <option value="">Select agent</option>
        <option value="Codex">Codex</option>
        <option value="Antigravity">Antigravity</option>
        <option value="Claude">Claude</option>
      </select>
      <input
        type="text"
        value={(edit as any).model || ''}
        onChange={(e) => onChange('model' as any, e.target.value as any)}
        disabled={readOnly}
        aria-label="Model"
        placeholder="model-id"
      />
      <select
        value={(edit as any).effort || ''}
        onChange={(e) => onChange('effort' as any, e.target.value as any)}
        disabled={readOnly}
        aria-label="Effort"
      >
        <option value="">Select effort</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">XHigh</option>
        <option value="max">Max</option>
      </select>
    </section>
  );
}
