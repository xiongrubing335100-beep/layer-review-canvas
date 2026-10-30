import { useEffect, useId, useRef, useState } from 'react';
import { Ellipsis, FolderInput } from 'lucide-react';

export function WorkbenchMoreMenu({ onImportLegacy, disabled = false }) {
  const [open, setOpen] = useState(false);
  const id = useId(), root = useRef(null), trigger = useRef(null), item = useRef(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    item.current?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return <div className="v2-more-menu" ref={root}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); setOpen(true); item.current?.focus();
      }
    }}>
    <button ref={trigger} type="button" className="v2-topbar-action v2-more-menu__trigger"
      aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(value => !value)}>
      <Ellipsis size={16}/>
    </button>
    {open ? <div id={id} className="v2-more-menu__popover" role="menu" aria-label="更多操作">
      <button ref={item} type="button" role="menuitem" onClick={() => { close(); onImportLegacy(); }}>
        <FolderInput size={15}/>导入旧版项目
      </button>
    </div> : null}
  </div>;
}
