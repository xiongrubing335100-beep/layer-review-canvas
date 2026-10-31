// Keep each instruction attached to its own geometry until execution.
export function localRegionRequirements(layer) {
  return [['paths', layer.paths], ['repairPaths', layer.strategy?.repairPaths]].flatMap(([target, paths]) =>
    (paths ?? []).flatMap((path, index) => path.closed && path.requirements?.trim() ? [{
      target, pathId: path.id, label: `${target === 'repairPaths' ? '修复' : '轮廓'}区域 ${index + 1}`,
      kind: path.kind, requirements: path.requirements.trim(), path,
    }] : []));
}

export function combinedLayerRequirements(layer) {
  const local = localRegionRequirements(layer);
  return [layer.requirements?.trim() ? `整体处理要求：\n${layer.requirements.trim()}` : '',
    ...local.map(region => `${region.label}（${region.kind === 'exclude' ? '排除区域' : '选中区域'}）：\n${region.requirements}`),
  ].filter(Boolean).join('\n\n');
}

export function hasLocalRepairRequirements(layer) {
  return localRegionRequirements(layer).some(region => region.target === 'repairPaths' && region.kind === 'include');
}

export function executionRegionRequirements(layer, mapping) {
  const bounds = layer.bounds;
  const point = p => ({ x: p.x - bounds.x, y: p.y - bounds.y });
  const referencePoint = p => ({
    x: mapping.contentRegion.x + p.x * mapping.contentRegion.width / bounds.width,
    y: mapping.contentRegion.y + p.y * mapping.contentRegion.height / bounds.height,
  });
  return localRegionRequirements(layer).map(({ path, ...instruction }) => {
    const anchors = path.anchors.map(anchor => ({ ...point(anchor), in: point(anchor.in), out: point(anchor.out) }));
    return { ...instruction, coordinateSpace: 'selected_region_pixels', anchors,
      ...(mapping ? { referenceAnchors: anchors.map(anchor => ({ ...referencePoint(anchor), in: referencePoint(anchor.in), out: referencePoint(anchor.out) })) } : {}),
    };
  });
}
