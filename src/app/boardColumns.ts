import type { Column } from '../types';

export const BOARD_COLUMNS: Column[] = [
  { id: 'backlog', label: 'Backlog Specs', iconName: 'Moon', color: 'border-[#dfd2be]/60 dark:border-[#584a3b]/60 bg-[#fffdfa] dark:bg-[#292119] text-[#816b5a] dark:text-[#f3eadf]' },
  { id: 'todo', label: 'Ready to Do', iconName: 'ListTodo', color: 'border-[#dfd2be]/60 dark:border-[#584a3b]/60 bg-[#fffdfa] dark:bg-[#292119] text-[#816b5a] dark:text-[#f3eadf]' },
  { id: 'in-progress', label: 'In Progress', iconName: 'Terminal', color: 'border-[#f5cb93] dark:border-[#584a3b] bg-[#fffbf4] dark:bg-[#292119] text-[#935919] dark:text-[#e0a070]' },
  { id: 'ready-for-review', label: 'Ready for Review', iconName: 'GitMerge', color: 'border-[#b8cdfc] dark:border-[#584a3b] bg-[#f5f8ff] dark:bg-[#292119] text-[#3b5eab] dark:text-[#f3eadf]' },
  { id: 'done', label: 'Completed', iconName: 'GitPullRequest', color: 'border-[#bddda4] dark:border-[#584a3b] bg-[#edf7ed] dark:bg-[#292119] text-[#4d7e35] dark:text-[#f3eadf]' },
];
