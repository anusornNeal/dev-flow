import type { EditState } from '../../viewModels/drawerUtils.js';

export interface HeaderSectionProps {
  edit: EditState;
  onChange: <K extends keyof EditState>(field: K, value: EditState[K]) => void;
  readOnly?: boolean;
}

export function HeaderSection({ edit, onChange, readOnly }: HeaderSectionProps) {
  return (
    <section data-section="header" aria-label="Header">
      <input
        type="text"
        value={edit.title}
        onChange={(e) => onChange('title', e.target.value)}
        disabled={readOnly}
        aria-label="Title"
      />
      <select
        value={edit.status}
        onChange={(e) => onChange('status', e.target.value)}
        disabled={readOnly}
        aria-label="Status"
      >
        <option value="backlog">Backlog</option>
        <option value="todo">Todo</option>
        <option value="in-progress">In Progress</option>
        <option value="ready-for-review">Ready for Review</option>
        <option value="done">Done</option>
      </select>
      <select
        value={edit.priority}
        onChange={(e) => onChange('priority', e.target.value)}
        disabled={readOnly}
        aria-label="Priority"
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <input
        type="text"
        value={edit.branch}
        onChange={(e) => onChange('branch', e.target.value)}
        disabled={readOnly}
        aria-label="Branch"
        placeholder="branch-name"
      />
    </section>
  );
}
