import { UI_PREVIEW_STORAGE_V2_SCHEMA } from '../uiPreviewStorageV2Schema.js';
import type { Migration } from './runner.js';

export const uiPreviewObjectStorageMigration: Migration = {
  id: '017-ui-preview-object-storage',
  up: (db) => {
    db.exec(UI_PREVIEW_STORAGE_V2_SCHEMA);
  },
};
