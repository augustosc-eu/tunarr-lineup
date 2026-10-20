'use client';

import { useRef, type KeyboardEvent } from 'react';
import { SKINS, type SkinId } from '../../lib/skins';

type Props = { skin: SkinId; onChange: (skin: SkinId) => void; onClose: () => void };

/**
 * View → Appearance…: four skins as radio cards. Arrows move between them, Enter/OK
 * or Space picks one, which applies and saves it at once; Done and Escape/Back
 * (handled by the page) close without undoing the pick.
 */
export function AppearanceDialog({ skin, onChange, onClose }: Props) {
  const choices = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const current = choices.current.findIndex((element) => element === document.activeElement);
    choices.current[(Math.max(0, current) + step + SKINS.length) % SKINS.length]?.focus();
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal appearance-modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">VIEW</p>
        <h2 id="appearance-title">Appearance</h2>
        <p className="subtle">Choose how the whole desk looks, Watch Live included. The choice applies straight away and is kept in this browser only.</p>
        <div className="skin-choices" role="radiogroup" aria-labelledby="appearance-title" onKeyDown={onKeyDown}>
          {SKINS.map((option, index) => {
            const checked = option.id === skin;
            return (
              <button
                key={option.id}
                ref={(element) => { choices.current[index] = element; }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-describedby={`skin-${option.id}-description`}
                tabIndex={checked ? 0 : -1}
                autoFocus={checked}
                className="skin-choice"
                data-skin-option={option.id}
                onClick={() => onChange(option.id)}
              >
                <span className={`skin-preview preview-${option.id}`} aria-hidden="true"><i><em /><u /></i></span>
                <span>
                  <b>{option.name}</b>
                  <small id={`skin-${option.id}-description`}>{option.description}</small>
                  {checked && <span className="skin-mark">✓ In use</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="dialog-actions"><button className="primary" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
