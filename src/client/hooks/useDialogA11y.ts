import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = "a[href], button, textarea, input, select, [tabindex]";

type HiddenBackground = {
  count: number;
  ariaHidden: string | null;
  inert: boolean;
};

const hiddenBackground = new Map<HTMLElement, HiddenBackground>();

function hideBackground(container: HTMLElement, interactionElements: ReadonlySet<HTMLElement>): HTMLElement[] {
  const hidden: HTMLElement[] = [];
  let branch: HTMLElement | null = container;
  while (branch?.parentElement) {
    const parentElement: HTMLElement = branch.parentElement;
    for (const sibling of Array.from(parentElement.children)) {
      if (sibling === branch || !(sibling instanceof HTMLElement) || interactionElements.has(sibling)) continue;
      const existing = hiddenBackground.get(sibling);
      if (existing) {
        existing.count++;
      } else {
        hiddenBackground.set(sibling, {
          count: 1,
          ariaHidden: sibling.getAttribute("aria-hidden"),
          inert: sibling.inert,
        });
        sibling.setAttribute("aria-hidden", "true");
        sibling.inert = true;
      }
      hidden.push(sibling);
    }
    branch = parentElement;
  }
  return hidden;
}

function restoreBackground(elements: HTMLElement[]) {
  for (const element of elements) {
    const existing = hiddenBackground.get(element);
    if (!existing) continue;
    if (--existing.count > 0) continue;
    if (existing.ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", existing.ariaHidden);
    element.inert = existing.inert;
    hiddenBackground.delete(element);
  }
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.offsetParent !== null,
  );
}

// container.focus() (used as a fallback when the dialog has nothing else
// focusable) is a no-op unless the element is already focusable — ensure it
// always is, rather than relying on every call site remembering tabIndex={-1}.
function ensureFocusable(container: HTMLElement | null) {
  if (container && !container.hasAttribute("tabindex")) container.tabIndex = -1;
}

/**
 * Traps Tab focus inside the returned ref while `open`, closes on Escape, and
 * makes the background inert and hidden from assistive technology, and restores
 * focus to whatever triggered the dialog once it closes. Only
 * depends on `open` (not `onClose`) so re-renders while the dialog is open —
 * e.g. typing in a search field — don't re-run the effect and steal focus.
 *
 * Pass `trigger` when the dialog is its own component that mounts fresh per
 * open (rather than a conditional block inside an always-mounted parent) and
 * contains a native `autoFocus` field — the browser applies `autoFocus`
 * during commit, before this hook's effect runs, so `document.activeElement`
 * would otherwise already be inside the dialog by the time it's read here.
 * Pass `interactionElementRefs` for controls outside the dialog container that
 * are part of the modal interaction, such as the mobile drawer backdrop.
 */
export function useDialogA11y<T extends HTMLElement>(open: boolean, onClose: () => void, trigger?: HTMLElement | null, interactionElementRefs: Array<RefObject<HTMLElement | null>> = []) {
  const containerRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const triggerRef = useRef(trigger);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    triggerRef.current = trigger;
  });

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    const triggerElement = triggerRef.current !== undefined ? triggerRef.current : (document.activeElement as HTMLElement | null);
    ensureFocusable(container);
    const interactionElements = new Set(interactionElementRefs.flatMap((ref) => ref.current ? [ref.current] : []));
    const background = container ? hideBackground(container, interactionElements) : [];

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
      if (focusable.length === 0) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (container && !container.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
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
      restoreBackground(background);
      // The trigger can be torn down while the dialog was open — e.g. an
      // auto-refreshing list re-keying its rows out from under a button the
      // user clicked. Restoring focus to a detached node is already a silent
      // no-op, but check explicitly rather than relying on that incidental
      // browser behavior.
      if (triggerElement && document.contains(triggerElement)) triggerElement.focus();
    };
  }, [open]);

  return containerRef;
}
