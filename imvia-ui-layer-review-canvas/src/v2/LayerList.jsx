import { useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { categoryPresets, processingCategories } from './document.js';

const processingLabels = { text:'普通文字',subject:'主体',brand_ui:'品牌与 UI',decoration_prop:'装饰与道具',effect:'光效',background:'背景' };

export function LayerList({ document, statusByLayer = {}, onSelect, onEdit, onAdd, onRemove, onReorder }) {
  const [menuOpen,setMenuOpen]=useState(false); const [customOpen,setCustomOpen]=useState(false);
  const [customName,setCustomName]=useState(''); const [customRoute,setCustomRoute]=useState('');
  const addCustom=()=>{if(customName.trim()&&processingCategories.includes(customRoute)){onAdd?.({displayCategory:customName.trim(),processingCategory:customRoute});setCustomName('');setCustomRoute('');setCustomOpen(false);setMenuOpen(false);}};
  return <aside className="v2-layer-panel" aria-label="拆分图层列表">
    <header className="v2-layer-panel__head"><div><h2>拆分图层 <span aria-label="图层数量">ⓘ</span></h2><small>{document.layerOrder.length} 个图层</small></div>
      <button className="v2-icon-button" type="button" aria-label="新增拆分项" onClick={()=>setMenuOpen(value=>!value)}><Plus size={19}/></button>
      {menuOpen?<div className="v2-add-menu" role="menu"><strong>选择类别</strong>{categoryPresets.map(([label,route])=><button key={label} role="menuitem" type="button" onClick={()=>{onAdd?.({displayCategory:label,processingCategory:route});setMenuOpen(false);}}><Sparkles size={15}/>{label}</button>)}
        <button role="menuitem" type="button" onClick={()=>setCustomOpen(true)}>自定义类别</button>
        {customOpen?<div className="v2-custom-category"><label>类别名称<input value={customName} onChange={event=>setCustomName(event.target.value)} /></label><label>处理类别<select aria-label="处理类别" required value={customRoute} onChange={event=>setCustomRoute(event.target.value)}><option value="">选择处理类别</option>{processingCategories.map(value=><option value={value} key={value}>{processingLabels[value]}</option>)}</select></label><button type="button" disabled={!customName.trim()||!customRoute} onClick={addCustom}>确认并框选区域</button></div>:null}
      </div>:null}
    </header>
    <div className="v2-layer-list" role="list" aria-label="所有拆分项">{document.layerOrder.map((id,index)=>{const layer=document.layers[id];return <article key={id} role="listitem" data-layer-id={id} onClick={()=>onSelect?.(id)} className={`v2-layer-row ${document.activeLayerId===id?'v2-layer-row--active':''}`}>
      <button className="v2-layer-row__main" type="button" onClick={event=>{event.stopPropagation();onSelect?.(id);}}><strong>{layer.name}</strong><span><i/> {statusByLayer[id]||'待拆分'}</span></button>
      <div className="v2-layer-row__actions"><small>{layer.displayCategory}</small><button type="button" aria-label={`编辑${layer.name}`} onClick={event=>{event.stopPropagation();onEdit?.(id);}}><Pencil size={16}/></button><button type="button" aria-label={`${layer.name}上移`} disabled={index===0} onClick={event=>{event.stopPropagation();const next=[...document.layerOrder];[next[index-1],next[index]]=[next[index],next[index-1]];onReorder?.(next);}}><ChevronUp size={16}/></button><button type="button" aria-label={`${layer.name}下移`} disabled={index===document.layerOrder.length-1} onClick={event=>{event.stopPropagation();const next=[...document.layerOrder];[next[index+1],next[index]]=[next[index],next[index+1]];onReorder?.(next);}}><ChevronDown size={16}/></button><button type="button" aria-label={`移除${layer.name}`} onClick={event=>{event.stopPropagation();onRemove?.(id);}}><Trash2 size={15}/></button></div>
    </article>;})}
      {!document.layerOrder.length?<div className="v2-list-empty">点击 + 选择类别，再在原图上拖出拆分区域。</div>:null}
    </div>
  </aside>;
}
