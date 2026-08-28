import { useId, useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { derivePosterPreview } from './poster-preview.js';
import { posterCandidateReviewModel } from './poster-candidate-review-model.js';

const CHECK_LABELS = Object.freeze({
  source_comparison: '来源比较',
  locked_anchors: '锁定锚点',
  repair_envelope: '修复范围',
  canvas_dimensions: '画布尺寸',
  key_field: '绿幕 / 黑底 key',
});

function list(value, fallback = '—') {
  return Array.isArray(value) && value.length ? value.join('、') : fallback;
}

function evidence(value) {
  return Array.isArray(value) && value.length
    ? value.map((item) => item?.description || String(item)).join('；')
    : '—';
}

function CandidateImage({ src, className, alt, style }) {
  return src ? <img src={src} className={className} alt={alt} style={style} /> : (
    <div className={`${className} poster-compare__unavailable`} role="status">候选图片尚不可用</div>
  );
}

export function PosterCandidateReview({
  sourceUrl,
  candidateUrl,
  layer = {},
  review = {},
  onGenerate,
  onAccept,
  onRetry,
}) {
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const sliderId = useId();
  const status = review.status || layer.status || 'PENDING';
  const failureCodes = review.failureCodes || review.failure_codes || [];
  const checks = review.checks || {};
  const preview = candidateUrl ? derivePosterPreview({
    candidateUrl,
    fillColor: layer.fill_color || layer.fillColor,
  }) : null;
  const busy = review.busy === true;
  const actionModel = posterCandidateReviewModel({
    status,
    canGenerate: review.canGenerate ?? ['PENDING', 'GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED'].includes(status),
    canAccept: review.canAccept === true,
    canRetry: review.canRetry ?? ['NEEDS_USER_REVIEW', 'HARD_REJECTED'].includes(status),
    failureCodes,
    facts: review.facts || review.failureFacts || review.failure_facts,
    busy,
    onGenerate,
    onAccept,
    onRetry,
  });

  return (
    <section className="poster-candidate-review" aria-label={`${layer.layer_name || '海报图层'}候选审核`}>
      <header className="poster-candidate-review__header">
        <div>
          <small>图层 {layer.layer_index || layer.layerIndex || '—'} · {actionModel.statusLabel}</small>
          <h2>{layer.layer_name || '海报图层'}候选审核</h2>
          <p>原始候选始终保持完整画布绿幕/黑底；透明效果仅为本地比较预览。</p>
        </div>
        <div className="poster-candidate-review__actions">
          {actionModel.actions.map((action) => <button key={action.id} type="button"
            className={action.id === 'accept' ? 'poster-candidate-review__accept' : undefined}
            onClick={action.onInvoke} disabled={action.disabled}>
            {action.id === 'accept' ? <Check size={16} /> : action.id === 'retry' ? <RefreshCw size={15} /> : null} {action.label}
          </button>)}
        </div>
      </header>

      <div className="poster-compare" aria-label="来源与候选比较">
        <figure className="poster-compare__panel">
          <CandidateImage src={sourceUrl} className="poster-compare__source" alt="原海报" />
          <figcaption>原海报</figcaption>
        </figure>
        <figure className="poster-compare__panel">
          <CandidateImage src={candidateUrl} className="poster-compare__candidate" alt="候选图层" />
          <figcaption>原始候选（正式文件）</figcaption>
        </figure>
        <figure className="poster-compare__panel poster-compare__panel--overlay">
          <div className="poster-compare__stack">
            <CandidateImage src={sourceUrl} className="poster-compare__source" alt="原海报叠加底图" />
            <CandidateImage src={candidateUrl} className="poster-compare__candidate" alt="候选图层叠加" style={{ opacity: overlayOpacity }} />
          </div>
          <figcaption><label htmlFor={sliderId}>叠加不透明度 {Math.round(overlayOpacity * 100)}%</label>
            <input id={sliderId} type="range" min="0" max="1" step="0.05" value={overlayOpacity}
              onChange={(event) => setOverlayOpacity(Number(event.target.value))} />
          </figcaption>
        </figure>
        <figure className="poster-compare__panel poster-compare__panel--preview">
          <div className={`poster-compare__preview ${preview?.className || ''}`}>
            <CandidateImage src={preview?.candidateUrl} className="poster-compare__candidate" alt="透明模拟预览" />
          </div>
          <figcaption>{preview?.label || '透明模拟预览（仅预览）'}：不会下载、导出或写入正式图层。</figcaption>
        </figure>
      </div>

      <div className="poster-candidate-review__details">
        <section><h3>来源与限制</h3><p><strong>来源证据：</strong>{evidence(layer.source_evidence)}</p>
          <p><strong>锁定锚点：</strong>{list(layer.locked_visible_anchors)}</p>
          <p><strong>修复范围：</strong>{layer.repair_envelope?.description || '无需修复'}</p>
          <p><strong>移除的遮挡者：</strong>{list(layer.occluded_by)}</p>
        </section>
        <section><h3>发布检查</h3>
          <ul className="poster-candidate-review__checks">{Object.entries(checks).map(([key, passed]) => (
            <li key={key} data-passed={passed === true}>{CHECK_LABELS[key] || key}：{passed === true ? '通过' : '未通过'}</li>
          ))}</ul>
          {actionModel.failures.length ? <div className="poster-candidate-review__failures" role="alert"><AlertTriangle size={16} />
            <div><strong>候选已硬拒绝</strong>{actionModel.failures.map((failure, index) => <div key={`${failure.technicalCode || 'UNKNOWN'}-${index}`}>
              <p>{failure.message}{failure.technicalCode ? <> <b>技术代码：{failure.technicalCode}</b></> : null}</p>
              {failure.facts.map((fact) => <p key={fact}>{fact}</p>)}
            </div>)}</div>
          </div> : null}
          {review.notes || layer.review_note ? <p className="poster-candidate-review__notes"><strong>审核备注：</strong>{review.notes || layer.review_note}</p> : null}
          {review.stale ? <p className="poster-candidate-review__stale" role="status">此候选已失效，仅保留作诊断，不能接受。</p> : null}
        </section>
      </div>
    </section>
  );
}
