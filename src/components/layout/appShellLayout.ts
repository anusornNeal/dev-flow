export interface AppLayoutSlots {
  header: string;
  sidebar: string;
  board: string;
  drawer: string;
}
export const SIDEBAR_RAIL_WIDTH = 64;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_NARROW_DESKTOP_WIDTH = 1100;
export const SIDEBAR_LAYOUT_STORAGE_KEY = 'devflow.sidebarLayout';

export interface SidebarLayoutState {
  collapsed: boolean;
  width: number;
}

export interface SidebarLayoutStorage {
  getItem(key: string): string | null;
}

export function clampSidebarWidth(width: number) {
  const finite = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(finite)));
}

export function resolveSidebarResize(startWidth: number, deltaX: number) {
  return clampSidebarWidth(startWidth + deltaX);
}

export function serializeSidebarLayoutPreference(state: SidebarLayoutState) {
  return JSON.stringify({ collapsed: state.collapsed === true, width: clampSidebarWidth(state.width) });
}

export function resolveInitialSidebarLayout(
  storage: SidebarLayoutStorage | null | undefined,
  viewportWidth: number,
): SidebarLayoutState {
  try {
    const raw = storage?.getItem(SIDEBAR_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.collapsed === 'boolean' && Number.isFinite(Number(parsed?.width))) {
        return { collapsed: parsed.collapsed, width: clampSidebarWidth(Number(parsed.width)) };
      }
    }
  } catch {
    // Invalid/unavailable preference storage falls back to viewport defaults.
  }
  return {
    collapsed: Number.isFinite(viewportWidth) && viewportWidth < SIDEBAR_NARROW_DESKTOP_WIDTH,
    width: SIDEBAR_DEFAULT_WIDTH,
  };
}

export const REQUIRED_SLOTS: ReadonlyArray<keyof AppLayoutSlots> = ['header', 'sidebar', 'board', 'drawer'];

export function composeLayoutSlots(slots: AppLayoutSlots): string[] {
  for (const key of REQUIRED_SLOTS) {
    if (slots[key] === undefined || slots[key] === null) {
      throw new Error(`AppShell missing required layout slot: ${key}`);
    }
  }
  return [slots.header, slots.sidebar, slots.board, slots.drawer];
}
