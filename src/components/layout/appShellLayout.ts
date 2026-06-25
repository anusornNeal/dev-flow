export interface AppLayoutSlots {
  header: string;
  sidebar: string;
  board: string;
  drawer: string;
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
