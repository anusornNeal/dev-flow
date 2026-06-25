export type DrawerSectionKey = 'header' | 'agent' | 'checklist' | 'image' | 'comment' | 'runHistory';

export interface DrawerSection {
  key: DrawerSectionKey;
  id: DrawerSectionKey;
  label: string;
}

export const drawerSections: DrawerSection[] = [
  { key: 'header', id: 'header', label: 'Header' },
  { key: 'agent', id: 'agent', label: 'Agent Configuration' },
  { key: 'checklist', id: 'checklist', label: 'Implementation Checklist' },
  { key: 'image', id: 'image', label: 'Images & Attachments' },
  { key: 'comment', id: 'comment', label: 'Comments' },
  { key: 'runHistory', id: 'runHistory', label: 'Run History' },
];
