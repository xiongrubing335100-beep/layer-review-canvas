import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ImagePlus, Layers3, LoaderCircle, Upload } from 'lucide-react';
import { createDocument as newDocument, addLayer, removeLayer, reorderLayers } from './document.js';
import { createWorkbenchV2Client } from './api-client.js';
import { DocumentCanvas } from './DocumentCanvas.jsx';
import { LayerList } from './LayerList.jsx';
import { LayerEditor } from './LayerEditor.jsx';
import { PenEditor } from './PenEditor.jsx';
import { commitEditorDraft, createEditorDraft, reduceEditorDraft } from './editor-state.js';
import './workbench-v2.css';

const SESSION_KEY = 'imvia-layer-v2-session';
const DOCUMENT_KEY = 'imvia-layer-v2-document';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const defaultApi = createWorkbenchV2Client();

function browserSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) { id = crypto.randomUUID().replaceAll('-', ''); sessionStorage.setItem(SESSION_KEY, id); }
    return id;
  } catch { return crypto.randomUUID().replaceAll('-', ''); }
}

async function normalizeImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('请选择图片文件。');
  if (file.size > MAX_FILE_BYTES) throw new Error('图片不能超过 32 MB。');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { alpha: true });
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片转 PNG 失败。')), 'image/png'));
    if (blob.size > MAX_FILE_BYTES) throw new Error('转为 PNG 后超过 32 MB，请缩小图片后再试。');
    return blob;
  } finally { bitmap.close(); }
}

export function WorkbenchV2({ api = defaultApi, onOpenLegacy, onOpenOverview }) {
  const [document, setDocument] = useState(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [selection, setSelection] = useState(null);
  const [pendingCategory, setPendingCategory] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobilePane, setMobilePane] = useState('canvas');
  const [editorDraft, setEditorDraft] = useState(null);
  const [penTarget, setPenTarget] = useState(null);
  const posterInput = useRef(null); const h5Input = useRef(null);
  const sessionId = useMemo(browserSessionId, []);
  const saveQueue = useRef([]);
  const saveActive = useRef(false);
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    try {
      const documentId = sessionStorage.getItem(DOCUMENT_KEY);
      if (!documentId) { hydrated.current = true; return () => { alive = false; }; }
      api.getDocument(documentId).then(value => {
        if (!alive) return;
        setDocument(value); setSelection(value.activeLayerId); setSourceUrl(api.sourceUrl(value.documentId));
        setNotice('已恢复上次编辑的文档');
      }).catch(cause => { if (alive) { sessionStorage.removeItem(DOCUMENT_KEY); setError(`恢复文档失败：${cause.message}`); } })
        .finally(() => { hydrated.current = true; });
    } catch (cause) { hydrated.current = true; if (alive) setError(cause.message); }
    return () => { alive = false; };
  }, [api]);

  const drainSaveQueue = () => {
    if (saveActive.current || !saveQueue.current.length) return;
    saveActive.current = true;
    setSaving(true);
    const next = saveQueue.current.shift();
    api.saveDocument(next, next.revision - 1).then(saved => {
      if (saved.revision !== next.revision) throw new Error('保存后的修订号不匹配');
      if (saveQueue.current.length === 0) setNotice('文档已保存');
    }).catch(cause => {
      setError(`保存失败：${cause.message}`); saveQueue.current = [];
    }).finally(() => { saveActive.current = false; if (!saveQueue.current.length) setSaving(false); drainSaveQueue(); });
  };

  function publishDocument(next) {
    setDocument(next);
    saveQueue.current.push(next); setNotice('正在保存…'); drainSaveQueue();
  }

  async function handleUpload(mode, file) {
    if (!file) return;
    setBusy(true); setError(''); setNotice('正在准备原图…'); setPendingCategory(null);
    try {
      const png = await normalizeImage(file);
      const created = await api.createDocument({ mode, file: png, workbenchSessionId: sessionId });
      hydrated.current = true;
      saveQueue.current = []; setDocument(created); setSelection(null); setSourceUrl(api.sourceUrl(created.documentId));
      try { sessionStorage.setItem(DOCUMENT_KEY, created.documentId); } catch { /* session persistence is optional */ }
      setNotice('原图已载入，可以添加拆分区域'); setMobilePane('canvas');
    } catch (cause) { setError(`载入失败：${cause.message}`); setNotice(''); }
    finally { setBusy(false); }
  }

  function armLayer(definition) {
    if (!document) return;
    setPendingCategory(definition); setSelection(null); setMobilePane('canvas');
    setNotice(`请在原图上拖出「${definition.displayCategory}」区域`); setError('');
  }

  function addRegion(bounds) {
    if (!document || !pendingCategory) return;
    const count = Object.values(document.layers).filter(layer => layer.displayCategory === pendingCategory.displayCategory).length;
    const name = count ? `${pendingCategory.displayCategory} ${count + 1}` : pendingCategory.displayCategory;
    const layerId = crypto.randomUUID().replaceAll('-', '');
    try {
      const next = addLayer(document, { layerId, name, ...pendingCategory, bounds, paths: [], requirements: '',
        strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
      publishDocument(next); setSelection(layerId); setPendingCategory(null); setNotice(`已添加「${name}」`); setMobilePane('list');
    } catch (cause) { setError(`无法添加区域：${cause.message}`); }
  }

  function removeSelectedLayer(layerId) {
    try { const next = removeLayer(document, layerId); publishDocument(next); setSelection(next.activeLayerId); }
    catch (cause) { setError(`移除失败：${cause.message}`); }
  }

  function openEditor(layerId) {
    try {
      setEditorDraft(createEditorDraft(document, layerId));
      setSelection(layerId); setPendingCategory(null); setPenTarget(null); setError('');
    } catch (cause) { setError(`无法打开编辑器：${cause.message}`); }
  }

  function cancelEditor() {
    setEditorDraft(current => current ? reduceEditorDraft(current, { type: 'cancel' }) : current);
    setEditorDraft(null); setPenTarget(null); setNotice('已放弃本次未保存修改');
  }

  function finishEditor() {
    try {
      const next = commitEditorDraft(document, editorDraft);
      if (next !== document) publishDocument(next);
      setSelection(editorDraft.layerId); setEditorDraft(null); setPenTarget(null);
      setNotice(next === document ? '没有新的修改' : '当前拆分项已保存'); setError('');
    } catch (cause) { setError(`保存拆分项失败：${cause.message}`); }
  }

  const viewDocument = document && selection ? { ...document, activeLayerId: selection } : document;
  return <main className="v2-workbench">
    <header className="v2-topbar">
      <button className="v2-brand" type="button" onClick={onOpenLegacy} aria-label="回到 Imvia Layer"><img className="v2-brand__mark" src="/imvia-logo.png" alt=""/><strong>IMVIA Studio · Layer</strong></button>
      <nav className="v2-tabs" aria-label="工作区"><button type="button" className="is-active"><Layers3 size={16}/>框选拆分</button><button type="button" onClick={onOpenOverview}>⌘　画布总览</button></nav>
      <span className="v2-save-state"><i className={error ? 'is-error' : ''}/>{busy ? '载入中' : error ? '需要处理' : document ? (saving ? '正在保存' : '文档已打开') : '等待上传'}</span>
    </header>

    {!document ? <section className="v2-empty" aria-label="上传原图">
      <div className="v2-upload-cards">
        <button type="button" className="v2-upload-card" onClick={() => posterInput.current?.click()} disabled={busy}>
          {busy ? <LoaderCircle className="v2-spin" size={22}/> : <Upload size={21}/>}<strong>上传海报原图拆分</strong><span>选择一张海报图片</span>
        </button>
        <button type="button" className="v2-upload-card" onClick={() => h5Input.current?.click()} disabled={busy}>
          <Upload size={21}/><strong>上传 H5 原图拆分</strong><span>选择一张 H5 页面截图</span>
        </button>
      </div>
      <input ref={posterInput} type="file" accept="image/*" hidden onChange={event=>{handleUpload('poster',event.target.files?.[0]);event.target.value='';}} />
      <input ref={h5Input} type="file" accept="image/*" hidden onChange={event=>{handleUpload('h5',event.target.files?.[0]);event.target.value='';}} />
      {error ? <p className="v2-notice v2-notice--error" role="alert">{error}</p> : notice ? <p className="v2-notice">{notice}</p> : null}
    </section> : editorDraft ? <div className="v2-editor-stage">
      <header className="v2-editor-stage__head"><span>{penTarget ? '精细编辑' : '单项编辑'} · {editorDraft.values.name}</span><button type="button" onClick={penTarget ? () => setPenTarget(null) : cancelEditor}>← 返回</button></header>
      {penTarget ? <PenEditor source={editorDraft.source} sourceUrl={sourceUrl} draft={editorDraft} target={penTarget}
        onChange={event => setEditorDraft(current => reduceEditorDraft(current, event))} onClose={() => setPenTarget(null)} />
        : <LayerEditor document={document} sourceUrl={sourceUrl} draft={editorDraft}
          onChange={event => setEditorDraft(current => reduceEditorDraft(current, event))} onDone={finishEditor} onCancel={cancelEditor} onOpenPen={setPenTarget} />}
    </div> : <>
      <div className="v2-mobile-switch"><button className={mobilePane==='canvas'?'is-active':''} onClick={()=>setMobilePane('canvas')}>原图</button><button className={mobilePane==='list'?'is-active':''} onClick={()=>setMobilePane('list')}>拆分项 {document.layerOrder.length}</button></div>
      <section className="v2-main-grid">
        <section className={`v2-source-section ${mobilePane==='list'?'is-mobile-hidden':''}`} aria-label="原图编辑">
          <header className="v2-section-heading"><div><h1>原图编辑</h1><span>{document.mode==='poster'?'海报':'H5'} · {document.source.width} × {document.source.height} px</span></div>
            <label className="v2-replace-upload"><ImagePlus size={16}/>替换原图<input type="file" accept="image/*" onChange={event=>{if(event.target.files?.[0])handleUpload(document.mode,event.target.files[0]);event.target.value='';}} /></label>
          </header>
          <DocumentCanvas document={viewDocument} sourceUrl={sourceUrl} selection={selection} onSelect={setSelection} onBoundsChange={pendingCategory?addRegion:undefined}/>
          <footer className="v2-canvas-foot"><span>{pendingCategory ? '拖动以框选，坐标与图层列表同步' : '选择右侧拆分项可定位对应区域'}</span><span>原位坐标已锁定</span></footer>
        </section>
        <LayerList document={viewDocument} statusByLayer={{}} onSelect={id=>{setSelection(id);setPendingCategory(null);setMobilePane('canvas');}}
          onEdit={openEditor}
          onAdd={armLayer} onRemove={removeSelectedLayer} onReorder={order=>{try{publishDocument(reorderLayers(document,order));}catch(cause){setError(`排序失败：${cause.message}`);}}}/>
      </section>
      <footer className="v2-bottom-actions"><div className="v2-bottom-actions__status" role={error?'alert':'status'}>{error||notice||'修改将自动保存'}</div>
        <button type="button" className="v2-split-action" disabled title="拆分执行将在后续阶段接入"><Upload size={17}/>拆分</button>
        <button type="button" className="v2-psd-action" disabled title="PSD 导出将在后续阶段接入"><Download size={17}/>下载 PSD</button>
      </footer>
    </>}
  </main>;
}
