import type { KeyboardEvent } from 'react';

// D-pad navigation for form-like dialogs (Batch Operations, Schedule Library &
// Calendar): ↑ ↓ move between controls in document order, OK ticks a checkbox
// or picks a radio. Text fields and drop-down lists keep their own arrow keys.

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]';

const keepsArrows = (element: HTMLElement) => element.tagName === 'SELECT' || element.tagName === 'TEXTAREA'
  || (element.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'file'].includes((element as HTMLInputElement).type));

/** Handles the key if it's D-pad movement inside `container`; true when it did. */
export function dpadKey(event: KeyboardEvent, container: HTMLElement | null): boolean {
  if (event.altKey || event.metaKey || event.ctrlKey || !container) return false;
  const element = event.target as HTMLElement;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !keepsArrows(element)) {
    event.preventDefault();
    const all = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.closest('[hidden]'));
    const at = all.indexOf(element);
    all[Math.max(0, Math.min(all.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    return true;
  }
  if (event.key === 'Enter' && element.tagName === 'INPUT' && ['checkbox', 'radio'].includes((element as HTMLInputElement).type)) {
    event.preventDefault();
    element.click();
    return true;
  }
  return false;
}

/**
 * A button disabled while its work runs drops the focus to the page, where
 * Back would close the whole dialog. Put it back: on `previous` if it's still
 * there and enabled, otherwise on the dialog's first control.
 */
export function keepFocusIn(container: HTMLElement | null, previous: Element | null) {
  if (!container || container.contains(document.activeElement)) return;
  const target = previous instanceof HTMLElement && container.contains(previous) && !(previous as HTMLButtonElement).disabled ? previous : container.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus({ preventScroll: true });
}
