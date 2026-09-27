import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Layers3, LoaderCircle, RotateCcw, Upload } from 'lucide-react';
import { createDocument as newDocument, addLayer, removeLayer, reorderLayers } from './document.js';
import { createWorkbenchV2Client } from './api-client.js';
import { DocumentCanvas } from './DocumentCanvas.jsx';
import { LayerList } from './LayerList.jsx';
import { LayerEditor } from './LayerEditor.jsx';
import { PenEditor } from './PenEditor.jsx';
import { CandidateReview } from './CandidateReview.jsx';
import { commitEditorDraft, createEditorDraft, reduceEditorDraft } from './editor-state.js';
import { sendVisibleWorkbenchMessage } from './host-message.js';
import './workbench-v2.css';

const SESSION_KEY = 'imvia-layer-v2-session';
const DOCUMENT_KEY = 'imvia-layer-v2-document';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const defaultApi = createWorkbenchV2Client();
const candidateLabels = { pending: '待拆分', processing: '处理中', review: '待审核', adopted: '已采用', stale: '结果已过期', failed: '拆分失败', cancelled: '已取消', inactive: '已移出列表' };

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
  const [reviewLayerId, setReviewLayerId] = useState(null);
  const [reviewData, setReviewData] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [layerStatusById, setLayerStatusById] = useState({});
  const [batchState, setBatchState] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [latestExport, setLatestExport] = useState(null);
  const posterInput = useRef(null); const h5Input = useRef(null);
  const [sessionId, setSessionId] = useState(browserSessionId);
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

  useEffect(() => {
    if (typeof api.getSessionBatches !== 'function') return undefined;
    let alive = true;
    api.getSessionBatches(sessionId).then(records => {
      if (!alive) return;
      const active = records.find(batch => batch.status !== 'complete' && !['cancelled'].includes(batch.confirmation?.status));
      if (!active) return;
      const status = active.confirmation?.status === 'sent' ? (active.status === 'running' ? 'running' : 'confirmed')
        : active.confirmation?.status === 'pending' ? 'ready_to_send' : 'awaiting_confirmation';
      setBatchState(current => current || { batchId: active.batchId, status, batch: active });
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, sessionId]);

  useEffect(() => {
    if (!batchState?.batchId || !['sending', 'awaiting_confirmation', 'confirmed', 'running'].includes(batchState.status) || typeof api.getBatchConfirmation !== 'function') return undefined;
    let stopped = false;
    const refresh = async () => {
      try {
        const confirmation = await api.getBatchConfirmation(batchState.batchId);
        const batch = await api.getBatch?.(batchState.batchId);
        if (stopped) return;
        if (batch?.status === 'complete') {
          setBatchState(current => current?.batchId === batchState.batchId ? { ...current, status: 'complete', batch } : current);
          setNotice('本批次处理已结束，可继续检查候选');
          return;
        }
        if (batch?.status === 'running') setBatchState(current => current?.batchId === batchState.batchId ? { ...current, status: 'running', batch } : current);
        if (confirmation.status === 'sent') {
          setBatchState(current => current?.batchId === batchState.batchId ? { ...current, status: 'confirmed' } : current);
          setNotice('Codex 已确认收到本批次消息；执行结果会逐项回传');
        } else if (confirmation.status === 'cancelled') {
          setBatchState(current => current?.batchId === batchState.batchId ? { ...current, status: 'cancelled' } : current);
          setNotice('本批次已取消');
        }
      } catch (cause) { if (!stopped) setError(`读取批次确认状态失败：${cause.message}`); }
    };
    refresh();
    const timer = setInterval(refresh, 1200);
    return () => { stopped = true; clearInterval(timer); };
  }, [api, batchState?.batchId, batchState?.status]);

  useEffect(() => {
    if (!document || !reviewLayerId || typeof api.getLayerVersions !== 'function') return undefined;
    let stopped = false;
    setReviewBusy(true);
    Promise.all([api.getLayerVersions(document.documentId, reviewLayerId), api.getComposition?.(document.documentId) || Promise.resolve({ layers: [] })])
      .then(([versions, composition]) => { if (!stopped) {
        setReviewData({ ...versions, composition: composition.layers || [] });
        setLayerStatusById(current => ({ ...current, [reviewLayerId]: candidateLabels[versions.state?.status] || '待拆分' }));
      } })
      .catch(cause => { if (!stopped) setError(`读取候选失败：${cause.message}`); })
      .finally(() => { if (!stopped) setReviewBusy(false); });
    return () => { stopped = true; };
  }, [api, document?.documentId, document?.revision, reviewLayerId]);

  useEffect(() => {
    if (!document || typeof api.getExports !== 'function') { setLatestExport(null); return undefined; }
    let alive = true;
    api.getExports(document.documentId).then(result => { if (alive) setLatestExport(result.exports?.[0] || null); })
      .catch(() => { if (alive) setLatestExport(null); });
    return () => { alive = false; };
  }, [api, document?.documentId, document?.revision]);

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

  function openCandidateReview(layerId) {
    setReviewLayerId(layerId); setReviewData(null); setSelection(layerId); setPendingCategory(null); setEditorDraft(null); setPenTarget(null); setError('');
  }

  async function refreshCandidateReview() {
    if (!document || !reviewLayerId) return;
    setReviewBusy(true); setError('');
    try {
      const [versions, composition] = await Promise.all([api.getLayerVersions(document.documentId, reviewLayerId), api.getComposition(document.documentId)]);
      setReviewData({ ...versions, composition: composition.layers || [] });
      setLayerStatusById(current => ({ ...current, [reviewLayerId]: candidateLabels[versions.state?.status] || '待拆分' }));
    } catch (cause) { setError(`刷新候选失败：${cause.message}`); }
    finally { setReviewBusy(false); }
  }

  async function adoptReviewedCandidate(versionId) {
    if (!document || !reviewLayerId || !versionId || typeof api.adoptCandidate !== 'function') return;
    setReviewBusy(true); setError('');
    try {
      const saved = await api.adoptCandidate(document.documentId, reviewLayerId, versionId, document.revision);
      setDocument(saved); setNotice('候选已采用，合成预览已更新');
    } catch (cause) { setError(`采用候选失败：${cause.message}`); }
    finally { setReviewBusy(false); }
  }

  async function retryReviewedLayer() {
    if (!document || !reviewLayerId || saving || saveActive.current || saveQueue.current.length || !api.submitBatch) return;
    setReviewBusy(true); setError('');
    try {
      const result = await api.submitBatch({ documentId: document.documentId, expectedRevision: document.revision,
        submissionKey: crypto.randomUUID().replaceAll('-', ''), mode: 'retry', layerIds: [reviewLayerId] });
      if (!result.batch.items.length) throw new Error('没有符合条件的可重试拆分项');
      setBatchState({ batchId: result.batch.batchId, status: 'ready_to_send', batch: result.batch });
      await sendBatchMessage(result.batch.batchId, result.prompt, result.batch);
      setNotice('已提交当前拆分项的明确重试请求');
    } catch (cause) { setError(`重新拆分失败：${cause.message}`); }
    finally { setReviewBusy(false); }
  }

  async function exportPsd() {
    if (!document || exporting || saving || busy || !api.exportDocumentPsd) return;
    setExporting(true); setError(''); setNotice('正在冻结当前版本并生成透明 PSD…');
    try {
      const record = await api.exportDocumentPsd(document.documentId, document.revision);
      setLatestExport({ ...record, stale: false });
      const link = window.document.createElement('a');
      link.href = api.exportUrl(document.documentId, record.exportId); link.download = `${record.exportId}.psd`;
      link.click();
      setNotice(`PSD 已生成（文档修订 r${record.documentRevision}，${record.layerCount} 个栅格图层）`);
    } catch (cause) {
      const detail = cause.message.startsWith('EXPORT_LAYER_NOT_ADOPTED:') ? `「${cause.message.split(':').slice(1).join(':')}」还没有采用当前拆分版本`
        : cause.message.startsWith('EXPORT_CANDIDATE_STALE:') ? `「${cause.message.split(':').slice(1).join(':')}」的采用版本已过期，请重新拆分并审核`
          : cause.message.includes('CANDIDATE_HASH_MISMATCH') ? '候选文件校验失败，请重新审核该拆分项'
            : cause.message;
      setError(`PSD 导出失败：${detail}`);
    }
    finally { setExporting(false); }
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

  async function submitBatch() {
    if (!document || saving || saveActive.current || saveQueue.current.length || editorDraft || busy) return;
    if (!document.layerOrder.length) { setError('请先添加至少一个拆分区域'); return; }
    setError(''); setNotice('正在冻结本次拆分清单…'); setBatchState({ status: 'sending' });
    let batchId = null;
    try {
      if (typeof api.submitBatch !== 'function') throw new Error('当前工作台接口尚未连接批次服务');
      const result = await api.submitBatch({ documentId: document.documentId, expectedRevision: document.revision,
        submissionKey: crypto.randomUUID().replaceAll('-', ''), mode: 'pending', layerIds: document.layerOrder });
      if (!result.batch.items.length) {
        setBatchState({ batchId: result.batch.batchId, status: 'complete', batch: result.batch });
        setNotice('当前修订没有新的待处理拆分项'); return;
      }
      batchId = result.batch.batchId;
      setBatchState({ batchId, status: 'ready_to_send', batch: result.batch });
      await sendBatchMessage(batchId, result.prompt, result.batch);
    } catch (cause) {
      if (batchId) await api.cancelBatch?.(batchId).catch(() => {});
      setBatchState(batchId ? { batchId, status: 'cancelled' } : null);
      setError(`拆分任务未发送：${cause.message}`);
    }
  }

  async function sendBatchMessage(batchId, prompt, batch = null) {
    setBatchState(current => ({ ...(current || {}), batchId, batch: batch || current?.batch, status: 'sending' }));
    try {
      await sendVisibleWorkbenchMessage(prompt);
      setBatchState(current => current?.batchId === batchId ? { ...current, status: 'awaiting_confirmation' } : current);
      setNotice('已请求发送；等待 Codex 当前会话确认收到消息'); setError('');
    } catch (cause) {
      await api.cancelBatch?.(batchId).catch(() => {});
      setBatchState({ batchId, status: 'cancelled', batch });
      setError(`拆分任务未发送：${cause.message}`);
    }
  }

  async function resumeBatchSend() {
    if (!batchState?.batchId || typeof api.getBatchSubmission !== 'function') return;
    try {
      const submission = await api.getBatchSubmission(batchState.batchId);
      if (!submission.prompt) { setError('该批次已离开待发送状态，请查看会话确认或取消批次'); return; }
      await sendBatchMessage(batchState.batchId, submission.prompt, submission.batch);
    } catch (cause) { setError(`无法继续发送批次：${cause.message}`); }
  }

  async function cancelBatch() {
    if (!batchState?.batchId || !api.cancelBatch) return;
    try { await api.cancelBatch(batchState.batchId); setBatchState({ ...batchState, status: 'cancelled' }); setNotice('批次已取消'); setError(''); }
    catch (cause) { setError(`取消批次失败：${cause.message}`); }
  }

  async function restartWorkbench() {
    if (saving || saveActive.current || saveQueue.current.length) { setError('请等待当前修改保存完成后再重新开始'); return; }
    setError(''); setNotice('正在取消当前会话的活动拆分项…');
    try {
      if (typeof api.restartSession !== 'function') throw new Error('当前工作台接口尚未连接会话恢复服务');
      await api.restartSession(sessionId);
      const nextSession = crypto.randomUUID().replaceAll('-', '');
      try { sessionStorage.setItem(SESSION_KEY, nextSession); sessionStorage.removeItem(DOCUMENT_KEY); } catch { /* persistence is optional */ }
      setSessionId(nextSession); setDocument(null); setSourceUrl(''); setSelection(null); setPendingCategory(null); setLayerStatusById({});
      setEditorDraft(null); setPenTarget(null); setReviewLayerId(null); setReviewData(null); setBatchState(null); saveQueue.current = [];
      setNotice('已取消旧会话任务，可以重新上传开始');
    } catch (cause) { setError(`重新开始失败：${cause.message}`); }
  }

  const viewDocument = document && selection ? { ...document, activeLayerId: selection } : document;
  return <main className="v2-workbench">
    <header className="v2-topbar">
      <button className="v2-brand" type="button" onClick={onOpenLegacy} aria-label="回到 Imvia Layer"><img className="v2-brand__mark" src="/imvia-logo.png" alt=""/><strong>IMVIA Studio · Layer</strong></button>
      <nav className="v2-tabs" aria-label="工作区"><button type="button" className="is-active"><Layers3 size={16}/>框选拆分</button><button type="button" onClick={onOpenOverview}>⌘　画布总览</button></nav>
      <div className="v2-topbar__right"><button type="button" className="v2-restart" onClick={restartWorkbench} disabled={busy||saving}><RotateCcw size={14}/>重新开始</button><span className="v2-save-state"><i className={error ? 'is-error' : ''}/>{busy ? '载入中' : error ? '需要处理' : document ? (saving ? '正在保存' : '文档已打开') : '等待上传'}</span></div>
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
    </div> : reviewLayerId && document ? <CandidateReview document={document} layerId={reviewLayerId}
      versions={reviewData?.versions || []} state={reviewData?.state || { status: 'pending', versionIds: [] }}
      composition={reviewData?.composition || []} candidateUrl={versionId => api.candidateUrl(document.documentId, reviewLayerId, versionId)}
      onBack={() => { setReviewLayerId(null); setReviewData(null); }} onAdopt={adoptReviewedCandidate}
      onRetry={retryReviewedLayer} onRefresh={refreshCandidateReview} busy={reviewBusy} /> : <>
      <div className="v2-mobile-switch"><button className={mobilePane==='canvas'?'is-active':''} onClick={()=>setMobilePane('canvas')}>原图</button><button className={mobilePane==='list'?'is-active':''} onClick={()=>setMobilePane('list')}>拆分项 {document.layerOrder.length}</button></div>
      <section className="v2-main-grid">
        <section className={`v2-source-section ${mobilePane==='list'?'is-mobile-hidden':''}`} aria-label="原图编辑">
          <header className="v2-section-heading"><div><h1>原图编辑</h1><span>{document.mode==='poster'?'海报':'H5'} · {document.source.width} × {document.source.height} px</span></div>
            <label className="v2-replace-upload"><ImagePlus size={16}/>替换原图<input type="file" accept="image/*" onChange={event=>{if(event.target.files?.[0])handleUpload(document.mode,event.target.files[0]);event.target.value='';}} /></label>
          </header>
          <DocumentCanvas document={viewDocument} sourceUrl={sourceUrl} selection={selection} onSelect={setSelection} onBoundsChange={pendingCategory?addRegion:undefined}/>
          <footer className="v2-canvas-foot"><span>{pendingCategory ? '拖动以框选，坐标与图层列表同步' : '选择右侧拆分项可定位对应区域'}</span><span>原位坐标已锁定</span></footer>
        </section>
        <LayerList document={viewDocument} statusByLayer={layerStatusById} onSelect={id=>{setSelection(id);setPendingCategory(null);setMobilePane('canvas');}}
          onEdit={openEditor} onReview={openCandidateReview}
          onAdd={armLayer} onRemove={removeSelectedLayer} onReorder={order=>{try{publishDocument(reorderLayers(document,order));}catch(cause){setError(`排序失败：${cause.message}`);}}}/>
      </section>
      <footer className="v2-bottom-actions"><div className="v2-bottom-actions__status" role={error?'alert':'status'}>{error||notice||'修改将自动保存'}</div>
        {['sending', 'awaiting_confirmation', 'confirmed', 'running'].includes(batchState?.status)
          ? <button type="button" className="v2-cancel-batch-action" onClick={cancelBatch}>取消本批次</button>
          : batchState?.status === 'ready_to_send'
            ? <button type="button" className="v2-split-action" onClick={resumeBatchSend}><Upload size={17}/>发送本批次到 Codex</button>
          : <button type="button" className="v2-split-action" disabled={saving||busy||Boolean(editorDraft)||['confirmed','running'].includes(batchState?.status)} onClick={submitBatch}><Upload size={17}/>拆分</button>}
        {latestExport && <span className="v2-export-revision" title="历史导出不会随文档修改而变化">上次 PSD · r{latestExport.documentRevision}{latestExport.stale || latestExport.documentRevision !== document.revision ? ' · 已过期' : ''}</span>}
        <button type="button" className="v2-psd-action" disabled={exporting||saving||busy||!document.layerOrder.length} onClick={exportPsd} title="仅导出所有已采用且与当前修订一致的拆分项"><Download size={17}/>{exporting?'正在生成 PSD…':'下载 PSD'}</button>
      </footer>
    </>}
  </main>;
}
