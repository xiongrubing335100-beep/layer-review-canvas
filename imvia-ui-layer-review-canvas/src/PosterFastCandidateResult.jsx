import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, Maximize2, Minimize2, RefreshCw } from 'lucide-react';
import { posterFastPngReturnState, posterFastRecoveryAction } from './poster-fast-workbench-model.js';

const FAILURE_FACTS = Object.freeze({
  CANVAS_OR_GREEN_FIELD_INVALID: '画布尺寸或键色不符合当前项目要求。',
  KEY_UNUSABLE: '键色不可用于当前项目的正式输出。',
  REGISTRATION_UNCERTAIN: '候选与原图的坐标配准无法确认。',
  TEXT_OR_LOGO_MUTATED: '文字、字形或 Logo 与来源不一致。',
  FOREIGN_CONTENT_LEAK: '候选中包含不属于当前项目的内容。',
  VISIBLE_ANCHOR_MUTATION: '锁定的可见锚点发生变化。',
  REPAIR_ENVELOPE_EXCEEDED: '修复范围超出当前项目的允许区域。',
  WHOLE_ASSET_REGENERATION: '候选疑似重新绘制了整项资产。',
  GENERATION_FAILED: '候选后处理或审核未完成，原始 PNG 已保留供检查。',
});

// Shared copy remains part of the review contract while the controls live in
// the result header instead of below the image preview.
const REVIEW_ACTION_LABELS = Object.freeze({
  accept: '接受候选',
  retry: '重新生成此项目',
});

function factFor(code) {
  return FAILURE_FACTS[code] || '自动质检未通过，请根据技术详情重新生成当前项目。';
}

function candidateFacts(candidate, layer) {
  const facts = candidate?.review?.facts || candidate?.facts || {};
  const dimensions = facts.dimensions || facts.canvas_dimensions;
  const expected = facts.expectedDimensions || facts.expected_dimensions || layer?.source_size || layer?.sourceSize;
  return [
    dimensions ? `实际画布：${dimensions.width || '—'} × ${dimensions.height || '—'} px` : null,
    expected ? `要求画布：${expected.width || '—'} × ${expected.height || '—'} px` : null,
    facts.observedKey || facts.observed_key ? `实际键色：${facts.observedKey || facts.observed_key}` : null,
    facts.expectedKey || facts.expected_key ? `要求键色：${facts.expectedKey || facts.expected_key}` : null,
    facts.registration || facts.registration_detail ? `配准：${facts.registration || facts.registration_detail}` : null,
  ].filter(Boolean);
}

function CandidatePngPreview({ url, alt, label }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    globalThis.window?.addEventListener?.('keydown', closeOnEscape);
    return () => globalThis.window?.removeEventListener?.('keydown', closeOnEscape);
  }, [expanded]);

  return (
    <div
      className={`poster-fast-workbench__png-canvas${expanded ? ' poster-fast-workbench__png-canvas--expanded' : ''}`}
      aria-label={label}
    >
      <img src={url} alt={alt} />
      <button
        type="button"
        className="poster-fast-workbench__png-expand"
        aria-label={expanded ? '退出 PNG 全图' : '查看 PNG 全图'}
        aria-pressed={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
    </div>
  );
}

export function PosterFastCandidateResult({ candidate, layer = {}, onAccept, onRetry, busy = false, executionView = null }) {
  const result = posterFastPngReturnState(candidate);
  const facts = candidateFacts(candidate, layer);
  const recovery = posterFastRecoveryAction(result);

  if (result.kind === 'empty') return (
    <div className="poster-fast-workbench__png-empty" role="status">
      <strong>尚未生成候选</strong><span>点击“拆分当前项目”后，原始全画布 PNG 会回传到这里。</span>
    </div>
  );

  if (result.kind === 'pending') return (
    <div className="poster-fast-workbench__png-pending" role="status" aria-busy="true">
      <div className="poster-fast-workbench__progress-heading"><LoaderCircle size={20} className="spin" /><strong>{executionView?.stageLabel || '候选生成中'}</strong><time>{executionView?.elapsedLabel || '00:00'}</time></div>
      <ol className="poster-fast-workbench__progress-steps">
        {(executionView?.steps || []).map((step) => <li key={step.key} data-status={step.status}><i /><span>{step.label}</span></li>)}
      </ol>
    </div>
  );

  if (result.kind === 'rejected') return (
    <div className="poster-fast-workbench__png-rejected" role="alert">
      {result.candidateUrl ? <div className="poster-fast-workbench__png-rejected-preview">
        <CandidatePngPreview
          url={result.candidateUrl}
          alt={`${layer.layer_name || '当前项目'}原始失败候选 PNG`}
          label="原始候选 PNG 预览"
        />
        <span>原始 PNG 已保留，未写入正式图层</span>
      </div> : null}
      <div className="poster-fast-workbench__png-failure">
        <AlertTriangle size={19} />
        <div><strong>候选未通过自动质检</strong>
          {result.failureCodes.map((code) => <p key={code}>{factFor(code)}</p>)}
          {facts.map((fact) => <p key={fact}>{fact}</p>)}
          <details><summary>技术详情</summary><code>{result.failureCodes.join(', ') || 'GENERATION_FAILED'}</code></details>
          <button type="button" onClick={() => onRetry?.(recovery.kind)} disabled={busy}><RefreshCw size={15} /> {recovery.label}</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="poster-fast-workbench__png-result" data-state={result.kind}>
      {result.candidateUrl ? <CandidatePngPreview
        url={result.candidateUrl}
        alt={`${layer.layer_name || '当前项目'}候选 PNG`}
        label="透明 PNG 预览"
      /> : <div className="poster-fast-workbench__png-canvas" aria-label="透明 PNG 预览">
        <div className="poster-fast-workbench__png-missing">候选 PNG 暂不可预览</div>
      </div>}
      <span className="poster-fast-workbench__png-status-sr-only" data-accept-label={REVIEW_ACTION_LABELS.accept} data-retry-label={REVIEW_ACTION_LABELS.retry}>
        {result.kind === 'review-ready' ? '候选，未写入正式图层' : result.kind === 'accepted' ? '已写入正式图层' : result.label}
      </span>
    </div>
  );
}
