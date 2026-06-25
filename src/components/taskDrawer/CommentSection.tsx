import type { EditState } from '../../viewModels/drawerUtils.js';

export interface CommentSectionProps {
  edit: EditState;
  onChange: <K extends keyof EditState>(field: K, value: EditState[K]) => void;
  readOnly?: boolean;
}

export function CommentSection({ edit, onChange, readOnly }: CommentSectionProps) {
  return (
    <section data-section="comment" aria-label="Comments">
      <textarea
        value={edit.reasoning}
        onChange={(e) => onChange('reasoning', e.target.value)}
        disabled={readOnly}
        aria-label="Reasoning"
        placeholder="Reasoning / notes"
      />
    </section>
  );
}
