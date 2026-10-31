import { useState } from 'react';
import { processingCategories } from './document.js';
import { CompactSelect } from './CompactSelect.jsx';

const processingLabels = { text: '普通文字', subject: '主体', brand_ui: '品牌与 UI', decoration_prop: '装饰与道具', effect: '光效', background: '背景' };
export const processingCategoryOptions = processingCategories.map(value => ({ value, label: processingLabels[value] }));

export function CustomCategoryForm({ onAdd }) {
  const [name, setName] = useState('');
  const [route, setRoute] = useState('');
  const valid = Boolean(name.trim()) && processingCategories.includes(route);
  return <div className="v2-custom-category">
    <label>自定义类别名称<input value={name} onChange={event => setName(event.target.value)} placeholder="输入类别名称" /></label>
    <div className="v2-custom-category__field"><span>处理类别</span><CompactSelect label="处理类别" required value={route} onChange={setRoute} placeholder="选择处理类别" options={processingCategoryOptions}/></div>
    <button type="button" disabled={!valid} onClick={() => { if (valid) onAdd?.({ displayCategory: name.trim(), processingCategory: route }); }}>确认并框选区域</button>
  </div>;
}
