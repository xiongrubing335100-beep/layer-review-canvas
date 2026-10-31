import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';

const source = await readFile(new URL('./PosterModePicker.jsx', import.meta.url), 'utf8');
let vite;
let PosterModePicker;

test.before(async () => {
  vite = await createServer({ root: process.cwd(), appType: 'custom', server: { middlewareMode: true } });
  ({ PosterModePicker } = await vite.ssrLoadModule('/src/PosterModePicker.jsx'));
});

test.after(async () => { await vite?.close(); });

function descendants(value) {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !value.props) return [];
  return [value, ...descendants(value.props.children)];
}

test('empty upload state exposes explicit UI and poster choices', () => {
  assert.match(source, /label: 'UI\/运营图拆分'/);
  assert.match(source, /label: '海报分层'/);
  assert.match(source, /aria-pressed=\{selected\}/);
});

test('mode choices have accessible names, pressed state, and respect disabled uploads', () => {
  assert.match(source, /aria-label=\{`选择\$\{label\}模式`\}/);
  assert.match(source, /aria-pressed=\{selected\}/);
  assert.match(source, /disabled=\{disabled\}/);
});

test('poster entry can be omitted while retaining the UI upload choice', () => {
  assert.match(source, /const modeChoices = includePoster \? choices : choices\.filter\(\(choice\) => choice\.value !== 'poster'\);/);
  assert.match(source, /modeChoices\.map/);
});

test('poster entry is two clean cards with no native planning controls or high-quality entry', () => {
  const tree = PosterModePicker({ value: 'poster', includePoster: true });
  const nodes = descendants(tree);
  assert.equal(nodes.filter((node) => node.type === 'button').length, 2);
  assert.equal(nodes.some((node) => node.type === 'fieldset' || node.type === 'input'), false);
  assert.doesNotMatch(source, /海报分层方式|高质量分析|quality_global|posterPlanningChoices/);
});

test('choosing poster always selects targeted fast before changing document mode', () => {
  const events = [];
  const tree = PosterModePicker({
    value: 'ui',
    includePoster: true,
    onChange: (value) => events.push(['mode', value]),
    onPosterPlanningModeChange: (value) => events.push(['planning', value]),
  });
  const posterButton = descendants(tree).find((node) => node.props?.['aria-label'] === '选择海报分层模式');
  assert.ok(posterButton);
  posterButton.props.onClick();
  assert.deepEqual(events, [['planning', 'targeted_fast'], ['mode', 'poster']]);
});
