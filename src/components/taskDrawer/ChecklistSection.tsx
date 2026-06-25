import type { EditState } from '../../viewModels/drawerUtils.js';

export interface ChecklistSectionProps {
  edit: EditState;
  onToggle: (id: string) => void;
  onChange: <K extends keyof EditState>(field: K, value: EditState[K]) => void;
  readOnly?: boolean;
}

export function ChecklistSection({ edit, onToggle, onChange, readOnly }: ChecklistSectionProps) {
  return (
    <section data-section="checklist" aria-label="Implementation Checklist">
      <ul>
        {edit.checklist.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={item.completed}
                disabled={readOnly}
                onChange={() => onToggle(item.id)}
              />
              <span>{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
      {!readOnly && (
        <button
          type="button"
          onClick={() =>
            onChange('checklist', [
              ...edit.checklist,
              { id: `c-${Date.now()}`, text: 'New step', completed: false },
            ])
          }
        >
          Add step
        </button>
      )}
    </section>
  );
}
