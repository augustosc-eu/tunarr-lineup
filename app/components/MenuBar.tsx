'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export type MenuItem =
  | { label: string; shortcut?: string; disabled?: boolean; onSelect: () => void }
  | 'separator';

export type Menu = { title: string; items: MenuItem[] };

/**
 * Classic pull-down menus. Mouse: click a title, hover to switch.
 * Keyboard/remote: arrows move through titles and items, Enter/OK
 * activates, Escape/Back closes. On phones the titles don't fit, so CSS
 * swaps them for one "Menu" button whose sheet lists every menu.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLElement>(null);
  const titleRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The compact sheet uses the index just past the last menu.
  const all = menus.length;

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
  // The compact sheet already shows every menu, so there is nothing to switch to.
  const switchMenu = (direction: 1 | -1) => { if (open !== all) setOpen(((open ?? 0) + direction + menus.length) % menus.length); };

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
        if (index === all) return;
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

  const renderItems = (items: MenuItem[], key: string) => items.map((item, itemIndex) => item === 'separator'
    ? <hr key={`${key}-separator-${itemIndex}`} />
    : (
      <button
        key={`${key}-${item.label}`}
        role="menuitem"
        disabled={item.disabled}
        onClick={() => { setOpen(null); item.onSelect(); }}
      >
        <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>
    ));

  return (
    <nav className="menu-items" role="menubar" aria-label="Application menu" ref={barRef} onKeyDown={onKeyDown}>
      {menus.map((menu, index) => (
        <div className="menu full" key={menu.title}>
          <button
            ref={(element) => { titleRefs.current[index] = element; }}
            className={`menu-title ${open === index ? 'open' : ''}`}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            data-menu-index={index}
            onClick={() => setOpen((current) => (current === index ? null : index))}
            onMouseEnter={() => { if (open !== null && open !== all) setOpen(index); }}
          >
            {menu.title}
          </button>
          {open === index && <div className="menu-dropdown" role="menu" aria-label={menu.title}>{renderItems(menu.items, menu.title)}</div>}
        </div>
      ))}
      <div className="menu compact">
        <button
          ref={(element) => { titleRefs.current[all] = element; }}
          className={`menu-title ${open === all ? 'open' : ''}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === all}
          data-menu-index={all}
          onClick={() => setOpen((current) => (current === all ? null : all))}
        >
          <span aria-hidden="true">☰</span> Menu
        </button>
        {open === all && (
          <div className="menu-dropdown menu-sheet" role="menu" aria-label="All menus">
            {menus.map((menu) => (
              <div className="menu-section" role="group" aria-label={menu.title} key={menu.title}>
                <p className="eyebrow">{menu.title}</p>
                {renderItems(menu.items, menu.title)}
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}
