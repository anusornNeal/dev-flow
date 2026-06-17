import type { EditState } from '../../viewModels/drawerUtils.js';
import type { DomainImage } from '../../domain/mappers/taskMapper.js';

export interface ImageSectionProps {
  edit: EditState;
  images: DomainImage[];
  readOnly?: boolean;
}

export function ImageSection({ images, readOnly }: ImageSectionProps) {
  return (
    <section data-section="image" aria-label="Images & Attachments">
      <ul>
        {images.map((img, idx) => (
          <li key={idx}>
            {img.url ? <span>url: {img.url}</span> : null}
            {img.absolutePath ? <span>path: {img.absolutePath}</span> : null}
            {img.legacy ? <em> (legacy)</em> : null}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <p className="hint">Use upload/paste controls in the drawer to add images.</p>
      )}
    </section>
  );
}
