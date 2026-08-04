import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => element.offsetParent !== null);
}

/**
 * Traps Tab focus inside the returned ref while `open`, closes on Escape, and
 * restores focus to whatever triggered the dialog once it closes. Only
 * depends on `open` (not `onClose`) so re-renders while the dialog is open —
 * e.g. typing in a search field — don't re-run the effect and steal focus.
 *
 * Pass `trigger` when the dialog is its own component that mounts fresh per
 * open (rather than a conditional block inside an always-mounted parent) and
 * contains a native `autoFocus` field — the browser applies `autoFocus`
 * during commit, before this hook's effect runs, so `document.activeElement`
 * would otherwise already be inside the dialog by the time it's read here.
 */
export function useDialogA11y<T extends HTMLElement>(open: boolean, onClose: () => void, trigger?: HTMLElement | null) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    const triggerElement = triggerRef.current !== undefined ? triggerRef.current : (document.activeElement as HTMLElement | null);

    if (container && !container.contains(document.activeElement)) {
      (focusableElements(container)[0] ?? container).focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      triggerElement?.focus();
    };
  }, [open]);

  return containerRef;
}
