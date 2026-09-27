import { useMemo } from 'react';
import { MousePointer2, PenTool, WandSparkles } from 'lucide-react';
import { DocumentCanvas } from './DocumentCanvas.jsx';
import { categoryPresets } from './document.js';

const quickPrompts = [
  ['保留原图可见像素', '保留框选区域内原有可见像素，不改变其外观。'],
  ['去字后补全底板', '移除文字后自然补全被遮挡的背景底板。'],
  ['补全被遮挡区域', '按周围纹理与光影补全被遮挡区域。'],
  ['保留框选尺寸和位置', '保持原图中的框选尺寸、位置与比例。'],
];

export function LayerEditor({ document, sourceUrl, draft, onChange, onDone, onCancel, onOpenPen }) {
  const viewDocument = useMemo(() => ({ ...document, activeLayerId: draft.layerId }), [document, draft.layerId]);
  const values = draft.values;
  const appendPrompt = prompt => onChange({ type: 'set-field', field: 'requirements', value: [values.requirements, prompt].filter(Boolean).join('\n') });
  const handleCategory = value => {
    const preset = categoryPresets.find(([name]) => name === value);
    onChange({ type: 'set-field', field: 'displayCategory', value });
    if (preset) onChange({ type: 'set-field', field: 'processingCategory', value: preset[1] });
  };

  return <section className="v2-editor-page" aria-label="编辑拆分项">
    <div className="v2-editor-canvas-column">
      <header className="v2-section-heading"><div><h1>原图编辑</h1><span>{values.name} · 区域坐标与尺寸保持原位</span></div></header>
      <DocumentCanvas document={viewDocument} sourceUrl={sourceUrl} selection={draft.layerId} onSelect={() => {}} />
      <footer className="v2-canvas-foot"><span>青绿色线框为当前拆分区域</span><span>{values.bounds.width} × {values.bounds.height} px</span></footer>
    </div>
    <aside className="v2-editor-panel" aria-label="编辑拆分">
      <h2>编辑拆分</h2>
      <label className="v2-field"><span>名称</span><input value={values.name} onChange={event => onChange({ type: 'set-field', field: 'name', value: event.target.value })} /></label>
      <label className="v2-field"><span>拆分类别</span><select value={values.displayCategory} onChange={event => handleCategory(event.target.value)}>{categoryPresets.map(([label]) => <option key={label} value={label}>{label}</option>)}{categoryPresets.some(([label]) => label === values.displayCategory) ? null : <option value={values.displayCategory}>{values.displayCategory}</option>}</select></label>
      <label className="v2-field"><span>处理要求</span><textarea value={values.requirements} onChange={event => onChange({ type: 'set-field', field: 'requirements', value: event.target.value })} placeholder="描述需要保留或修复的内容…" rows={5} /></label>
      <div className="v2-quick-prompts" aria-label="快捷提示">{quickPrompts.map(([label, prompt]) => <button type="button" key={label} onClick={() => appendPrompt(prompt)}>{label}</button>)}</div>
      <div className="v2-editor-choice-row"><span>移除背景</span><label className="v2-switch"><input type="checkbox" checked={values.strategy.removeBackground} onChange={event => onChange({ type: 'set-strategy', field: 'removeBackground', value: event.target.checked })} /><i /></label></div>
      <div className="v2-editor-choice-row"><span>处理方式</span><div className="v2-operation-switch"><button type="button" className={values.strategy.operation === 'extract' ? 'is-active' : ''} onClick={() => onChange({ type: 'set-strategy', field: 'operation', value: 'extract' })}>提取区域</button><button type="button" className={values.strategy.operation === 'reconstruct' ? 'is-active' : ''} onClick={() => onChange({ type: 'set-strategy', field: 'operation', value: 'reconstruct' })}>修复区域</button></div></div>
      <div className="v2-editor-tools"><span>精细编辑工具</span><div>
        <button type="button" aria-label="编辑钢笔路径" title="编辑选区轮廓" onClick={() => onOpenPen('paths')}><PenTool size={20}/></button>
        <button type="button" aria-label="编辑修复区域" title="编辑修复区域" onClick={() => onOpenPen('repairPaths')}><MousePointer2 size={20}/></button>
        <button type="button" aria-label="魔棒不可用" title="当前版本尚无可靠的魔棒选区算法" disabled><WandSparkles size={20}/></button>
      </div><small>魔棒暂不可用；钢笔路径、锚点拖动、撤销和重做可用。</small></div>
      <div className="v2-editor-actions"><button type="button" className="v2-editor-cancel" onClick={onCancel}>取消</button><button type="button" className="v2-editor-done" onClick={onDone}>完成</button></div>
    </aside>
  </section>;
}
