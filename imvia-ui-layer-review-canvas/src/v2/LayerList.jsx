import { useState } from 'react';
import { ChevronDown, ChevronUp, Eye, Pencil, Plus, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { categoryPresets } from './document.js';
import { CustomCategoryForm } from './CustomCategoryForm.jsx';

export function LayerList({ document, statusByLayer = {}, adoptedCount = 0, onSelect, onEdit, onReview, onAdd, onRemove, onReorder, onSplit, splitDisabled = false }) {
  const [menuOpen,setMenuOpen]=useState(false); const [customOpen,setCustomOpen]=useState(false);
  return <aside className="v2-layer-panel" aria-label="拆分图层列表">
    <header className="v2-layer-panel__head"><div><h2>图层 <span aria-label={`${document.layerOrder.length} 个图层`}>{document.layerOrder.length}</span></h2>{adoptedCount > 0 && <small>已完成 {adoptedCount}</small>}</div>
      <button className="v2-icon-button" type="button" aria-label="新增拆分项" onClick={()=>setMenuOpen(value=>!value)}><Plus size={19}/></button>
      {menuOpen?<div className="v2-add-menu" role="menu"><strong>选择类别</strong>{categoryPresets.map(([label,route])=><button key={label} role="menuitem" type="button" onClick={()=>{onAdd?.({displayCategory:label,processingCategory:route});setMenuOpen(false);}}><Sparkles size={15}/>{label}</button>)}
        <button role="menuitem" type="button" onClick={()=>setCustomOpen(true)}>自定义</button>
        {customOpen?<CustomCategoryForm onAdd={category=>{onAdd?.(category);setCustomOpen(false);setMenuOpen(false);}}/>:null}
      </div>:null}
    </header>
    <div className="v2-layer-list" role="list" aria-label="所有拆分项">{document.layerOrder.map((id,index)=>{const layer=document.layers[id];return <article key={id} role="listitem" data-layer-id={id} onClick={()=>onSelect?.(id)} className={`v2-layer-row ${document.activeLayerId===id?'v2-layer-row--active':''}`}>
      <button className="v2-layer-row__main" type="button" aria-pressed={document.activeLayerId===id} onClick={event=>{event.stopPropagation();onSelect?.(id);}}><strong>{layer.name}</strong>{statusByLayer[id] && statusByLayer[id] !== '待拆分' ? <span><i/> {statusByLayer[id]}</span> : null}</button>
      <div className="v2-layer-row__actions"><button type="button" aria-label={`查看${layer.name}结果`} onClick={event=>{event.stopPropagation();onReview?.(id);}}><Eye size={16}/></button><button type="button" aria-label={`编辑${layer.name}`} onClick={event=>{event.stopPropagation();onEdit?.(id);}}><Pencil size={16}/></button><button type="button" aria-label={`${layer.name}上移`} title={index===0 ? '已在列表顶部' : '上移一层：重叠时优先选中，选区坐标不变'} disabled={index===0} onClick={event=>{event.stopPropagation();const next=[...document.layerOrder];[next[index-1],next[index]]=[next[index],next[index-1]];onReorder?.(next);}}><ChevronUp size={16}/></button><button type="button" aria-label={`${layer.name}下移`} title={index===document.layerOrder.length-1 ? '已在列表底部' : '下移一层：置于下一层后方，选区坐标不变'} disabled={index===document.layerOrder.length-1} onClick={event=>{event.stopPropagation();const next=[...document.layerOrder];[next[index+1],next[index]]=[next[index],next[index+1]];onReorder?.(next);}}><ChevronDown size={16}/></button><button type="button" aria-label={`移除${layer.name}`} onClick={event=>{event.stopPropagation();onRemove?.(id);}}><Trash2 size={15}/></button></div>
      <button className="v2-layer-row__split" type="button" aria-label={`单独拆分：${layer.name}`} disabled={splitDisabled || !onSplit} onClick={event=>{event.stopPropagation();onSplit?.(id);}}><Scissors size={13}/>拆分</button>
    </article>;})}
      {!document.layerOrder.length?<div className="v2-list-empty">点击 + 选择类别，再在原图上拖出拆分区域。</div>:null}
    </div>
  </aside>;
}
