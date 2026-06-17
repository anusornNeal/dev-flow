import { useMemo } from 'react';
import { useProjectViewModel } from '../../viewModels/useProjectViewModel.js';
import { useBoardViewModel } from '../../viewModels/useBoardViewModel.js';
import { composeLayoutSlots, type AppLayoutSlots } from './appShellLayout.js';

export interface AppShellProps {
  renderHeader: (vm: { activeProjectId: string | null; projectsCount: number }) => React.ReactNode;
  renderSidebar: (vm: { projects: Array<{ id: string; name: string }> }) => React.ReactNode;
  renderBoard: (vm: ReturnType<typeof useBoardViewModel>) => React.ReactNode;
  renderDrawer: (props: { taskId: string | null }) => React.ReactNode;
}

export function AppShell({ renderHeader, renderSidebar, renderBoard, renderDrawer }: AppShellProps) {
  const projectsVm = useProjectViewModel();
  const boardVm = useBoardViewModel({ projectId: projectsVm.activeProjectId });

  const slots = useMemo<AppLayoutSlots>(
    () => ({
      header: 'header',
      sidebar: 'sidebar',
      board: 'board',
      drawer: 'drawer',
    }),
    [],
  );

  composeLayoutSlots(slots);

  return (
    <div className="app-shell" data-testid="app-shell">
      <header className="app-shell__header">
        {renderHeader({ activeProjectId: projectsVm.activeProjectId, projectsCount: projectsVm.projects.length })}
      </header>
      <aside className="app-shell__sidebar">{renderSidebar({ projects: projectsVm.projects })}</aside>
      <main className="app-shell__board">{renderBoard(boardVm)}</main>
      <div className="app-shell__drawer">
        {renderDrawer({ taskId: boardVm.tasks[0]?.id ?? null })}
      </div>
    </div>
  );
}
