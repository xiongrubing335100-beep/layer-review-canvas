const categoryOrder = ['kvTitle', 'kvElement', 'kvBackground', 'ordinaryText', 'uiComponent'];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function colorDistance(data, index, reference) {
  return (
    Math.abs(data[index] - reference[0])
    + Math.abs(data[index + 1] - reference[1])
    + Math.abs(data[index + 2] - reference[2])
  ) / 3;
}

function colorDifference(data, firstIndex, secondIndex) {
  return (
    Math.abs(data[firstIndex] - data[secondIndex])
    + Math.abs(data[firstIndex + 1] - data[secondIndex + 1])
    + Math.abs(data[firstIndex + 2] - data[secondIndex + 2])
  ) / 3;
}

function pixelSaturation(data, index) {
  const maximum = Math.max(data[index], data[index + 1], data[index + 2]);
  const minimum = Math.min(data[index], data[index + 1], data[index + 2]);
  return maximum - minimum;
}

function cornerReference(data, width, height) {
  const coordinates = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  return [0, 1, 2].map((channel) => coordinates.reduce((total, [x, y]) => (
    total + data[(y * width + x) * 4 + channel]
  ), 0) / coordinates.length);
}

function buildActivityMap({ data, width, height }) {
  const reference = cornerReference(data, width, height);
  const activity = new Float32Array(width * height);
  const saturation = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      const rightIndex = (y * width + Math.min(width - 1, x + 1)) * 4;
      const lowerIndex = (Math.min(height - 1, y + 1) * width + x) * 4;
      const mapIndex = y * width + x;
      const backgroundDistance = colorDistance(data, pixelIndex, reference);
      const edgeDifference = Math.max(
        colorDifference(data, pixelIndex, rightIndex),
        colorDifference(data, pixelIndex, lowerIndex),
      );
      activity[mapIndex] = backgroundDistance * 0.72 + edgeDifference * 0.28;
      saturation[mapIndex] = pixelSaturation(data, pixelIndex);
    }
  }

  return { activity, saturation };
}

function activeBands(activity, width, height) {
  const rows = Array.from({ length: height }, (_, y) => {
    let total = 0;
    for (let x = 0; x < width; x += 1) total += activity[y * width + x];
    return total / width;
  });
  const baseline = median(rows);
  const peak = Math.max(...rows);
  const threshold = baseline + Math.max(4, (peak - baseline) * 0.24);
  const bands = [];
  let current = null;

  rows.forEach((score, y) => {
    if (score >= threshold) {
      if (!current || y - current.end > 3) {
        current = { start: y, end: y, score };
        bands.push(current);
      } else {
        current.end = y;
        current.score += score;
      }
    }
  });

  return bands.map((band) => ({
    ...band,
    score: band.score / Math.max(1, band.end - band.start + 1),
  }));
}

function describeBand(band, activity, saturation, width, height) {
  const columnScores = Array.from({ length: width }, () => 0);
  let saturationTotal = 0;
  let sampleCount = 0;
  for (let y = band.start; y <= band.end; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      columnScores[x] += activity[index];
      saturationTotal += saturation[index];
      sampleCount += 1;
    }
  }
  const columnBase = median(columnScores);
  const columnPeak = Math.max(...columnScores);
  const columnThreshold = columnBase + Math.max(3, (columnPeak - columnBase) * 0.2);
  const activeColumns = columnScores
    .map((score, x) => ({ score, x }))
    .filter(({ score }) => score >= columnThreshold)
    .map(({ x }) => x);
  const startX = activeColumns.length ? Math.min(...activeColumns) : 0;
  const endX = activeColumns.length ? Math.max(...activeColumns) : width - 1;
  const x = clamp(startX - 1, 0, width - 1);
  const y = clamp(band.start - 1, 0, height - 1);
  const right = clamp(endX + 2, x + 1, width);
  const bottom = clamp(band.end + 2, y + 1, height);

  return {
    ...band,
    saturation: saturationTotal / Math.max(1, sampleCount),
    area: (right - x) * (bottom - y),
    bounds: {
      x: Number(((x / width) * 100).toFixed(1)),
      y: Number(((y / height) * 100).toFixed(1)),
      width: Number((((right - x) / width) * 100).toFixed(1)),
      height: Number((((bottom - y) / height) * 100).toFixed(1)),
    },
  };
}

function fallbackBounds(category) {
  if (category === 'kvTitle') return { x: 8, y: 4, width: 84, height: 16 };
  if (category === 'kvElement') return { x: 8, y: 18, width: 84, height: 34 };
  if (category === 'ordinaryText') return { x: 6, y: 44, width: 88, height: 28 };
  if (category === 'uiComponent') return { x: 6, y: 68, width: 88, height: 26 };
  return { x: 0, y: 0, width: 100, height: 100 };
}

export function analyzeFastCategories(imageData) {
  const { data, width, height } = imageData || {};
  if (!data || width < 2 || height < 2 || data.length < width * height * 4) {
    return categoryOrder.map((category) => ({ category, bounds: fallbackBounds(category) }));
  }

  const { activity, saturation } = buildActivityMap({ data, width, height });
  const bands = activeBands(activity, width, height)
    .map((band) => describeBand(band, activity, saturation, width, height));
  const used = new Set();
  const title = bands.find((band) => band.start / height < 0.45) || bands[0];
  if (title) used.add(title);
  const element = bands
    .filter((band) => !used.has(band))
    .sort((left, right) => right.saturation - left.saturation || right.score - left.score)[0];
  if (element) used.add(element);
  const component = bands
    .filter((band) => !used.has(band))
    .sort((left, right) => right.area - left.area || right.score - left.score)[0];
  if (component) used.add(component);
  const textBands = bands.filter((band) => !used.has(band));
  const text = textBands.length
    ? {
        bounds: {
          x: Math.min(...textBands.map((band) => band.bounds.x)),
          y: Math.min(...textBands.map((band) => band.bounds.y)),
          width: Math.max(...textBands.map((band) => band.bounds.x + band.bounds.width))
            - Math.min(...textBands.map((band) => band.bounds.x)),
          height: Math.max(...textBands.map((band) => band.bounds.y + band.bounds.height))
            - Math.min(...textBands.map((band) => band.bounds.y)),
        },
      }
    : null;
  const byCategory = {
    kvTitle: title?.bounds,
    kvElement: element?.bounds,
    kvBackground: fallbackBounds('kvBackground'),
    ordinaryText: text?.bounds,
    uiComponent: component?.bounds,
  };

  return categoryOrder.map((category) => ({
    category,
    bounds: byCategory[category] || fallbackBounds(category),
  }));
}
