const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalBackgroundState {
  modal: HTMLElement;
  previousInert: Map<HTMLElement, boolean>;
  active: boolean;
}

const activeModalBackgrounds = new Set<ModalBackgroundState>();

function restoreModalBackground(state: ModalBackgroundState): void {
  if (!state.active) return;
  for (const [element, inert] of state.previousInert) element.inert = inert;
  state.active = false;
  activeModalBackgrounds.delete(state);
}

export function restoreActiveModalBackgrounds(): void {
  for (const state of activeModalBackgrounds) restoreModalBackground(state);
}

export function syncModalBackground(
  previous: ModalBackgroundState | null,
  modal: HTMLElement | null,
): ModalBackgroundState | null {
  if (previous?.modal === modal && previous.active) return previous;
  if (previous) restoreModalBackground(previous);
  if (!modal) return null;

  const previousInert = new Map<HTMLElement, boolean>();
  let current: HTMLElement | null = modal;
  while (current.parentElement && current.parentElement !== modal.ownerDocument.documentElement) {
    const parent: HTMLElement = current.parentElement;
    for (const sibling of parent.children) {
      if (!(sibling instanceof modal.ownerDocument.defaultView!.HTMLElement) || sibling === current) continue;
      previousInert.set(sibling as HTMLElement, (sibling as HTMLElement).inert);
      (sibling as HTMLElement).inert = true;
    }
    current = parent;
  }
  const state = { modal, previousInert, active: true };
  activeModalBackgrounds.add(state);
  return state;
}

export function trapDialogFocus(event: KeyboardEvent, close: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget as HTMLElement;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && dialog.ownerDocument.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && dialog.ownerDocument.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreDialogFocus(opener: HTMLElement | null, fallback: () => HTMLElement | null | undefined): void {
  (opener?.isConnected ? opener : fallback())?.focus();
}

export function focusDialogCancel(root: ParentNode): void {
  root.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
}
