import { useState } from 'react';
import { Check, Download, RefreshCw, Scissors } from 'lucide-react';
import { CandidatePreview } from './CandidatePreview.jsx';
import { previewBounds } from './preview-viewport.js';
import { candidateLabels as stateLabels, transparencyStatus } from './result-status.js';
import { geometryReview, sourceGeometryMatches } from './candidate-review.js';
import { WorkspaceBack, WorkspaceFooter, WorkspaceHeading } from './WorkspaceChrome.jsx';

const checkLabels = { authorizationBinding: '授权绑定', frozenSnapshotMatches: '选区快照', selectedDimensionsMatch: '选区尺寸', pngReadable: 'PNG 可读性', mappingDimensionsMatch: '映射尺寸', sourcePlacementMatches: '原图定位', callBudgetHonored: '调用预算', png: 'PNG 格式', alpha: '透明通道' };

export function CandidateReview({ document, layerId, versions = [], state = { status: 'pending', versionIds: [] },
  composition = [], candidateUrl, sourceUrl, onBack, onAdopt, onRetry, onRefresh, onRevalidate, validating = false, busy = false }) {
  const layer = document.layers[layerId];
  const eligibleIds = new Set(versions.filter(v => state.versionIds?.includes(v.versionId) && v.artifactValid && sourceGeometryMatches(layer, v)).map(v => v.versionId));
  const resultId = eligibleIds.has(state.resultVersionId) ? state.resultVersionId : '';
  // An empty selection follows newly delivered results; history is optional, not a gate.
  const [selectedId, setSelectedId] = useState('');
  const [showComposition, setShowComposition] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const effectiveSelectedId = versions.some(v => v.versionId === selectedId) ? selectedId : resultId;
  const selected = versions.find(v => v.versionId === effectiveSelectedId) || null;
  const latest = versions[0];
  const geometry = (selected || latest) ? geometryReview(layer, selected || latest) : null;
  const delivered = Boolean(selected && selected.versionId === resultId);
  const eligible = Boolean(selected && eligibleIds.has(selected.versionId));
  const previewLayers = showComposition ? composition : selected?.artifactValid
    ? [{ layerId, name: layer.name, versionId: selected.versionId, pngUrl: candidateUrl(selected.versionId),
      width: selected.width, height: selected.height, placement: selected.placement }] : [];
  const firstSplit = state.status === 'pending' && !versions.length;
  const processing = state.status === 'processing' || state.status === 'validation_pending' || validating;
  const failure = ['quality_failed', 'validation_failed', 'failed', 'stale'].includes(state.status);
  const downloadUrl = selected ? `${candidateUrl(selected.versionId)}?download=1` : '';
  return <section className="v2-review-page v2-workspace-page" aria-label={`拆分结果：${layer.name}`}>
    <div className="v2-review-body v2-workspace-grid">
      <div className="v2-review-stage v2-workspace-canvas-panel">
        <WorkspaceHeading title="拆分结果" detail={layer.name} actions={<>
          <div className="v2-review-stage__tools">
            <button type="button" className={!showComposition ? 'is-active' : ''} aria-pressed={!showComposition} onClick={() => setShowComposition(false)}>当前结果</button>
            <button type="button" className={showComposition ? 'is-active' : ''} aria-pressed={showComposition} onClick={() => setShowComposition(true)}>结果合成 {composition.length}</button>
          </div>
          <button type="button" className="v2-review-refresh" onClick={onRefresh} disabled={busy} aria-label="刷新结果" title="刷新结果"><RefreshCw size={15}/></button>
        </>}/>
        <CandidatePreview key={`${layerId}:${showComposition ? 'composition' : effectiveSelectedId}`} source={document.source} layers={previewLayers}
          bounds={previewBounds(document.source, previewLayers, showComposition)}
          reference={showSource && !showComposition && selected && sourceUrl
            ? { url: sourceUrl, ...selected.placement, width: selected.width, height: selected.height } : null}
          label={showComposition ? '拆分结果合成预览，不包含原图' : '拆分结果预览，可缩放和拖动'} />
      </div>
      <aside className="v2-review-panel v2-workspace-side-panel">
        <WorkspaceHeading title="结果信息" level={2} actions={<WorkspaceBack onClick={onBack}/>}/>
        <div className="v2-workspace-panel-body v2-review-panel-body">
          {!resultId ? <div className={`v2-result-status ${failure && !processing ? 'is-failed' : ''}`} role={failure && !processing ? 'alert' : 'status'}>
            <strong>{processing ? '正在自动处理' : failure ? '未能完成该项' : firstSplit ? '还未开始拆分' : '暂无可交付结果'}</strong>
            <p>{processing ? '完成后结果将自动就绪，无需确认。' : failure ? geometry?.detail || '本次处理未完成，原图、选区和历史记录已保留。'
              : firstSplit ? '点击“拆分当前项”开始处理。' : '完成处理后可直接下载。'}</p>
          </div> : null}
          {selected ? <div className="v2-review-details">
            {delivered ? <div className="v2-adopted-note"><Check size={15}/>已完成，可直接下载</div>
              : <p role="status">{eligible ? '正在查看其他合格版本，不影响当前结果。' : '正在查看历史处理记录，不属于交付结果。'}</p>}
            <div><span>区域尺寸</span><strong>{selected.width} × {selected.height} px</strong></div>
            <div><span>原图位置</span><strong>X {selected.placement.x} · Y {selected.placement.y}</strong></div>
            <div><span>透明状态</span><strong>{transparencyStatus(selected.alpha)}</strong></div>
            {sourceUrl ? <button type="button" className="v2-result-compare" aria-pressed={showSource}
              onClick={() => { setShowSource(value => !value); setShowComposition(false); }}>{showSource ? '查看结果' : '对照原图'}</button> : null}
            {selectedId && resultId && selectedId !== resultId ? <button type="button" className="v2-result-compare"
              onClick={() => { setSelectedId(''); setShowSource(false); }}>返回当前结果</button> : null}
          </div> : null}
          {versions.length ? <details className="v2-result-history">
            <summary>版本记录 · {versions.length}</summary>
            <div className="v2-version-list" role="list" aria-label="版本记录">
              {versions.map(version => {
                const current = eligibleIds.has(version.versionId);
                const check = geometryReview(layer, version);
                const replaced = versions.some(next => next.revalidation?.originalVersionId === version.versionId);
                return <div key={version.versionId} role="listitem" className={`v2-version ${effectiveSelectedId === version.versionId ? 'is-selected' : ''}`}>
                  <button type="button" className="v2-version-select" aria-pressed={effectiveSelectedId === version.versionId}
                    onClick={() => { setSelectedId(version.versionId); setShowComposition(false); setShowSource(false); }}>
                    <span><strong>版本 {version.versionId.slice(0, 8)}</strong><small>{version.revalidation ? '自动修正' : '处理记录'} · {new Date(version.createdAt).toLocaleString()}</small></span>
                    <i className={version.versionId === resultId ? 'is-valid' : 'is-history'}>{version.versionId === resultId ? '当前结果'
                      : current ? '可用版本' : replaced ? '历史记录' : !version.artifactValid ? '文件不可用' : check.status !== 'passed' ? check.label : '已过期'}</i>
                  </button>
                </div>;
              })}
            </div>
            {selected?.review?.checks ? <details className="v2-review-checks" key={selected.versionId}>
              <summary>处理诊断</summary>
              <p>{geometry?.detail || '自动检查通过。'}</p>
              <dl>{Object.entries(selected.review.checks).map(([name, passed]) => <div key={name}><dt title={name}>{checkLabels[name] || name}</dt><dd className={passed ? '' : 'is-failed'}>{passed ? '通过' : '未通过'}</dd></div>)}</dl>
              {!eligible && selected.artifactValid ? <a href={downloadUrl} download={`${layer.name}-${selected.versionId.slice(0, 8)}-diagnostic.png`}>下载历史诊断 PNG（非成品）</a> : null}
            </details> : null}
          </details> : null}
        </div>
      </aside>
    </div>
    <WorkspaceFooter status={<span>{stateLabels[state.status] || '正在检查结果'} · 原图位置 ({layer.bounds.x}, {layer.bounds.y}) · 完整画布 {document.source.width} × {document.source.height} px</span>}>
      {state.status === 'validation_failed' && onRevalidate
        ? <button type="button" className="v2-workspace-secondary" onClick={onRevalidate} disabled={busy || processing}><RefreshCw size={15}/>重试自动处理</button>
        : <button type="button" className="v2-workspace-secondary" onClick={onRetry} disabled={busy || processing}><Scissors size={15}/>{processing ? '正在处理…' : firstSplit ? '拆分当前项' : '重新拆分当前项'}</button>}
      {eligible && !delivered && onAdopt ? <button type="button" className="v2-workspace-secondary" onClick={() => onAdopt(selected.versionId)} disabled={busy}>使用此版本</button> : null}
      {eligible ? <a className="v2-workspace-primary" href={downloadUrl} download={`${layer.name}-${selected.versionId.slice(0, 8)}.png`}><Download size={16}/>下载 PNG</a> : null}
    </WorkspaceFooter>
  </section>;
}
