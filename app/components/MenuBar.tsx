'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; onSelect: () => void }
  | 'separator';

export type Menu = { title: string; items: MenuItem[] };

/**
 * Classic pull-down menus. Mouse: click a title, hover to switch.
 * Keyboard/remote: arrows move through titles and items, Enter/OK
 * activates, Escape/Back closes.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const titleRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open === null) return;
    const close = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  useEffect(() => {
    if (open === null) return;
    barRef.current?.querySelector<HTMLButtonElement>('.menu-dropdown button:not(:disabled)')?.focus();
  }, [open]);

  const moveItemFocus = (direction: 1 | -1) => {
    const items = [...(barRef.current?.querySelectorAll<HTMLButtonElement>('.menu-dropdown button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(current + direction + items.length) % items.length].focus();
  };

  // The newly opened menu's first item takes focus via the effect above.
  const switchMenu = (direction: 1 | -1) => setOpen(((open ?? 0) + direction + menus.length) % menus.length);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (key === 'Escape' || key === 'GoBack' || key === 'BrowserBack') {
      if (open !== null) {
        event.preventDefault();
        event.stopPropagation();
        titleRefs.current[open]?.focus();
        setOpen(null);
      }
      return;
    }
    if (open === null) {
      if (key === 'ArrowDown' && (event.target as HTMLElement).dataset.menuIndex) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(Number((event.target as HTMLElement).dataset.menuIndex));
      } else if ((key === 'ArrowRight' || key === 'ArrowLeft') && (event.target as HTMLElement).dataset.menuIndex) {
        event.preventDefault();
        event.stopPropagation();
        const index = Number((event.target as HTMLElement).dataset.menuIndex);
        titleRefs.current[(index + (key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length]?.focus();
      }
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      moveItemFocus(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      switchMenu(key === 'ArrowRight' ? 1 : -1);
    }
  };

  return (
    <nav className="menu-items" role="menubar" aria-label="Application menu" ref={barRef} onKeyDown={onKeyDown}>
      {menus.map((menu, index) => (
        <div className="menu" key={menu.title}>
          <button
            ref={(element) => { titleRefs.current[index] = element; }}
            className={`menu-title ${open === index ? 'open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            data-menu-index={index}
            onClick={() => setOpen((current) => (current === index ? null : index))}
            onMouseEnter={() => { if (open !== null) setOpen(index); }}
          >
            {menu.title}
          </button>
          {open === index && (
            <div className="menu-dropdown" role="menu" aria-label={menu.title}>
              {menu.items.map((item, itemIndex) => item === 'separator'
                ? <hr key={`separator-${itemIndex}`} />
                : (
                  <button
                    key={item.label}
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => { setOpen(null); item.onSelect(); }}
                  >
                    <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
                  </button>
                ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
