import { useEffect, useMemo, useRef, useState } from 'react';
import { Hand, MousePointer2, Plus, ZoomIn, ZoomOut, LocateFixed, Focus, Layers3, Ungroup, Download, Upload, RefreshCw, Scissors, Pencil, Eye, Scan, SquareDashed, AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignEndHorizontal, LayoutGrid } from 'lucide-react';
import { alignCanvasItems } from '../canvas-alignment.js';
import { categoryPresets } from './document.js';
import { CustomCategoryForm } from './CustomCategoryForm.jsx';
import { candidateLabels } from './result-status.js';
import { boardStorageKey, restoreBoard, saveBoard, buildBoardNodes, moveBoardNodes, boardBounds, fitBoard, zoomBoard, selectBoardRect } from './board-state.js';
import './node-board.css';

const browserStorage = () => { try { return globalThis.sessionStorage; } catch { return null; } };
const pathBetween = (from, to) => {
  const x = from.x + from.width, y = from.y + 38, tx = to.x, ty = to.y + 38;
  const bend = Math.max(70, Math.abs(tx - x) / 2);
  return `M ${x} ${y} C ${x+bend} ${y}, ${tx-bend} ${ty}, ${tx} ${ty}`;
};

export function NodeBoard({ document, sourceUrl, workspaceId, sessionId, api, busy = false, splitDisabled = false,
  onUpload, onSelect, onEdit, onReview, onSplit, onAdd, onOpenSource }) {
  const storageKey = boardStorageKey(workspaceId,sessionId,document?.documentId);
  const [board,setBoard] = useState(()=>restoreBoard(browserStorage(),storageKey));
  const boardRef = useRef(board); boardRef.current = board;
  const root = useRef(null), fileInput = useRef(null), gesture = useRef(null), uploadMode = useRef('poster');
  const [selected,setSelected] = useState([]), [tool,setTool] = useState('select');
  const [space,setSpace] = useState(false), [marquee,setMarquee] = useState(null), [dragging,setDragging] = useState(false);
  const [candidates,setCandidates] = useState({}), [error,setError] = useState(''), [loading,setLoading] = useState(false);
  const [menu,setMenu] = useState(false), [refresh,setRefresh] = useState(0), [dropActive,setDropActive] = useState(false);
  const [customOpen,setCustomOpen] = useState(false);
  const [alignMenu,setAlignMenu] = useState(false);
  const nodes = useMemo(()=>buildBoardNodes(document,candidates,board.positions),[document,candidates,board.positions]);
  const nodeMap = useMemo(()=>new Map(nodes.map(node=>[node.key,node])),[nodes]);
  const selectedNodes = nodes.filter(node=>selected.includes(node.key));
  const groups = board.groups.map(group=>({...group,nodes:group.keys.map(key=>nodeMap.get(key)).filter(Boolean)}))
    .filter(group=>group.nodes.length>1).map(group=>({...group,bounds:boardBounds(group.nodes,20)}));

  useEffect(()=>{
    const persist = ()=>{ try { saveBoard(browserStorage(),storageKey,boardRef.current); } catch { setError('浏览器无法保存画板布局；拆分文档不受影响。'); } };
    const timer = setTimeout(persist,200);
    return ()=>clearTimeout(timer);
  },[board,storageKey]);
  useEffect(()=>{
    const flush = ()=>{ try { saveBoard(browserStorage(),storageKey,boardRef.current); } catch { /* Next mount can start with the default presentation. */ } };
    window.addEventListener('pagehide',flush);
    return ()=>{flush();window.removeEventListener('pagehide',flush);};
  },[storageKey]);
  const layerIds = document?.layerOrder.join('|') || '';
  useEffect(()=>{
    if (!document || !api?.getLayerVersions || !layerIds) return;
    let alive = true, timer;
    const read = async()=>{
      setLoading(true);
      const results = await Promise.all(document.layerOrder.map(async id=>{
        try { return [id,await api.getLayerVersions(document.documentId,id)]; }
        catch(cause) { return [id,null,cause.message]; }
      }));
      if (!alive) return;
      setCandidates(previous=>({...previous,...Object.fromEntries(results.filter(([,data])=>data))}));
      setError(results.some(([,data])=>!data) ? '部分候选暂时无法加载，可点击刷新重试。' : '');
      setLoading(false); timer=setTimeout(read,5000);
    };
    void read();return()=>{alive=false;clearTimeout(timer);};
  },[api,document?.documentId,document?.revision,layerIds,refresh]);
  useEffect(()=>{
    const node=root.current;if(!node)return;
    const wheel=event=>{
      if(event.target.closest('[data-board-ui]'))return;
      event.preventDefault();const rect=node.getBoundingClientRect();
      setBoard(current=>({...current,viewport:zoomBoard(current.viewport,{x:event.clientX-rect.left,y:event.clientY-rect.top},current.viewport.scale*Math.exp(-event.deltaY*.0015))}));
    };
    node.addEventListener('wheel',wheel,{passive:false});
    const release=()=>{setSpace(false);gesture.current=null;setDragging(false);setMarquee(null);};
    window.addEventListener('blur',release);
    return()=>{node.removeEventListener('wheel',wheel);window.removeEventListener('blur',release);};
  },[]);

  const point = event => { const rect=root.current.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top}; };
  const world = p => ({x:(p.x-boardRef.current.viewport.x)/boardRef.current.viewport.scale,y:(p.y-boardRef.current.viewport.y)/boardRef.current.viewport.scale});
  const expandGroups = keys => [...new Set([...keys,...board.groups.filter(group=>group.keys.some(key=>keys.includes(key))).flatMap(group=>group.keys)])];
  function pointerDown(event) {
    if(event.target.closest('[data-board-ui]') || ![0,1].includes(event.button))return;
    event.preventDefault();root.current.focus();root.current.setPointerCapture(event.pointerId);
    const start=point(event), initial=boardRef.current;
    if(event.button===1 || space || tool==='hand') {
      gesture.current={kind:'pan',start,initial};setDragging(true);return;
    }
    const key=event.target.closest('[data-board-node]')?.dataset.boardNode;
    const groupId=event.target.closest('[data-board-group]')?.dataset.boardGroup;
    if(key || groupId) {
      let keys=groupId ? board.groups.find(group=>group.id===groupId).keys : expandGroups([key]);
      if(event.shiftKey) keys=keys.every(id=>selected.includes(id)) ? selected.filter(id=>!keys.includes(id)) : [...new Set([...selected,...keys])];
      else if(!groupId && selected.includes(key)) keys=selected;
      setSelected(keys);if(key && nodeMap.get(key)?.layerId)onSelect?.(nodeMap.get(key).layerId);
      gesture.current={kind:'move',start,initial,nodes,keys};setDragging(true);
    } else {
      if(!event.shiftKey)setSelected([]);
      gesture.current={kind:'marquee',start:world(start),initial,selection:event.shiftKey?selected:[]};
    }
  }
  function pointerMove(event) {
    const current=gesture.current;if(!current)return;
    const p=point(event),v=current.initial.viewport;
    if(current.kind==='pan') setBoard({...current.initial,viewport:{...v,x:v.x+p.x-current.start.x,y:v.y+p.y-current.start.y}});
    else if(current.kind==='move') setBoard({...current.initial,positions:moveBoardNodes(current.initial.positions,current.nodes,current.keys,{x:(p.x-current.start.x)/v.scale,y:(p.y-current.start.y)/v.scale})});
    else {
      const end=world(p), start=current.start;
      const rect={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};
      setMarquee(rect);setSelected([...new Set([...current.selection,...expandGroups(selectBoardRect(nodes,rect))])]);
    }
  }
  const endGesture = ()=>{gesture.current=null;setMarquee(null);setDragging(false);};
  const chooseUpload = mode=>{uploadMode.current=mode;fileInput.current?.click();};
  const zoom = factor=>{const rect=root.current.getBoundingClientRect();setBoard(current=>({...current,viewport:zoomBoard(current.viewport,{x:rect.width/2,y:rect.height/2},current.viewport.scale*factor)}));};
  const fit = (items=nodes)=>{const rect=root.current.getBoundingClientRect();setBoard(current=>({...current,viewport:fitBoard(items,rect)}));};
  const align = alignment=>setBoard(current=>({...current,positions:{...current.positions,...alignCanvasItems(selectedNodes,alignment)}}));
  const groupSelection = ()=>{
    if(selectedNodes.length<2)return;
    setBoard(current=>({...current,groups:[...current.groups.filter(group=>!group.keys.some(key=>selected.includes(key))),
      {id:crypto.randomUUID(),name:`分组 ${current.groups.length+1}`,keys:selectedNodes.map(node=>node.key)}]}));
  };
  const ungroup = ()=>setBoard(current=>({...current,groups:current.groups.filter(group=>!group.keys.some(key=>selected.includes(key)))}));
  const openNode = node=>node.kind==='source'?onOpenSource?.():node.kind==='layer'?onEdit?.(node.layerId):onReview?.(node.layerId);
  function keyDown(event) {
    if(event.target.closest('input,select,textarea,button,a'))return;
    if(event.code==='Space'){event.preventDefault();setSpace(true);}
    else if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelected(nodes.map(node=>node.key));}
    else if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='g'){event.preventDefault();event.shiftKey?ungroup():groupSelection();}
    else if(event.key==='Escape'){endGesture();setSelected([]);setMenu(false);setAlignMenu(false);}
    else if(event.key.toLowerCase()==='h')setTool('hand');
    else if(event.key.toLowerCase()==='v')setTool('select');
    else if(event.key==='Enter' && selectedNodes.length===1)openNode(selectedNodes[0]);
  }
  return <section ref={root} className={`v2-board ${space||tool==='hand'?'is-hand':''} ${dragging?'is-dragging':''} ${dropActive?'is-drop-active':''}`}
    aria-label="无限画布，按住空格拖动平移，滚轮缩放" tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove}
    onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture} onKeyDown={keyDown} onKeyUp={event=>{if(event.code==='Space')setSpace(false);}}
    onDoubleClick={event=>{if(!document && !event.target.closest('[data-board-ui]'))chooseUpload('poster');}}
    onDragOver={event=>{if(!document){event.preventDefault();setDropActive(true);}}} onDragLeave={()=>setDropActive(false)}
    onDrop={event=>{event.preventDefault();setDropActive(false);if(!document&&!busy&&event.dataTransfer.files[0])onUpload?.('poster',event.dataTransfer.files[0]);}}
    style={{backgroundSize:`${24*board.viewport.scale}px ${24*board.viewport.scale}px`,backgroundPosition:`${board.viewport.x}px ${board.viewport.y}px`}}>
    <div className="v2-board-heading" data-board-ui><strong>节点画板</strong><span>{nodes.length} 个节点 · {selectedNodes.length} 个选中</span><small>摆放不改变拆分坐标</small></div>
    <div className="v2-board-stage" data-board-stage style={{transform:`translate(${board.viewport.x}px,${board.viewport.y}px) scale(${board.viewport.scale})`}}>
      <svg className="v2-board-links" aria-label="原图、拆分项与结果的关系">
        {nodes.filter(node=>node.parent&&nodeMap.has(node.parent)).map(node=>{
          const active = selected.includes(node.key) || selected.includes(node.parent);
          const path = pathBetween(nodeMap.get(node.parent),node);
          return <g key={node.key}>
            <path d={path} className={`${node.kind==='result'?'is-result':''} ${active?'is-selected':''}`}/>
            {active ? <g aria-hidden="true">
              <path d={path} pathLength="100" className="v2-board-link-flow v2-board-link-flow--glow"/>
              <path d={path} pathLength="100" className="v2-board-link-flow"/>
            </g> : null}
          </g>;
        })}
      </svg>
      {groups.map(group=><section key={group.id} className="v2-board-group" style={{left:group.bounds.x,top:group.bounds.y-30,width:group.bounds.width,height:group.bounds.height+30}}>
        <header data-board-group={group.id}>{group.name} · {group.keys.length} 个节点<button data-board-ui type="button" aria-label={`解散${group.name}`} onClick={()=>setBoard(current=>({...current,groups:current.groups.filter(item=>item.id!==group.id)}))}>×</button></header>
      </section>)}
      {nodes.map(node=><article key={node.key} data-board-node={node.key} data-kind={node.kind} className={`v2-board-node ${selected.includes(node.key)?'is-selected':''}`}
        aria-label={node.kind==='source'?'原图节点':`${node.kind==='layer'?'拆分':'结果'}节点：${node.name}`} tabIndex={0}
        style={{left:node.x,top:node.y,width:node.width,height:node.height}} onDoubleClick={event=>{event.stopPropagation();openNode(node);}}>
        <header><div className="v2-board-node-title"><strong>{node.name}</strong><span>{node.kind==='source'?`${document.source.width} × ${document.source.height}`:node.kind==='layer'?`原图选区 · ${candidateLabels[candidates[node.layerId]?.state?.status] || '检查状态中'}`:node.adopted?'已完成':'拆分结果'}</span></div>
          <div className="v2-board-node-actions" data-board-ui>
            {node.kind==='source'?<button type="button" aria-label="打开原图框选" title="打开原图框选" onClick={onOpenSource}><Scan size={16}/></button>:
              node.kind==='layer'?<><button type="button" aria-label={`画板编辑：${node.name}`} title="编辑范围与处理要求" onClick={()=>onEdit?.(node.layerId)}><Pencil size={15}/></button>
                <button className="v2-board-split" type="button" aria-label={`画板拆分：${node.name}`} title="单独拆分 · 发送到 Codex（自动保存当前编辑）" disabled={splitDisabled} onClick={()=>onSplit?.(node.layerId)}><Scissors size={16}/></button></>:
              <><button type="button" aria-label={`查看结果：${node.name}`} title="查看拆分结果" onClick={()=>onReview?.(node.layerId)}><Eye size={16}/></button>
                <a href={`${api.candidateUrl(document.documentId,node.layerId,node.versionId)}?download=1`} download={`${node.name}-${node.versionId.slice(0,8)}.png`} aria-label={`下载结果：${node.name}`} title="下载结果 PNG"><Download size={16}/></a></>}
          </div>
        </header>
        <div className="v2-board-preview">
          {node.kind==='source'?<img src={sourceUrl} alt="原图预览" draggable="false"/>:node.kind==='layer'?<svg viewBox={`${node.bounds.x} ${node.bounds.y} ${node.bounds.width} ${node.bounds.height}`} aria-label={`${node.name}原图选区`}>
            <defs><clipPath id={`board-crop-${node.layerId}`}><rect {...node.bounds}/></clipPath></defs>
            <image href={sourceUrl} width={document.source.width} height={document.source.height} clipPath={`url(#board-crop-${node.layerId})`}/></svg>:<img src={api.candidateUrl(document.documentId,node.layerId,node.versionId)} alt={`${node.name}透明候选`} draggable="false"/>}
        </div>
      </article>)}
      {marquee?<div className="v2-board-marquee" style={{left:marquee.x,top:marquee.y,width:marquee.width,height:marquee.height}}/>:null}
    </div>
    {!document?<div className="v2-board-empty" data-board-ui><Layers3 size={28}/><h2>从一张原图开始</h2><p>双击画布、拖入图片，或选择上传入口</p><div>
      <button type="button" disabled={busy} onClick={()=>chooseUpload('poster')}><Upload size={16}/>上传海报原图</button>
      <button type="button" disabled={busy} onClick={()=>chooseUpload('h5')}><Upload size={16}/>上传 H5 原图</button>
    </div></div>:null}
    <input ref={fileInput} type="file" hidden accept="image/*" aria-label="画板上传原图" onChange={event=>{if(event.target.files[0])onUpload?.(uploadMode.current,event.target.files[0]);event.target.value='';}}/>
    <div className="v2-board-tools" data-board-ui role="toolbar" aria-label="画板工具">
      <button type="button" aria-label="选择工具" title="选择 V · 空白拖动框选" aria-pressed={tool==='select'} onClick={()=>setTool('select')}><MousePointer2 size={17}/></button>
      <button type="button" aria-label="平移工具" title="平移 H · 按住空格拖动" aria-pressed={tool==='hand'} onClick={()=>setTool('hand')}><Hand size={17}/></button>
      <i/><button type="button" aria-label="缩小画布" onClick={()=>zoom(1/1.2)}><ZoomOut size={17}/></button><output aria-label="画布缩放比例">{Math.round(board.viewport.scale*100)}%</output><button type="button" aria-label="放大画布" onClick={()=>zoom(1.2)}><ZoomIn size={17}/></button>
      <button type="button" aria-label="适配全部节点" disabled={!nodes.length} onClick={()=>fit()}><LocateFixed size={17}/></button>
      <button type="button" aria-label="聚焦选中节点" disabled={!selectedNodes.length} onClick={()=>fit(selectedNodes)}><Focus size={17}/></button>
    </div>
    <div className="v2-board-actions" data-board-ui role="toolbar" aria-label="节点操作">
      <button type="button" aria-label="新增拆分项" title="新增拆分项" aria-expanded={menu} disabled={!document||busy} onClick={()=>{setMenu(value=>!value);setAlignMenu(false);}}><Plus size={17}/></button>
      <button type="button" aria-label="全选节点" title="全选节点 ⌘/Ctrl+A" disabled={!nodes.length} onClick={()=>setSelected(nodes.map(node=>node.key))}><SquareDashed size={17}/></button>
      <button type="button" aria-label="对齐选中节点" title="对齐选中节点" aria-expanded={alignMenu} disabled={selectedNodes.length<2} onClick={()=>{setAlignMenu(value=>!value);setMenu(false);}}><AlignStartVertical size={17}/></button>
      <button type="button" aria-label="编组选中节点" title="编组选中节点 ⌘/Ctrl+G" disabled={selectedNodes.length<2} onClick={groupSelection}><Layers3 size={16}/></button>
      <button type="button" aria-label="解散选中编组" title="解散选中编组" disabled={!groups.some(group=>group.keys.some(key=>selected.includes(key)))} onClick={ungroup}><Ungroup size={16}/></button>
      <button type="button" aria-label="自动整理节点" title="自动整理节点" disabled={!nodes.length} onClick={()=>{const arranged=buildBoardNodes(document,candidates);setBoard(current=>({...current,positions:{},viewport:fitBoard(arranged,root.current.getBoundingClientRect())}));}}><LayoutGrid size={17}/></button>
      <button type="button" aria-label="刷新画板候选" title="刷新画板候选" disabled={!document||loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={15}/></button>
      {alignMenu?<div className="v2-board-align-menu" role="menu" aria-label="对齐方式">{[['left','左对齐',AlignStartVertical],['center','水平居中',AlignCenterVertical],['right','右对齐',AlignEndVertical],['top','顶部对齐',AlignStartHorizontal],['bottom','底部对齐',AlignEndHorizontal]].map(([value,label,Icon])=><button key={value} type="button" role="menuitem" aria-label={label} title={label} disabled={selectedNodes.length<2} onClick={()=>{align(value);setAlignMenu(false);}}><Icon size={17}/></button>)}</div>:null}
      {menu?<div className="v2-board-add-menu" role="menu">{categoryPresets.map(([displayCategory,processingCategory])=><button type="button" role="menuitem" key={displayCategory} onClick={()=>{setMenu(false);onAdd?.({displayCategory,processingCategory});}}>{displayCategory}</button>)}
        <button type="button" role="menuitem" onClick={()=>setCustomOpen(true)}>自定义</button>
        {customOpen?<CustomCategoryForm onAdd={category=>{setCustomOpen(false);setMenu(false);onAdd?.(category);}}/>:null}
      </div>:null}
    </div>
    <div className="v2-board-hint" data-board-ui>{error||'空格 + 拖动平移 · 滚轮缩放 · Shift 多选 · 双击节点编辑'}</div>
  </section>;
}
