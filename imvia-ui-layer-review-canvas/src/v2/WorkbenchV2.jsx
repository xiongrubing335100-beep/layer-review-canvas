import { useEffect, useRef, useState } from 'react';
import { Download, Eye, EyeOff, ImagePlus, Layers3, LoaderCircle, Plus, Scissors, Upload, FolderInput } from 'lucide-react';
import { createDocument as newDocument, addLayer, removeLayer, reorderLayers, moveLayerRegion, applyLayerEdit } from './document.js';
import { importLegacyDocument } from './legacy-import.js';
import { createWorkbenchV2Client } from './api-client.js';
import { DocumentCanvas } from './DocumentCanvas.jsx';
import { NodeBoard } from './NodeBoard.jsx';
import { LayerList } from './LayerList.jsx';
import { LayerEditor } from './LayerEditor.jsx';
import { PenEditor } from './PenEditor.jsx';
import { CandidateReview } from './CandidateReview.jsx';
import { createEditorDraft, reduceEditorDraft, resumeEditorDraft, hasDraftChanges } from './editor-state.js';
import { candidateLabels, workflowProgress } from './result-status.js';
import { prepareSplitDocument } from './prepare-split.js';
import { recoverPendingSaves, saveDocumentRevision, readPendingSaves, writePendingSaves, pendingSaveKey } from './document-saving.js';
import { sendVisibleWorkbenchMessage } from './host-message.js';
import { BridgeConnection } from './BridgeConnection.jsx';
import { WorkbenchMoreMenu } from './WorkbenchMoreMenu.jsx';
import { readPageIdentity, persistPageIdentity } from './page-identity.js';
import './workbench-v2.css';
import './workspace-layout.css';
import './selection-chrome.css';

const SESSION_KEY = 'imvia-layer-v2-session';
const DOCUMENT_KEY = 'imvia-layer-v2-document';
const LEGACY_HISTORY_PREFIX = 'imvia-layer-v2-legacy-history-';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const defaultApi = createWorkbenchV2Client();

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

export function WorkbenchV2({ api = defaultApi }) {
  const [pageIdentity] = useState(() => typeof window === 'undefined' ? { documentId:null, workspaceId:'ssr' } : readPageIdentity(window.location.href, window.sessionStorage));
  const [workspace, setWorkspace] = useState('split');
  const [document, setDocument] = useState(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [selection, setSelection] = useState(null);
  const [regionsVisible, setRegionsVisible] = useState(true);
  const [pendingCategory, setPendingCategory] = useState(null);
  const [notice, setNotice] = useState('');
  const [error, setErrorState] = useState('');
  const setError = message => { setErrorState(message); if (message) setNotice(''); };
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [saveProblem, setSaveProblem] = useState('');
  const [mobilePane, setMobilePane] = useState('canvas');
  const [editorDraft, setEditorDraft] = useState(null);
  const [cachedDrafts, setCachedDrafts] = useState({});
  const [exportComposition, setExportComposition] = useState(null);
  const [penTarget, setPenTarget] = useState(null);
  const [reviewLayerId, setReviewLayerId] = useState(null);
  const [reviewData, setReviewData] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [validationBusy, setValidationBusy] = useState(false);
  const [validationEpoch, setValidationEpoch] = useState(0);
  const [batchState, setBatchState] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [latestExport, setLatestExport] = useState(null);
  const [legacyDocuments, setLegacyDocuments] = useState([]);
  const [legacyImageId, setLegacyImageId] = useState('');
  const [legacyHistory, setLegacyHistory] = useState([]);
  const posterInput = useRef(null); const h5Input = useRef(null); const legacySourceInput = useRef(null);
  const [sessionId, setSessionId] = useState(() => pageIdentity.workbenchSessionId || crypto.randomUUID().replaceAll('-', ''));
  const saveQueue = useRef([]);
  const saveActive = useRef(false);
  const saveRetry = useRef({ timer: null, stopped: false, conflict: false });
  const drainRef = useRef(null);
  const submissionActive = useRef(false);
  const hydrated = useRef(false);
  const activeDocumentId = useRef(null);
  activeDocumentId.current = document?.documentId;

  useEffect(() => {
    let alive = true;
    try {
      const documentId = pageIdentity.documentId;
      if (!documentId) { hydrated.current = true; return () => { alive = false; }; }
      api.getDocument(documentId).then(value => {
        if (!alive) return;
        let restored = value;
        try {
          const pending = readPendingSaves(localStorage, pageIdentity.workspaceId, value.documentId);
          const recovered = recoverPendingSaves(value, pending);
          restored = recovered.document; saveQueue.current = recovered.queue;
          writePendingSaves(localStorage, pageIdentity.workspaceId, value.documentId, recovered.queue);
          setPendingSaves(recovered.queue.length);
        } catch (cause) {
          saveRetry.current.conflict = true;
          setSaveProblem(`本地修改尚未恢复：${cause.message}。备份仍保留，可导出未同步修改。`);
        }
        setDocument(restored); setSessionId(value.workbenchSessionId); setSelection(restored.activeLayerId); setSourceUrl(api.sourceUrl(value.documentId, value.source.revision));
        try {
          const key = `imvia-v2-drafts:${pageIdentity.workspaceId}:${value.documentId}`;
          setCachedDrafts(JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || '{}'));
        } catch { setCachedDrafts({}); setError('草稿缓存暂不可读，已保存的文档不受影响'); }
        try { const history = JSON.parse(localStorage.getItem(`${LEGACY_HISTORY_PREFIX}${value.documentId}`) || '[]'); setLegacyHistory(Array.isArray(history) ? history : []); }
        catch { setLegacyHistory([]); }
        setNotice('已恢复上次编辑的文档');
      }).catch(cause => { if (alive) { sessionStorage.removeItem(DOCUMENT_KEY); setError(`恢复文档失败：${cause.message}`); } })
        .finally(() => { hydrated.current = true; });
    } catch (cause) { hydrated.current = true; if (alive) setError(cause.message); }
    return () => { alive = false; };
  }, [api]);

  const dirtyDrafts = Object.values(cachedDrafts).filter(draft => document?.layerOrder.includes(draft.layerId) && hasDraftChanges(document, draft));
  useEffect(() => {
    if (!document || !hydrated.current) return;
    try {
      const key = `imvia-v2-drafts:${pageIdentity.workspaceId}:${document.documentId}`;
      localStorage.setItem(key, JSON.stringify(cachedDrafts));
      sessionStorage.removeItem(key);
    } catch { setError('草稿暂时无法备份到本机，请点击保存后再关闭页面'); }
  }, [cachedDrafts, document?.documentId]);
  useEffect(() => {
    if (!dirtyDrafts.length && !saving && !pendingSaves && !saveProblem) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyDrafts.length, saving, pendingSaves, saveProblem]);

  useEffect(() => {
    saveRetry.current.stopped = false;
    const wake = () => { if (!saveRetry.current.conflict) drainRef.current?.(); };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      saveRetry.current.stopped = true; clearTimeout(saveRetry.current.timer);
      window.removeEventListener('online', wake); window.removeEventListener('focus', wake);
    };
  }, []);
  useEffect(() => { drainRef.current?.(); }, [document?.documentId]);

  useEffect(() => {
    if (!document || !api.getComposition) { setExportComposition(null); return; }
    let alive = true, timer;
    const refresh = async () => {
      try { const result = await api.getComposition(document.documentId); if (alive) setExportComposition(result); }
      catch { if (alive) setExportComposition(null); }
      if (alive) timer = setTimeout(refresh, 5000);
    };
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [api, document?.documentId, document?.revision, batchState?.status, validationEpoch]);

  useEffect(() => {
    if (!document || typeof api.revalidateCandidates !== 'function') return undefined;
    let alive = true;
    setValidationBusy(true);
    api.revalidateCandidates(document.documentId).then(() => { if (alive) setValidationEpoch(value => value + 1); })
      .catch(cause => { if (alive) setError(`本地补验暂不可用：${cause.message}`); })
      .finally(() => { if (alive) setValidationBusy(false); });
    return () => { alive = false; };
  }, [api, document?.documentId, document?.revision, batchState?.status]);

  useEffect(() => {
    if (!document && !hydrated.current) return;
    const href = persistPageIdentity(window.location.href, window.sessionStorage, document, pageIdentity.workspaceId, sessionId);
    window.history.replaceState(window.history.state, '', href);
  }, [document?.documentId, document?.workbenchSessionId, pageIdentity.workspaceId, sessionId]);

  useEffect(() => {
    if (!document || typeof api.getSessionBatches !== 'function') return undefined;
    let alive = true;
    api.getSessionBatches(document.workbenchSessionId).then(records => {
      if (!alive) return;
      const active = records.find(batch => batch.documentId === document.documentId && batch.status !== 'complete' && !['cancelled'].includes(batch.confirmation?.status));
      if (!active) return;
      const status = active.confirmation?.status === 'sent' ? (active.status === 'running' ? 'running' : 'confirmed')
        : !active.confirmation?.relayRequestedAt ? 'ready_to_send' : 'awaiting_confirmation';
      setBatchState(current => current || { batchId: active.batchId, status, batch: active });
    }).catch(() => {});
    return () => { alive = false; };
  }, [api, document?.documentId, document?.workbenchSessionId]);

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
          setNotice('本批次处理已结束，合格结果将自动就绪');
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

  // Candidate delivery does not write a document revision. Follow result identity
  // changes from the existing poll so an open result page never requires Refresh.
  const deliverySignature = JSON.stringify([exportComposition?.states,
    exportComposition?.layers?.map(layer => [layer.layerId, layer.versionId, layer.sha256])]);
  useEffect(() => {
    if (!document || !reviewLayerId || typeof api.getLayerVersions !== 'function') return undefined;
    let stopped = false;
    setReviewBusy(true);
    Promise.all([api.getLayerVersions(document.documentId, reviewLayerId), api.getComposition?.(document.documentId) || Promise.resolve({ layers: [] })])
      .then(([versions, composition]) => { if (!stopped) {
        setReviewData({ ...versions, composition: composition.layers || [] });
      } })
      .catch(cause => { if (!stopped) setError(`读取候选失败：${cause.message}`); })
      .finally(() => { if (!stopped) setReviewBusy(false); });
    return () => { stopped = true; };
  }, [api, document?.documentId, document?.revision, reviewLayerId, batchState?.status, validationEpoch, deliverySignature]);

  useEffect(() => {
    if (!document || typeof api.getExports !== 'function') { setLatestExport(null); return undefined; }
    let alive = true;
    api.getExports(document.documentId).then(result => { if (alive) setLatestExport(result.exports?.[0] || null); })
      .catch(() => { if (alive) setLatestExport(null); });
    return () => { alive = false; };
  }, [api, document?.documentId, document?.revision, validationEpoch, batchState?.status, deliverySignature]);

  const drainSaveQueue = () => {
    if (saveRetry.current.stopped || saveRetry.current.conflict || saveActive.current || !saveQueue.current.length) return;
    clearTimeout(saveRetry.current.timer);
    saveActive.current = true;
    setSaving(true);
    const next = saveQueue.current[0];
    let succeeded = false;
    saveDocumentRevision(api, next).then(() => {
      if (saveRetry.current.stopped) return;
      const remaining = saveQueue.current.slice(1);
      writePendingSaves(localStorage, pageIdentity.workspaceId, next.documentId, remaining);
      saveQueue.current = remaining; setPendingSaves(remaining.length);
      setSaveProblem(''); succeeded = true;
      if (!remaining.length) setNotice('文档已保存');
    }).catch(cause => {
      if (saveRetry.current.stopped) return;
      saveRetry.current.conflict = /SAVE_CONFLICT|SAVE_RESPONSE_MISMATCH/.test(cause.message);
      setSaveProblem(saveRetry.current.conflict
        ? '此文档在另一窗口已变化，未覆盖任一版本。本地修改已保留，可导出未同步修改。'
        : '修改已保留在本机，暂未同步。连接恢复后会自动重试。');
    }).finally(() => {
      saveActive.current = false;
      if (saveRetry.current.stopped) return;
      setSaving(false);
      if (succeeded) drainRef.current?.();
      else if (!saveRetry.current.conflict) saveRetry.current.timer = setTimeout(() => drainRef.current?.(), 5000);
    });
  };
  drainRef.current = drainSaveQueue;

  async function retryPendingSaves() {
    if (!document || saveActive.current) return;
    setSaving(true);
    try {
      const server = await api.getDocument(document.documentId);
      const pending = saveQueue.current.length ? saveQueue.current : readPendingSaves(localStorage, pageIdentity.workspaceId, document.documentId);
      const recovered = recoverPendingSaves(server, pending);
      writePendingSaves(localStorage, pageIdentity.workspaceId, document.documentId, recovered.queue);
      saveQueue.current = recovered.queue; setPendingSaves(recovered.queue.length); setDocument(recovered.document);
      saveRetry.current.conflict = false; setSaveProblem('');
      drainSaveQueue();
    } catch (cause) { setSaveProblem(`未同步修改仍已保留：${cause.message}。可导出备份。`); }
    finally { if (!saveActive.current) setSaving(false); }
  }

  function downloadUnsyncedEdits() {
    try {
      // Even an unreadable journal must remain downloadable for recovery.
      const payload = saveQueue.current.length ? JSON.stringify(saveQueue.current, null, 2)
        : localStorage.getItem(pendingSaveKey(pageIdentity.workspaceId, document.documentId)) || '[]';
      const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      const link = window.document.createElement('a'); link.href = url; link.download = `imvia-unsynced-${document.documentId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(`无法导出未同步修改：${cause.message}`); }
  }

  function publishDocument(next) {
    if (saveRetry.current.conflict) throw new Error('请先处理未同步的修改');
    const pending = [...saveQueue.current, next];
    // Persist before painting: never show an edit that cannot survive refresh.
    writePendingSaves(localStorage, pageIdentity.workspaceId, next.documentId, pending);
    saveQueue.current = pending; setPendingSaves(pending.length);
    setDocument(next);
    setNotice('正在保存…'); drainSaveQueue();
  }

  async function handleUpload(mode, file) {
    if (!file) return;
    setBusy(true); setError(''); setNotice('正在准备原图…'); setPendingCategory(null);
    try {
      const png = await normalizeImage(file);
      const created = await api.createDocument({ mode, file: png, workbenchSessionId: sessionId });
      hydrated.current = true;
      saveQueue.current = []; setDocument(created); setSelection(null); setSourceUrl(api.sourceUrl(created.documentId, created.source.revision));
      setCachedDrafts({}); setEditorDraft(null); setPenTarget(null);
      setBatchState(null); setReviewLayerId(null); setReviewData(null); setLatestExport(null);
      setLegacyHistory([]);
      try { sessionStorage.setItem(DOCUMENT_KEY, created.documentId); } catch { /* session persistence is optional */ }
      setNotice('原图已载入，可以添加拆分区域'); setMobilePane('canvas');
    } catch (cause) { setError(`载入失败：${cause.message}`); setNotice(''); }
    finally { setBusy(false); }
  }

  async function handleReplaceSource(file) {
    if (!file || !document || busy || saving || saveProblem || saveActive.current || saveQueue.current.length || batchInProgress || exporting) return;
    const originDocumentId = document.documentId;
    setBusy(true); setError(''); setNotice('正在替换原图，保留拆分项…'); setPendingCategory(null);
    try {
      const png = await normalizeImage(file);
      let current = document;
      // Persist retained edits against the old coordinate system before remapping them.
      // Invalid/unfinished drafts abort replacement instead of being silently discarded.
      for (const draft of dirtyDrafts) {
        current = await prepareSplitDocument(current, draft, next => saveDocumentRevision(api, next));
        if (activeDocumentId.current !== originDocumentId) return;
        setDocument(current); discardCachedDraft(draft.layerId);
      }
      const next = await api.replaceSource(originDocumentId, png, current.revision);
      if (activeDocumentId.current !== originDocumentId) return;
      const resized = next.source.width !== current.source.width || next.source.height !== current.source.height;
      setDocument(next); setSourceUrl(api.sourceUrl(next.documentId, next.source.revision));
      setCachedDrafts({}); setEditorDraft(null); setPenTarget(null); setReviewData(null); setExportComposition(null);
      setNotice(`原图已替换 · 保留 ${next.layerOrder.length} 个拆分项${resized ? ' · 选区已按比例调整，请复核' : ''}${Object.values(next.layers).some(layer => layer.acceptedVersionId) ? ' · 旧结果已过期' : ''}`);
    } catch (cause) {
      setError(`替换原图失败，原图和拆分项已保留：${cause.message}`);
    } finally { setBusy(false); }
  }

  function openLegacyImport() {
    setWorkspace('split');
    setError('');
    try {
      // This legacy key is read only after an explicit user click; no project is auto-imported.
      const stored = JSON.parse(localStorage.getItem('imvia-layer-project') || 'null');
      const images = Object.entries(stored?.images || {}).map(([imageId, image]) => ({ ...image, imageId }));
      if (!images.length) throw new Error('没有找到旧版项目记录');
      setLegacyDocuments(images); setLegacyImageId(stored.activeImageId && stored.images?.[stored.activeImageId]
        ? stored.activeImageId : images[0].imageId);
      setNotice(`找到 ${images.length} 个旧版项目；请选择项目并重新选择匹配的原图`);
    } catch (cause) { setError(`无法读取旧版项目：${cause.message}`); }
  }

  async function importSelectedLegacySource(file) {
    const legacyDocument = legacyDocuments.find(value => value.imageId === legacyImageId);
    if (!legacyDocument || !file) return;
    setBusy(true); setError(''); setNotice('正在核对旧版原图并迁移拆分定义…');
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('无法读取所选原图')); reader.readAsDataURL(file);
      });
      const legacyFingerprint = `${file.name}:${file.size}:${file.lastModified || 0}:${dataUrl.length}`;
      if (legacyFingerprint !== legacyDocument.sourceFingerprint) throw new Error('所选文件与旧版原图记录不匹配，请选择当时使用的原始文件');
      const png = await normalizeImage(file);
      const created = await api.createDocument({ mode: legacyDocument.documentMode === 'poster' ? 'poster' : 'h5', file: png, workbenchSessionId: sessionId });
      const imported = importLegacyDocument({ legacyDocument, newDocumentId: created.documentId,
        verifiedAssets: { workbenchSessionId: sessionId,
          source: { ...created.source, legacyFingerprint } } });
      const saved = await api.saveDocument({ ...imported.document, revision: created.revision + 1 }, created.revision);
      hydrated.current = true; saveQueue.current = []; setDocument(saved); setSelection(saved.activeLayerId);
      setSourceUrl(api.sourceUrl(saved.documentId, saved.source.revision)); setReviewLayerId(null); setReviewData(null); setBatchState(null);
      setLegacyHistory(imported.history);
      try { localStorage.setItem(`${LEGACY_HISTORY_PREFIX}${saved.documentId}`, JSON.stringify(imported.history)); } catch { /* history is also returned in this session */ }
      try { sessionStorage.setItem(DOCUMENT_KEY, saved.documentId); } catch { /* session persistence is optional */ }
      const pendingArtifacts = imported.history.filter(item => item.artifactPresent).length;
      const acceptedMarkers = imported.history.length - pendingArtifacts;
      const historyNote = imported.history.length
        ? `；${pendingArtifacts} 个旧版结果文件待人工复核，${acceptedMarkers} 个旧版“已确认”标记没有对应可导入图像文件` : '';
      setNotice(`已迁移 ${saved.layerOrder.length} 个拆分定义${historyNote}${imported.warnings.length ? `。${imported.warnings.join(' ')}` : ''}`);
      setLegacyDocuments([]); setLegacyImageId(''); setMobilePane('canvas');
    } catch (cause) { setError(`旧版迁移失败：${cause.message}`); }
    finally { setBusy(false); }
  }

  function armLayer(definition) {
    if (!document) return;
    setRegionsVisible(true);
    setPendingCategory(definition); setSelection(null); setMobilePane('canvas');
    setNotice(`请在原图上拖出「${definition.displayCategory}」区域`); setError('');
  }

  function addRegion(bounds) {
    if (!document || !pendingCategory) return;
    const count = Object.values(document.layers).filter(layer => layer.displayCategory === pendingCategory.displayCategory).length;
    const name = count ? `${pendingCategory.displayCategory} ${count + 1}` : pendingCategory.displayCategory;
    const layerId = crypto.randomUUID().replaceAll('-', '');
    try {
      const next = addLayer(document, { layerId, name, ...pendingCategory, bounds, paths: [] });
      publishDocument(next); setSelection(layerId); setPendingCategory(null); setNotice(`已添加「${name}」`); setMobilePane('list');
    } catch (cause) { setError(`无法添加区域：${cause.message}`); }
  }

  function removeSelectedLayer(layerId) {
    try { const next = removeLayer(document, layerId); publishDocument(next); setSelection(next.activeLayerId); discardCachedDraft(layerId); }
    catch (cause) { setError(`移除失败：${cause.message}`); }
  }

  function moveRegion(layerId, delta) {
    try {
      const next = moveLayerRegion(document, layerId, delta);
      if (next !== document) { publishDocument(next); setNotice('选区位置已更新，尺寸保持不变'); }
    } catch (cause) { setError(`移动选区失败：${cause.message}`); }
  }

  function resizeRegion(layerId, bounds) {
    if (Object.keys(bounds).every(key => bounds[key] === document.layers[layerId].bounds[key])) return;
    try { publishDocument(applyLayerEdit(document, layerId, { bounds })); setNotice('选区尺寸已更新，原图像素保持不变'); }
    catch (cause) { setError(`调整选区失败：${cause.message}`); }
  }

  function openEditor(layerId) {
    try {
      const draft = resumeEditorDraft(document, layerId, editorDraft?.layerId === layerId ? editorDraft : cachedDrafts[layerId]);
      setWorkspace('split');
      setEditorDraft(draft); setReviewLayerId(null);
      setSelection(layerId); setPendingCategory(null); setPenTarget(null); setError('');
    } catch (cause) { setError(`无法打开编辑器：${cause.message}`); }
  }

  function updateEditorDraft(event) {
    if (saving) return;
    const next = reduceEditorDraft(editorDraft, event);
    // Write in the interaction, not only an effect: an immediate close/reload
    // after typing must not drop the last edit.
    try { localStorage.setItem(`imvia-v2-drafts:${pageIdentity.workspaceId}:${document.documentId}`, JSON.stringify({ ...cachedDrafts, [next.layerId]: next })); }
    catch { setError('草稿暂时无法备份到本机，请点击保存后再关闭页面'); return; }
    setEditorDraft(next); setCachedDrafts(current => ({ ...current, [next.layerId]: next }));
    setError('');
  }

  function leaveEditor() {
    if (saving) return;
    setEditorDraft(null); setPenTarget(null);
  }

  function discardCachedDraft(layerId) {
    setCachedDrafts(current => { const next = { ...current }; delete next[layerId]; return next; });
  }

  function openCandidateReview(layerId) {
    setWorkspace('split');
    setReviewLayerId(layerId); setReviewData(null); setSelection(layerId); setPendingCategory(null); setEditorDraft(null); setPenTarget(null); setError('');
  }

  async function refreshCandidateReview() {
    if (!document || !reviewLayerId) return;
    setReviewBusy(true); setError('');
    try {
      const [versions, composition] = await Promise.all([api.getLayerVersions(document.documentId, reviewLayerId), api.getComposition(document.documentId)]);
      setReviewData({ ...versions, composition: composition.layers || [] });
      setExportComposition(composition);
    } catch (cause) { setError(`刷新候选失败：${cause.message}`); }
    finally { setReviewBusy(false); }
  }

  async function adoptReviewedCandidate(versionId) {
    if (!document || saving || pendingSaves || saveProblem || !reviewLayerId || !versionId || typeof api.adoptCandidate !== 'function') return;
    setReviewBusy(true); setError('');
    try {
      const saved = await api.adoptCandidate(document.documentId, reviewLayerId, versionId, document.revision);
      setDocument(saved); setNotice('当前结果版本已切换');
    } catch (cause) { setError(`切换结果版本失败：${cause.message}`); }
    finally { setReviewBusy(false); }
  }

  async function retryCandidateValidation() {
    if (!document || !reviewLayerId || validationBusy) return;
    const documentId = document.documentId;
    setValidationBusy(true); setError('');
    try {
      await api.revalidateCandidates(documentId, { layerId: reviewLayerId, retry: true });
      if (activeDocumentId.current === documentId) setValidationEpoch(value => value + 1);
    } catch (cause) { if (activeDocumentId.current === documentId) setError(`本地补验失败：${cause.message}`); }
    finally { if (activeDocumentId.current === documentId) setValidationBusy(false); }
  }

  async function retryReviewedLayer() {
    if (!reviewLayerId) return;
    setReviewBusy(true);
    try { await submitBatch([reviewLayerId]); setReviewLayerId(null); setReviewData(null); }
    finally { setReviewBusy(false); }
  }

  async function exportPsd() {
    if (!document || exporting || saving || pendingSaves || saveProblem || busy || dirtyDrafts.length || !exportStatus.ready || !api.exportDocumentPsd) return;
    setExporting(true); setError(''); setNotice('');
    try {
      const record = await api.exportDocumentPsd(document.documentId, document.revision);
      setLatestExport({ ...record, stale: false });
      const link = window.document.createElement('a');
      link.href = api.exportUrl(document.documentId, record.exportId); link.download = `${record.exportId}.psd`;
      link.click();
      setNotice(`已请求浏览器下载 PSD（r${record.documentRevision}，${record.layerCount} 个栅格图层${record.reused ? ' · 使用已生成文件' : ''}）`);
    } catch (cause) {
      const detail = cause.message.startsWith('EXPORT_LAYER_NOT_READY:') ? `「${cause.message.split(':').slice(1).join(':')}」还没有达到交付标准的当前结果`
        : cause.message.startsWith('EXPORT_CANDIDATE_STALE:') ? `「${cause.message.split(':').slice(1).join(':')}」的结果已过期，需要重新处理`
          : cause.message.includes('CANDIDATE_HASH_MISMATCH') ? '结果文件校验失败，已停止导出'
            : cause.message.includes('EXPORT_CANDIDATE_GEOMETRY_UNVERIFIED') ? '候选蒙版未通过当前的原图轮廓校验，不能作为合格结果导出。历史文件已保留。'
            : cause.message.includes('PSD_MEMORY_LIMIT') ? '当前可用内存不足以生成新的 PSD。请关闭占用内存较大的应用后重试；已有导出文件不会被删除。'
            : cause.message;
      setError(`PSD 导出失败：${detail}`);
    }
    finally { setExporting(false); }
  }

  function cancelEditor() {
    if (saving) return;
    discardCachedDraft(editorDraft.layerId);
    setEditorDraft(null); setPenTarget(null); setNotice('已放弃本次未保存修改');
  }

  async function finishEditor(keepOpen = false) {
    if (saving || !editorDraft) return;
    if (saveProblem || saveActive.current || saveQueue.current.length) { setError('请等待文档保存完成后再保存当前编辑'); return; }
    const currentDraft = editorDraft;
    setSaving(true); setError('');
    try {
      const next = await prepareSplitDocument(document, currentDraft, value => saveDocumentRevision(api, value));
      if (activeDocumentId.current !== next.documentId) return;
      setDocument(next); discardCachedDraft(currentDraft.layerId);
      setSelection(currentDraft.layerId);
      setEditorDraft(keepOpen ? { ...createEditorDraft(next, currentDraft.layerId), penSessions: currentDraft.penSessions } : null);
      if (!keepOpen) setPenTarget(null);
      setNotice(next === document ? '没有新的修改' : '当前拆分项已保存'); setError('');
    } catch (cause) { setError(`保存拆分项失败：${cause.message}`); }
    finally { setSaving(false); }
  }

  async function submitBatch(layerIds = document?.layerOrder) {
    if (!document || saving || saveProblem || saveActive.current || saveQueue.current.length || (editorDraft && workspace !== 'overview') || busy || submissionActive.current || batchInProgress) return;
    if (!layerIds?.length) { setError('请先添加至少一个拆分区域'); return; }
    submissionActive.current = true;
    setError(''); setNotice(`正在准备 ${layerIds.length} 个拆分项…`); setBatchState({ status: 'sending' });
    let batchId = null;
    const originDocumentId = document.documentId;
    try {
      if (typeof api.submitBatch !== 'function') throw new Error('当前工作台接口尚未连接批次服务');
      let submissionDocument = document;
      const draftsToSave = dirtyDrafts.filter(draft => layerIds.includes(draft.layerId));
      if (draftsToSave.length) {
        setSaving(true);
        try {
          for (const draft of draftsToSave) {
            submissionDocument = await prepareSplitDocument(submissionDocument, draft, next => saveDocumentRevision(api, next));
            setDocument(submissionDocument); discardCachedDraft(draft.layerId);
          }
          if (activeDocumentId.current !== originDocumentId) return;
          setDocument(submissionDocument);
          setEditorDraft(current => current === editorDraft ? null : current); setPenTarget(null);
        } finally { setSaving(false); }
      }
      const result = await api.submitBatch({ documentId: submissionDocument.documentId, expectedRevision: submissionDocument.revision,
        submissionKey: crypto.randomUUID().replaceAll('-', ''), mode: 'retry', layerIds });
      if (activeDocumentId.current !== originDocumentId) return;
      if (!result.batch.items.length) {
        setBatchState({ batchId: result.batch.batchId, status: 'complete', batch: result.batch });
        setNotice('当前修订没有新的待处理拆分项'); return;
      }
      batchId = result.batch.batchId;
      setBatchState({ batchId, status: 'ready_to_send', batch: result.batch });
      await sendBatchMessage(batchId, result.prompt, result.batch);
    } catch (cause) {
      if (activeDocumentId.current !== originDocumentId) return;
      setBatchState(batchId ? { batchId, status: 'ready_to_send' } : null);
      setError(`拆分任务未发送：${cause.message}`);
    } finally { submissionActive.current = false; }
  }

  async function sendBatchMessage(batchId, prompt, batch = null) {
    const originDocumentId = batch?.documentId || document?.documentId;
    if (activeDocumentId.current !== originDocumentId) return;
    setBatchState(current => ({ ...(current || {}), batchId, batch: batch || current?.batch, status: 'sending' }));
    try {
      const sent = await sendVisibleWorkbenchMessage(prompt, globalThis, { batchId, queueRelay: id => api.queueRelay(id, pageIdentity.workspaceId) });
      if (activeDocumentId.current !== originDocumentId) return;
      setBatchState(current => current?.batchId === batchId ? { ...current, status: 'awaiting_confirmation' } : current);
      setNotice(sent.requiresManualConfirmation ? '该批次此前已交给桥接卡片，但尚无送达回执。请在当前桥接卡片点击“重新请求发送确认”；不会自动重复发送。' : sent.queued ? '已交给当前会话桥；请在 Codex 发送弹窗中确认。尚未确认送达。' : '已请求发送；等待 Codex 当前会话确认收到消息'); setError('');
    } catch (cause) {
      if (activeDocumentId.current !== originDocumentId) return;
      setBatchState(current => ({ ...current, batchId, status: 'ready_to_send', batch: batch || current?.batch }));
      setError(cause.message === 'V2_BRIDGE_NOT_CONNECTED'
        ? 'V2 会话桥未连接。请在当前 Codex 对话打开 V2 会话桥，然后点击“发送本批次到 Codex”。当前批次已保留，未执行。'
        : `拆分任务未发送：${cause.message}。批次已保留，可取消或继续发送。`);
    }
  }

  async function resumeBatchSend() {
    if (!batchState?.batchId || typeof api.getBatchSubmission !== 'function') return;
    const originDocumentId = document.documentId;
    try {
      const submission = await api.getBatchSubmission(batchState.batchId);
      if (activeDocumentId.current !== originDocumentId || submission.batch.documentId !== originDocumentId) return;
      if (!submission.prompt) { setError('该批次已离开待发送状态，请查看会话确认或取消批次'); return; }
      await sendBatchMessage(batchState.batchId, submission.prompt, submission.batch);
    } catch (cause) { if (activeDocumentId.current === originDocumentId) setError(`无法继续发送批次：${cause.message}`); }
  }

  async function cancelBatch() {
    if (!batchState?.batchId || !api.cancelBatch) return;
    try { await api.cancelBatch(batchState.batchId); setBatchState({ ...batchState, status: 'cancelled' }); setNotice('批次已取消'); setError(''); }
    catch (cause) { setError(`取消批次失败：${cause.message}`); }
  }

  async function restartWorkbench() {
    if (saving || saveProblem || saveActive.current || saveQueue.current.length) { setError('请等待当前修改保存完成后再重新开始'); return; }
    setError(''); setNotice('正在取消当前会话的活动拆分项…');
    try {
      if (typeof api.restartSession !== 'function') throw new Error('当前工作台接口尚未连接会话恢复服务');
      await api.restartSession(sessionId);
      const nextSession = crypto.randomUUID().replaceAll('-', '');
      try { sessionStorage.setItem(SESSION_KEY, nextSession); sessionStorage.removeItem(DOCUMENT_KEY); } catch { /* persistence is optional */ }
      window.history.replaceState(window.history.state, '', persistPageIdentity(window.location.href, window.sessionStorage, null, pageIdentity.workspaceId, nextSession));
      setSessionId(nextSession); setWorkspace('split'); setDocument(null); setSourceUrl(''); setSelection(null); setPendingCategory(null);
      setEditorDraft(null); setCachedDrafts({}); setPenTarget(null); setReviewLayerId(null); setReviewData(null); setBatchState(null); setLegacyHistory([]); saveQueue.current = [];
      setNotice('已取消旧会话任务，可以重新上传开始');
    } catch (cause) { setError(`重新开始失败：${cause.message}`); }
  }

  const viewDocument = document && selection ? { ...document, activeLayerId: selection } : document;
  const batchInProgress = ['sending', 'ready_to_send', 'awaiting_confirmation', 'confirmed', 'running'].includes(batchState?.status);
  const splitDisabled = saving || pendingSaves > 0 || Boolean(saveProblem) || busy || Boolean(editorDraft) || batchInProgress;
  const exportStatus = workflowProgress(document, exportComposition);
  const layerStatusById = exportComposition?.documentId === document?.documentId && exportComposition?.documentRevision === document?.revision
    ? Object.fromEntries(Object.entries(exportComposition?.states || {}).map(([id, state]) => [id, candidateLabels[state.status] || '状态待检查'])) : {};
  const stageHint = saveProblem ? '修改尚未同步，恢复后继续'
    : saving || pendingSaves ? '正在保存修改…'
    : dirtyDrafts.length ? '有未保存修改，请进入编辑保存；开始拆分时也会自动保存'
    : !document?.layerOrder.length ? '添加选区后开始拆分'
    : exportStatus.checking ? '正在检查拆分结果…'
      : exportStatus.ready ? `全部 ${exportStatus.total} 项已完成，可以下载 PSD`
        : [exportStatus.splitIds.length && `待拆分 ${exportStatus.splitIds.length}`,
          exportStatus.processingIds.length && `处理中 ${exportStatus.processingIds.length}`,
          exportStatus.validationIds.length && `${validationBusy ? '正在补验' : '待补验'} ${exportStatus.validationIds.length}`,
          exportStatus.attentionIds.length && `未完成 ${exportStatus.attentionIds.length}`,
          `已完成 ${exportStatus.adopted}/${exportStatus.total}`].filter(Boolean).join(' · ');
  return <main className="v2-workbench" aria-busy={busy} inert={busy || undefined}>
    <header className="v2-topbar">
      <button className="v2-brand" type="button" onClick={() => setWorkspace('split')} aria-label="回到 Imvia Layer"><img className="v2-brand__mark" src="/imvia-logo.png" alt=""/><strong>IMVIA Studio · Layer</strong></button>
      <nav className="v2-tabs" aria-label="工作区"><button type="button" className={workspace==='split'?'is-active':''} aria-pressed={workspace==='split'} onClick={()=>setWorkspace('split')}><Layers3 size={16}/>框选拆分</button><button type="button" className={workspace==='overview'?'is-active':''} aria-pressed={workspace==='overview'} onClick={()=>{setWorkspace('overview');setPendingCategory(null);}}>⌘　画布总览</button></nav>
      <div className="v2-topbar__right"><BridgeConnection key={document?.documentId || 'empty'} api={api} documentId={document?.documentId} workspaceId={pageIdentity.workspaceId}/><button type="button" className="v2-topbar-action v2-topbar-action--new" aria-label="新建空白任务" title="结束当前任务并进入空白工作台，已保存的文件保留" onClick={restartWorkbench} disabled={busy||saving||pendingSaves>0||Boolean(saveProblem)}><Plus size={16}/><span>新建</span></button><span className="v2-save-state">{busy ? '载入中' : saveProblem ? '未同步' : document ? (saving || pendingSaves ? '正在保存' : dirtyDrafts.length ? '有未保存修改' : '已保存') : '等待上传'}</span>{!document && <WorkbenchMoreMenu onImportLegacy={openLegacyImport} disabled={busy||saving}/>}</div>
    </header>

    {saveProblem && <div className="v2-save-recovery" role="alert"><span>{saveProblem}</span>
      <button type="button" disabled={saving} onClick={retryPendingSaves}>重试保存</button>
      <button type="button" onClick={downloadUnsyncedEdits}>导出未同步修改</button>
    </div>}

    {workspace==='overview' ? <><NodeBoard key={`${sessionId}:${document?.documentId || 'empty'}`} document={document} sourceUrl={sourceUrl}
      workspaceId={pageIdentity.workspaceId} sessionId={sessionId} api={api} busy={busy} splitDisabled={saving || pendingSaves>0 || Boolean(saveProblem) || busy || batchInProgress}
      onUpload={handleUpload} onSelect={setSelection} onOpenSource={()=>{setEditorDraft(null);setPenTarget(null);setReviewLayerId(null);setWorkspace('split');}}
      onEdit={id=>{setWorkspace('split');setReviewLayerId(null);openEditor(id);}}
      onReview={id=>{setEditorDraft(null);setPenTarget(null);setWorkspace('split');openCandidateReview(id);}} onSplit={id=>submitBatch([id])}
      onAdd={category=>{setEditorDraft(null);setPenTarget(null);setReviewLayerId(null);setWorkspace('split');armLayer(category);}}/>
      {error||notice||exporting?<div className="v2-board-message" role={error?'alert':'status'}>{error||(exporting ? '正在生成 PSD…' : notice)}</div>:null}
      {batchState?.status==='ready_to_send'?<button className="v2-board-send" type="button" onClick={()=>setWorkspace('split')}>返回框选拆分，确认发送本批次</button>:null}
    </> : !document ? <section className="v2-empty" aria-label="上传原图">
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
      <input ref={legacySourceInput} type="file" accept="image/*" hidden onChange={event=>{importSelectedLegacySource(event.target.files?.[0]);event.target.value='';}} />
      {legacyDocuments.length > 0 && <div className="v2-legacy-import" role="group" aria-label="导入旧版项目">
        <label>选择旧版项目<select value={legacyImageId} onChange={event=>setLegacyImageId(event.target.value)}>
          {legacyDocuments.map(item=><option key={item.imageId} value={item.imageId}>{item.sourceName || item.imageId} · {item.nodes?.length || 0} 项</option>)}
        </select></label>
        <button type="button" disabled={busy||!legacyImageId} onClick={()=>legacySourceInput.current?.click()}><FolderInput size={15}/>选择匹配原图并迁移</button>
        <small>只复制类别、名称和原位框选；旧候选不会自动采用。</small>
        <button type="button" className="v2-legacy-import__cancel" onClick={()=>{setLegacyDocuments([]);setLegacyImageId('');setNotice('');}}>取消</button>
      </div>}
      {error ? <p className="v2-notice v2-notice--error" role="alert">{error}</p> : notice ? <p className="v2-notice">{notice}</p> : null}
    </section> : <>{editorDraft ? <div className="v2-editor-stage" inert={saving || undefined} style={workspace==='overview'?{display:'none'}:undefined}>
      {penTarget ? <PenEditor source={editorDraft.source} sourceUrl={sourceUrl} draft={editorDraft} target={penTarget}
        onChange={updateEditorDraft} onClose={() => setPenTarget(null)} onSave={() => finishEditor(true)}
        dirty={hasDraftChanges(document, editorDraft)} saving={saving} saveError={error} />
        : <LayerEditor document={document} sourceUrl={sourceUrl} draft={editorDraft}
          onChange={updateEditorDraft} onDone={() => finishEditor()} onCancel={cancelEditor} onBack={leaveEditor} onOpenPen={setPenTarget} saving={saving} saveError={error} />}
    </div> : null}{(!editorDraft || workspace==='overview') && (reviewLayerId && workspace==='split' ? <CandidateReview key={`${reviewLayerId}:${validationEpoch}`} document={document} layerId={reviewLayerId}
      versions={reviewData?.versions || []} state={reviewData?.state || { status: 'pending', versionIds: [] }}
      composition={reviewData?.composition || []} sourceUrl={sourceUrl} candidateUrl={versionId => api.candidateUrl(document.documentId, reviewLayerId, versionId)}
      onBack={() => { setReviewLayerId(null); setReviewData(null); }} onAdopt={adoptReviewedCandidate}
      onRetry={retryReviewedLayer} onRefresh={refreshCandidateReview} onRevalidate={retryCandidateValidation}
      validating={validationBusy} busy={reviewBusy || batchInProgress || validationBusy} /> : <>
      <div className="v2-mobile-switch"><button className={mobilePane==='canvas'?'is-active':''} onClick={()=>setMobilePane('canvas')}>原图</button><button className={mobilePane==='list'?'is-active':''} onClick={()=>setMobilePane('list')}>拆分项 {document.layerOrder.length}</button></div>
      <section className="v2-main-grid">
        <section className={`v2-source-section ${mobilePane==='list'?'is-mobile-hidden':''}`} aria-label={workspace==='overview'?'画布总览':'原图编辑'}>
          <header className="v2-section-heading"><div><h1>{workspace==='overview'?'画布总览':'原图'}</h1><span>{document.source.width} × {document.source.height}{workspace==='overview'?` · ${document.layerOrder.length} 个拆分项`:''}</span></div>
            {workspace==='split' && <div className="v2-source-actions">
              <button type="button" className="v2-regions-toggle" aria-label={regionsVisible ? '隐藏全部选区' : '显示全部选区'} aria-pressed={!regionsVisible} onClick={()=>{setRegionsVisible(value=>!value);setPendingCategory(null);}} title="仅隐藏或显示选区边框、名称和控制点，不删除选区">
                {regionsVisible ? <EyeOff size={14}/> : <Eye size={14}/>}{regionsVisible ? '隐藏选区' : '显示选区'}
              </button>
              <label className="v2-replace-upload" title={batchInProgress ? '请等待当前拆分结束，或取消批次后再替换' : '仅替换当前图片，保留拆分项和处理要求；旧图结果将过期'}><ImagePlus size={16}/>{busy ? '正在替换…' : '替换原图'}<input aria-label="替换原图" type="file" accept="image/*" disabled={busy||saving||batchInProgress||exporting} onChange={event=>{handleReplaceSource(event.target.files?.[0]);event.target.value='';}} /></label>
            </div>}
          </header>
          <DocumentCanvas document={viewDocument} sourceUrl={sourceUrl} selection={selection} regionsVisible={regionsVisible} onSelect={setSelection} onBoundsChange={workspace==='split'&&pendingCategory?addRegion:undefined} onRegionMove={workspace==='split'?moveRegion:undefined} onRegionResize={workspace==='split'?resizeRegion:undefined}/>
          <footer className={`v2-canvas-foot ${pendingCategory ? '' : 'v2-canvas-foot--quiet'}`} title="拖动框内移动，拖动边角调整大小；按原图坐标保存"><span>{!regionsVisible?'选区已隐藏 · 数据保留，显示后可继续调整':workspace==='overview'?'当前原图与全部选区 · 切回框选拆分可调整范围':pendingCategory ? '拖动以框选，坐标与图层列表同步' : '拖动框内移动，拖动四角或边点调整大小'}</span><span>按原图坐标保存</span></footer>
        </section>
        <LayerList document={viewDocument} statusByLayer={layerStatusById} adoptedCount={exportStatus.adopted} onSelect={id=>{setSelection(id);setPendingCategory(null);setMobilePane('canvas');}}
          onEdit={openEditor} onReview={openCandidateReview}
          onSplit={id => submitBatch([id])} splitDisabled={splitDisabled}
          onAdd={(...args)=>{setWorkspace('split');armLayer(...args);}} onRemove={removeSelectedLayer} onReorder={order=>{try{publishDocument(reorderLayers(document,order));}catch(cause){setError(`排序失败：${cause.message}`);}}}/>
      </section>
      <footer className="v2-bottom-actions"><div className="v2-bottom-actions__status" role={error?'alert':'status'} title={notice || undefined}>{error || (exporting ? '正在生成 PSD…' : (busy || batchInProgress || notice.startsWith('原图已替换')) && notice ? notice : stageHint)}</div>
        {legacyHistory.length > 0 && <span className="v2-legacy-history-indicator" title="旧版记录未导入当前候选，也未采用">{legacyHistory.length} 条旧版审核记录</span>}
        {['sending', 'awaiting_confirmation', 'confirmed', 'running'].includes(batchState?.status)
          ? <button type="button" className="v2-cancel-batch-action" onClick={cancelBatch}>取消本批次</button>
          : batchState?.status === 'ready_to_send'
            ? <><button type="button" className="v2-cancel-batch-action" onClick={cancelBatch}>取消本批次</button><button type="button" className="v2-split-action" onClick={resumeBatchSend}><Scissors size={17}/>发送本批次到 Codex</button></>
          : exportStatus.splitIds.length > 0 ? <button type="button" className="v2-split-action" disabled={splitDisabled || exportStatus.checking} onClick={() => submitBatch(exportStatus.splitIds)} title="仅发送待拆分项，不重复处理已完成的结果"><Scissors size={17}/>{exportStatus.splitIds.length === document.layerOrder.length ? '全部拆分' : '拆分待处理'}（{exportStatus.splitIds.length}）</button> : null}
        {latestExport && <span className="v2-export-revision" title="历史导出不会随文档修改而变化">上次 PSD · r{latestExport.documentRevision}{latestExport.stale || latestExport.documentRevision !== document.revision ? ' · 已过期' : ''}</span>}
        {exportStatus.attentionIds.length > 0 ? <button type="button" className="v2-export-readiness" onClick={() => openCandidateReview(exportStatus.attentionIds[0])} disabled={saving}>查看未完成项（{exportStatus.attentionIds.length}）</button> : null}
        <button type="button" className={`v2-psd-action ${exportStatus.ready ? 'is-ready' : ''}`} disabled={exporting||saving||pendingSaves>0||Boolean(saveProblem)||busy||dirtyDrafts.length>0||!exportStatus.ready} onClick={exportPsd} title={dirtyDrafts.length || pendingSaves || saveProblem ? '请先保存当前修改' : exportStatus.ready ? '下载所有已完成的当前结果' : `${stageHint}；全部完成后可下载`}><Download size={17}/>{exporting?'正在生成 PSD…':'下载 PSD'}</button>
      </footer>
    </>)}</>}
  </main>;
}
