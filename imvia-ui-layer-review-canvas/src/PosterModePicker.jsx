import { ImagePlus, Layers3 } from 'lucide-react';
import { selectPosterMode } from './poster-ui-controller.js';

const choices = [
  {
    value: 'ui',
    label: 'UI/运营图拆分',
    description: '框选并拆分标题、元素、文字和 UI 组件。',
    Icon: ImagePlus,
  },
  {
    value: 'poster',
    label: '海报分层',
    description: '按类别生成可编辑框选，每次只拆分当前项目。',
    Icon: Layers3,
  },
];

export function PosterModePicker({
  value = 'ui', onChange, disabled = false, includePoster = true,
  onPosterPlanningModeChange,
}) {
  const modeChoices = includePoster ? choices : choices.filter((choice) => choice.value !== 'poster');
  const chooseMode = (choice) => {
    if (choice === 'poster') onPosterPlanningModeChange?.('targeted_fast');
    selectPosterMode({ choice, disabled, onChange });
  };
  return (
    <div className="poster-mode-picker" role="group" aria-label="选择图片处理模式">
      {modeChoices.map(({ value: choiceValue, label, description, Icon }) => {
        const selected = choiceValue === value;
        return (
          <button
            key={choiceValue}
            type="button"
            className={`poster-mode-picker__choice ${selected ? 'poster-mode-picker__choice--selected' : ''}`}
            aria-label={`选择${label}模式`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => chooseMode(choiceValue)}
          >
            <span className="poster-mode-picker__icon"><Icon size={20} /></span>
            <span><strong>{label}</strong><small>{description}</small></span>
          </button>
        );
      })}
    </div>
  );
}
