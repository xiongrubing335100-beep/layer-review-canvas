export function canvasDeletionPlan(keys) {
  const plan = {
    deleteSource: false,
    sourceImageIds: [],
    splitNodeIds: [],
    resultKeys: [],
    manualResultIds: [],
  };

  keys.forEach((key) => {
    const namespacedKey = typeof key === 'string' ? key.match(/^image:([^:]+):(.+)$/) : null;
    const localKey = namespacedKey?.[2] || key;
    if (localKey === 'source') {
      if (namespacedKey?.[1]) plan.sourceImageIds.push(namespacedKey[1]);
      else plan.deleteSource = true;
    } else if (localKey.startsWith('split:')) {
      plan.splitNodeIds.push(localKey.slice('split:'.length));
    } else if (localKey.startsWith('result:')) {
      plan.resultKeys.push(key);
    } else if (localKey.startsWith('manual-result:')) {
      plan.manualResultIds.push(localKey.slice('manual-result:'.length));
    }
  });

  return plan;
}

export function shouldHandleCanvasDelete(event) {
  if (!['Delete', 'Backspace'].includes(event.key)) return false;
  return !event.target?.closest?.('input, textarea, select, [contenteditable="true"]');
}
