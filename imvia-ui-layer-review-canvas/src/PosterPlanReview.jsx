import { AlertTriangle, ArrowDown, ArrowUp, Check, Merge, Trash2 } from 'lucide-react';
import { validatePosterMerge } from './poster-plan-merge.js';
import { posterPlanReviewUiState } from './poster-ui-controller.js';

function list(value, fallback = '—') {
  return Array.isArray(value) && value.length ? value.join('、') : fallback;
}

function evidence(value) {
  if (!Array.isArray(value) || !value.length) return '—';
  return value.map((item) => item?.description || String(item)).join('；');
}

export function PosterPlanReview({
  plan,
  validation = { valid: false, errors: [] },
  onLayerChange,
  onReorder,
  onDelete,
  onMerge,
  onConfirm,
  busy = false,
}) {
  const layers = Array.isArray(plan?.layers) ? [...plan.layers]
    .sort((left, right) => (left.layer_index || 0) - (right.layer_index || 0)) : [];
  const reviewUi = posterPlanReviewUiState(plan, validation, busy);

  return (
    <section className="poster-plan-review" aria-label="海报图层计划复核">
      <header className="poster-plan-review__header">
        <div>
          <small>海报分层计划 · 版本 {plan?.plan_version || 1}</small>
          <h2>确认所有权后再生成候选</h2>
          <p>图层按前景到背景排列；修改结构会使尚未接受的候选失效。</p>
        </div>
        <button type="button" className="poster-plan-review__confirm" onClick={() => onConfirm?.()} disabled={!reviewUi.canConfirm}>
          <Check size={16} /> 确认海报计划
        </button>
      </header>

      {!validation.valid ? (
        <div className="poster-plan-review__errors" role="alert">
          <AlertTriangle size={16} />
          <div><strong>计划尚不能确认</strong>{reviewUi.errors.map((message, index) => (
            <span key={`${message}-${index}`}>{message}</span>
          ))}</div>
        </div>
      ) : null}

      <ol className="poster-plan-review__layers">
        {layers.map((layer, index) => {
          const nextLayer = layers[index + 1];
          const mergeValidation = validatePosterMerge(layer, nextLayer);
          const mergeBlocked = !mergeValidation.valid;
          return (
            <li key={layer.layer_index || `${layer.layer_name}-${index}`} className="poster-plan-review__layer">
              <header>
                <span className="poster-plan-review__index">{layer.layer_index || index + 1}</span>
                <label>
                  <span>图层名称</span>
                  <input
                    value={layer.layer_name || ''}
                    onChange={(event) => onLayerChange?.(layer.layer_index, { layer_name: event.target.value })}
                    disabled={busy}
                  />
                </label>
                <span className={`poster-plan-review__risk poster-plan-review__risk--${layer.risk_level || 'medium'}`}>{layer.risk_level || 'medium'} 风险</span>
                <div className="poster-plan-review__actions">
                  <button type="button" aria-label={`将 ${layer.layer_name} 上移`} onClick={() => onReorder?.(layer.layer_index, 'up')} disabled={busy || index === 0}><ArrowUp size={15} /></button>
                  <button type="button" aria-label={`将 ${layer.layer_name} 下移`} onClick={() => onReorder?.(layer.layer_index, 'down')} disabled={busy || index === layers.length - 1}><ArrowDown size={15} /></button>
                  <button type="button" aria-label={`删除 ${layer.layer_name}`} onClick={() => onDelete?.(layer.layer_index)} disabled={busy}><Trash2 size={15} /></button>
                </div>
              </header>
              <div className="poster-plan-review__fields">
                <p><strong>来源证据</strong><span>{evidence(layer.source_evidence)}</span></p>
                <p><strong>遮挡关系</strong><span>遮挡：{list(layer.occludes)}；被遮挡：{list(layer.occluded_by)}</span></p>
                <p><strong>支持组件</strong><span>{list(layer.support_components)}</span></p>
                <p><strong>独立 UI</strong><span>{layer.ui_independence || '—'}</span></p>
                <p><strong>修复范围</strong><span>{layer.repair_envelope?.description || '无需修复'}</span></p>
                <p><strong>锁定可见锚点</strong><span>{list(layer.locked_visible_anchors)}</span></p>
                <p><strong>所有权说明</strong><span>{layer.separation_reason || '—'}</span></p>
              </div>
              {nextLayer ? (
                <button
                  type="button"
                  className="poster-plan-review__merge"
                  onClick={() => onMerge?.(layer.layer_index, nextLayer.layer_index)}
                  disabled={busy || mergeBlocked}
                  title={mergeBlocked ? mergeValidation.message : undefined}
                >
                  <Merge size={15} /> 与下一图层合并
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
