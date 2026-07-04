import { useEffect, type RefObject } from 'react';

export function useDismissOnOutsidePointer<T extends HTMLElement>(
  ref: RefObject<T | null>,
  enabled: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target)) return;
      onDismiss();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [enabled, onDismiss, ref]);
}
