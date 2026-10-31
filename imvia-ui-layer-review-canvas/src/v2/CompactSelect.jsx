import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

// A select-only combobox keeps option colors inside the workbench theme.
export function CompactSelect({ label, value, options, onChange, placeholder = '请选择', required = false }) {
  const id = useId(), root = useRef(null), trigger = useRef(null), list = useRef(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 280 });
  const selected = options.findIndex(option => option.value === value);
  const show = () => { setActive(Math.max(0, selected)); setOpen(true); };
  const choose = index => {
    if (!options[index]) return;
    onChange(options[index].value); setOpen(false); trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current.getBoundingClientRect();
    const boundary = root.current.closest('.v2-editor-panel, .v2-add-menu, .v2-board-add-menu')?.getBoundingClientRect();
    const below = Math.min(window.innerHeight - 8, boundary?.bottom - 6 || Infinity) - rect.bottom - 4;
    const above = rect.top - Math.max(8, boundary?.top + 6 || 0) - 4;
    const up = below < Math.min(280, options.length * 30 + 8) && above > below;
    setPlacement({ above: up, maxHeight: Math.max(40, Math.min(280, up ? above : below)) });
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const menu = list.current, option = menu?.children[active];
    if (!option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [open, active, placement]);

  function keyDown(event) {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      setActive(index => event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    } else if (event.key === 'Tab') setOpen(false);
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const start = open ? active + 1 : selected + 1;
      const index = options.findIndex((_, offset) => options[(start + offset) % options.length].label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (index >= 0) { event.preventDefault(); setActive((start + index) % options.length); setOpen(true); }
    }
  }

  return <div className="v2-select" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="v2-select-trigger" type="button" role="combobox" aria-label={label}
      aria-expanded={open} aria-haspopup="listbox" aria-controls={`${id}-list`} aria-required={required || undefined}
      aria-activedescendant={open ? `${id}-option-${active}` : undefined}
      onClick={() => open ? setOpen(false) : show()} onKeyDown={keyDown}>
      <span>{options[selected]?.label || placeholder}</span><ChevronDown size={14}/>
    </button>
    {open ? <div ref={list} id={`${id}-list`} role="listbox" aria-label={label}
      className={`v2-select-menu${placement.above ? ' is-above' : ''}`} style={{ maxHeight: placement.maxHeight }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-option-${index}`} role="option"
        aria-selected={option.value === value} className={`v2-select-option${index === active ? ' is-active' : ''}`}
        onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span>{option.value === value ? <Check size={13}/> : null}
      </div>)}
    </div> : null}
  </div>;
}
