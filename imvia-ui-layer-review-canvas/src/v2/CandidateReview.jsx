import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Download, RefreshCw } from 'lucide-react';
import { fitViewport } from './coordinates.js';

const stateLabels = { pending: '待拆分', processing: '处理中', review: '待审核', adopted: '已采用', stale: '结果已过期', failed: '拆分失败', cancelled: '已取消', inactive: '已移出列表' };

function FullCanvasPreview({ document, layers, label }) {
  const viewport = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = viewport.current;
    if (!node) return undefined;
    const measure = () => { const rect = node.getBoundingClientRect(); setSize({ width: rect.width, height: rect.height }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, [document.source.width, document.source.height]);
  const transform = useMemo(() => size.width && size.height
    ? fitViewport({ x: 0, y: 0, width: document.source.width, height: document.source.height }, size, 20) : null,
  [document.source.width, document.source.height, size.width, size.height]);
  return <div ref={viewport} className="v2-review-preview" aria-label={label}>
    {transform ? <div className="v2-review-preview__canvas" style={{ width: document.source.width * transform.scale, height: document.source.height * transform.scale }}>
      {layers.map(layer => <img key={`${layer.layerId}:${layer.versionId}`} src={layer.pngUrl}
        alt={`${layer.name} 透明图层`} draggable="false" style={{ left: layer.placement.x * transform.scale,
          top: layer.placement.y * transform.scale, width: layer.width * transform.scale, height: layer.height * transform.scale }} />)}
    </div> : <span>正在适配完整画布…</span>}
  </div>;
}

export function CandidateReview({ document, layerId, versions = [], state = { status: 'pending', versionIds: [] },
  composition = [], candidateUrl, onBack, onAdopt, onRetry, onRefresh, busy = false }) {
  const layer = document.layers[layerId];
  const eligibleIds = new Set(state.versionIds || []);
  const [selectedId, setSelectedId] = useState(state.versionIds?.[0] || versions[0]?.versionId || '');
  const [showComposition, setShowComposition] = useState(false);
  const effectiveSelectedId = versions.some(version => version.versionId === selectedId)
    ? selectedId : (state.versionIds?.[0] || versions[0]?.versionId || '');
  const selected = versions.find(version => version.versionId === effectiveSelectedId) || null;
  const previewLayers = showComposition ? composition : selected?.artifactValid && selected
    ? [{ layerId, name: layer.name, versionId: selected.versionId, pngUrl: candidateUrl(selected.versionId),
      width: selected.width, height: selected.height, placement: selected.placement }]
    : [];
  const canAdopt = Boolean(selected && eligibleIds.has(selected.versionId) && selected.artifactValid
    && state.status !== 'adopted' && !busy);
  const adopted = state.status === 'adopted' && selected?.versionId === state.adoptedVersionId;
  return <section className="v2-review-page" aria-label={`审核候选：${layer.name}`}>
    <header className="v2-review-head">
      <button type="button" className="v2-review-back" onClick={onBack}><ArrowLeft size={16}/>返回画布</button>
      <div><strong>候选审核 · {layer.name}</strong><span>{stateLabels[state.status] || state.status} · 原位 {layer.bounds.x}, {layer.bounds.y}</span></div>
      <button type="button" className="v2-review-refresh" onClick={onRefresh} disabled={busy}><RefreshCw size={15}/>刷新</button>
    </header>
    <div className="v2-review-body">
      <main className="v2-review-stage">
        <div className="v2-review-stage__tools">
          <button type="button" className={!showComposition ? 'is-active' : ''} onClick={() => setShowComposition(false)}>当前候选</button>
          <button type="button" className={showComposition ? 'is-active' : ''} onClick={() => setShowComposition(true)}>已采用合成 {composition.length}</button>
        </div>
        <FullCanvasPreview document={document} layers={previewLayers}
          label={showComposition ? '已采用图层合成预览，不自动包含原图' : '透明候选按原图坐标完整适配'} />
        <footer>完整画布 {document.source.width} × {document.source.height} px · 候选使用原图坐标，不移动、不缩放内容</footer>
      </main>
      <aside className="v2-review-panel">
        <div className="v2-review-panel__title"><h2>候选版本</h2><span>{versions.length} 个</span></div>
        {!versions.length ? <div className="v2-review-empty">这个拆分项还没有可审核的候选。完成拆分后，可在这里检查透明 PNG 和原位效果。</div> : null}
        <div className="v2-version-list" role="list" aria-label="候选版本">
          {versions.map(version => {
            const current = eligibleIds.has(version.versionId);
            return <button key={version.versionId} type="button" role="listitem"
              className={`v2-version ${effectiveSelectedId === version.versionId ? 'is-selected' : ''}`}
              onClick={() => { setSelectedId(version.versionId); setShowComposition(false); }}>
              <span><strong>版本 {version.versionId.slice(0, 8)}</strong><small>{current ? '当前修订' : '历史修订'} · {new Date(version.createdAt).toLocaleString()}</small></span>
              <i className={version.artifactValid ? 'is-valid' : 'is-invalid'}>{version.artifactValid ? (current ? '可审核' : '已过期') : 'PNG 校验失败'}</i>
            </button>;
          })}
        </div>
        {selected ? <div className="v2-review-details">
          <div><span>区域尺寸</span><strong>{selected.width} × {selected.height} px</strong></div>
          <div><span>原图位置</span><strong>X {selected.placement.x} · Y {selected.placement.y}</strong></div>
          <div><span>透明度</span><strong>{selected.alpha?.min}–{selected.alpha?.max}</strong></div>
          {selected.review?.checks ? <small>机械审核：{Object.entries(selected.review.checks).map(([name, passed]) => `${name} ${passed ? '通过' : '未通过'}`).join(' · ')}</small> : null}
          {selected.artifactValid ? <a href={candidateUrl(selected.versionId)} download={`${layer.name}-${selected.versionId.slice(0, 8)}.png`}><Download size={15}/>下载透明 PNG</a> : <p role="alert">候选文件缺失或校验不一致，不能采用。</p>}
          {adopted ? <div className="v2-adopted-note"><Check size={15}/>当前版本已采用</div> : null}
        </div> : null}
        <div className="v2-review-actions">
          <button type="button" className="v2-review-retry" onClick={onRetry} disabled={busy}><RefreshCw size={15}/>重新拆分当前项</button>
          <button type="button" className="v2-review-adopt" onClick={() => onAdopt?.(selected?.versionId)} disabled={!canAdopt}><Check size={16}/>{busy ? '保存中…' : '采用此版本'}</button>
        </div>
      </aside>
    </div>
  </section>;
}
