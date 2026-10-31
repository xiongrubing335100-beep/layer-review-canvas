import { PenTool } from 'lucide-react';
import { categoryPresets } from './document.js';
import { RegionEditorCanvas } from './RegionEditorCanvas.jsx';
import { CompactSelect } from './CompactSelect.jsx';
import { processingCategoryOptions } from './CustomCategoryForm.jsx';
import { defaultPosterFastPrompt } from '../poster-fast-workbench-model.js';
import { combinedLayerRequirements, hasLocalRepairRequirements, localRegionRequirements } from './layer-requirements.js';
import { WorkspaceBack, WorkspaceFooter, WorkspaceHeading } from './WorkspaceChrome.jsx';
import { quickLayerActions } from './editor-state.js';

export function LayerEditor({ document, sourceUrl, draft, onChange, onDone, onCancel, onBack = onCancel, onOpenPen, saveError = '', saving = false }) {
  const values = draft.values;
  const bounds = values.bounds;
  const localRequirements = localRegionRequirements(values);
  const localRepair = hasLocalRepairRequirements(values);
  const penTarget = values.strategy.operation === 'reconstruct' ? 'repairPaths' : 'paths';
  const handleCategory = value => onChange({ type: 'set-category', value });

  return <section className="v2-editor-page v2-workspace-page" aria-label="编辑拆分项">
    <div className="v2-workspace-grid">
    <div className="v2-editor-canvas-column v2-workspace-canvas-panel">
      <WorkspaceHeading title="选区编辑" detail={values.name}/>
      <RegionEditorCanvas source={document.source} sourceUrl={sourceUrl} name={values.name} bounds={bounds}
        entryBounds={document.layers[draft.layerId].bounds}
        onResize={value => onChange({ type: 'set-field', field: 'bounds', value })} onOpenPen={() => onOpenPen(penTarget)}/>
    </div>
    <aside className="v2-editor-panel v2-workspace-side-panel" aria-label="编辑拆分">
      <WorkspaceHeading title="编辑拆分" level={2} actions={<WorkspaceBack onClick={onBack}/>}/>
      <div className="v2-workspace-panel-body v2-editor-fields">
      <label className="v2-field"><span>名称</span><input value={values.name} onChange={event => onChange({ type: 'set-field', field: 'name', value: event.target.value })} /></label>
      <div className="v2-field"><span>拆分类别</span><CompactSelect label="拆分类别" value={draft.customCategory ? '__custom__' : values.displayCategory} onChange={handleCategory}
        options={[...categoryPresets.map(([label]) => ({ label, value: label })),
          { label: '自定义', value: '__custom__' }]} /></div>
      {draft.customCategory ? <>
        <label className="v2-field"><span>自定义类别名称</span><input value={values.displayCategory} placeholder="输入类别名称" required
          onChange={event => onChange({ type: 'set-field', field: 'displayCategory', value: event.target.value })} /></label>
        <div className="v2-field"><span>处理类别</span><CompactSelect label="处理类别" required value={values.processingCategory}
          onChange={value => onChange({ type: 'set-processing-category', value })} options={processingCategoryOptions}/></div>
      </> : null}
      <label className="v2-field"><span>处理要求</span><textarea value={values.requirements} onChange={event => onChange({ type: 'set-field', field: 'requirements', value: event.target.value })} placeholder="描述需要保留或修复的内容…" rows={5} /></label>
      <div className="v2-quick-prompts" aria-label="快捷提示"><button type="button" onClick={() => onChange({ type: 'set-field', field: 'requirements', value: defaultPosterFastPrompt(values.processingCategory) })}>恢复默认提示词</button>{quickLayerActions.map(({ id, label }) => <button type="button" key={id} onClick={() => onChange({ type: 'apply-quick-prompt', id })}>{label}</button>)}</div>
      {localRequirements.length ? <details className="v2-requirements-summary"><summary>汇总处理要求 · {localRequirements.length} 个局部选区</summary><pre>{combinedLayerRequirements(values)}</pre></details> : null}
      <div className="v2-editor-choice-row"><span>移除背景</span><label className="v2-switch"><input type="checkbox" aria-label="移除背景" checked={values.strategy.removeBackground} onChange={event => onChange({ type: 'set-strategy', field: 'removeBackground', value: event.target.checked })} /><i /></label></div>
      <div className="v2-editor-choice-row"><span>处理方式</span><div className="v2-operation-switch"><button type="button" disabled={localRepair} title={localRepair ? '已填写局部修复要求，使用修复区域处理' : undefined} className={values.strategy.operation === 'extract' ? 'is-active' : ''} onClick={() => onChange({ type: 'set-strategy', field: 'operation', value: 'extract' })}>提取区域</button><button type="button" className={values.strategy.operation === 'reconstruct' ? 'is-active' : ''} onClick={() => onChange({ type: 'set-strategy', field: 'operation', value: 'reconstruct' })}>修复区域</button></div></div>
      <div className="v2-editor-tools"><span>精细编辑工具</span><div>
        <button type="button" aria-label="编辑钢笔路径" title={penTarget === 'repairPaths' ? '钢笔编辑修复区域' : '钢笔编辑选区轮廓'} onClick={() => onOpenPen(penTarget)}><PenTool size={20}/></button>
      </div><small>用钢笔圈选{penTarget === 'repairPaths' ? '修复' : '保留'}区域，并填写局部处理要求。</small></div>
      </div>
    </aside>
    </div>
    <WorkspaceFooter status={saveError ? <span role="alert">{saveError}</span> : <span>{saving ? '正在保存…' : `原图位置 (${bounds.x}, ${bounds.y}) · ${bounds.width} × ${bounds.height} px · 仅编辑当前框选区域`}</span>}>
      <button type="button" className="v2-workspace-secondary" onClick={onCancel}>取消</button>
      <button type="button" className="v2-workspace-primary" disabled={draft.customCategory && !values.displayCategory.trim()} onClick={onDone}>完成</button>
    </WorkspaceFooter>
  </section>;
}
