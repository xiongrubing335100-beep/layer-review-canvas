import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildRouteMetadata } from './split-execution.js';

const allowedRoutes = new Set(['direct_crop', 'alpha_extract', 'codex_rgba', 'targeted_repair', 'result_refinement']);
const jobIdPattern = /^layer-job-[a-zA-Z0-9._-]+$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maximumDecodedPngBytes = 512 * 1024 * 1024;
const unsafeLayerIdCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
const windowsDrivePrefix = /^[A-Za-z]:/;
const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc >>> 0;
});

function fail(message, code = 'PREFLIGHT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeLayerId(value, fallback) {
  const layerId = String(value ?? fallback ?? '');
  if (!layerId
    || layerId !== layerId.trim()
    || layerId.includes('..')
    || unsafeLayerIdCharacters.test(layerId)
    || windowsDrivePrefix.test(layerId)
    || windowsReservedName.test(layerId)
    || /[. ]$/.test(layerId)) {
    throw fail(`layer id 不安全：${layerId || '(empty)'}`);
  }
  return layerId;
}

async function requireFile(filePath, label) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) throw fail(`${label}不是有效文件`);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(`${label}不存在`);
    throw error;
  }
  await access(filePath);
  return filePath;
}

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) crc = pngCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFail(detail) {
  return fail(`result_refinement PNG ${detail}`);
}

async function readPngSize(filePath) {
  const png = await readFile(filePath);
  if (png.length < pngSignature.length || !png.subarray(0, 8).equals(pngSignature)) {
    throw pngFail('签名无效');
  }

  let offset = pngSignature.length;
  let chunkIndex = 0;
  let header = null;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;
  const compressedParts = [];
  while (offset < png.length) {
    if (sawIend) throw pngFail('IEND 后存在非法尾随数据');
    if (png.length - offset < 12) throw pngFail('chunk 已截断');
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw pngFail('chunk 数据已截断');
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const typeBytes = png.subarray(typeStart, dataStart);
    const data = png.subarray(dataStart, dataEnd);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) throw pngFail('chunk 类型无效');
    if (png.readUInt32BE(dataEnd) !== crc32(typeBytes, data)) {
      throw pngFail(`${type} CRC 校验失败`);
    }
    if (chunkIndex === 0 && type !== 'IHDR') throw pngFail('首个 chunk 必须是 IHDR');

    if (type === 'IHDR') {
      if (header || chunkIndex !== 0 || length !== 13) throw pngFail('IHDR 必须唯一、位于首块且长度为 13');
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      if (header.width <= 0 || header.height <= 0) throw pngFail('尺寸无效');
      if (header.bitDepth !== 8
        || header.colorType !== 6
        || header.compression !== 0
        || header.filter !== 0
        || header.interlace !== 0) {
        throw pngFail('必须是 8-bit RGBA non-interlaced 格式');
      }
    } else if (type === 'IDAT') {
      if (!header || idatEnded) throw pngFail('IDAT 顺序无效');
      sawIdat = true;
      compressedParts.push(data);
    } else if (type === 'IEND') {
      if (!header || !sawIdat || length !== 0) throw pngFail('IEND 无效或缺少 IDAT');
      sawIend = true;
    } else if (sawIdat) {
      idatEnded = true;
    }

    offset = dataEnd + 4;
    chunkIndex += 1;
  }
  if (!header || !sawIdat || !sawIend) throw pngFail('缺少完整 IHDR、IDAT 或 IEND');

  const rowBytes = header.width * 4 + 1;
  const decodedBytes = rowBytes * header.height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maximumDecodedPngBytes) {
    throw pngFail('解压后像素数据过大');
  }
  const compressed = Buffer.concat(compressedParts);
  let inflation;
  try {
    inflation = inflateSync(compressed, { info: true, maxOutputLength: decodedBytes });
  } catch {
    throw pngFail('IDAT zlib 数据无法解压');
  }
  if (inflation.engine.bytesWritten !== compressed.length) {
    throw pngFail('IDAT zlib 数据包含未消费的尾随字节');
  }
  const decoded = inflation.buffer;
  if (decoded.length !== decodedBytes) throw pngFail('解压后的扫描行长度无效');
  for (let y = 0; y < header.height; y += 1) {
    if (decoded[y * rowBytes] > 4) throw pngFail('扫描行 filter byte 无效');
  }
  return { width: header.width, height: header.height };
}

function normalizeRequirement(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function expectedOutput(layer) {
  const output = layer.expected_output || layer.output || {};
  const width = Number(output.width);
  const height = Number(output.height);
  const x = Number(output.original_source_x ?? layer.source_region_pixels?.x);
  const y = Number(output.original_source_y ?? layer.source_region_pixels?.y);
  if (![width, height, x, y].every(Number.isFinite) || width <= 0 || height <= 0 || x < 0 || y < 0) {
    throw fail(`${layer.name || layer.id || '图层'}缺少有效的期望输出尺寸或原始坐标`);
  }
  return { width, height, original_source_x: x, original_source_y: y };
}

function repairRegions(layer) {
  if (layer.repair_regions === undefined || layer.repair_regions === null) return null;
  if (!Array.isArray(layer.repair_regions)) throw fail(`${layer.name || layer.id || '图层'}的 repair_regions 必须是数组`);
  const source = layer.repair_region_source;
  if (!['submitted_annotation', 'codex_declared'].includes(source)) {
    throw fail(`${layer.name || layer.id || '图层'}的 repair_region_source 不受支持`);
  }
  return layer.repair_regions;
}

function finitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

function normalizedPoint(point) {
  return finitePoint(point)
    && point.x >= 0 && point.x <= 1
    && point.y >= 0 && point.y <= 1;
}

function validateRefinementPaths(layer, pngSize) {
  const layerName = layer.name || layer.id || '图层';
  const annotations = layer.mask_annotations ?? [];
  if (!Array.isArray(annotations)) throw fail(`${layerName} 的 mask_annotations 必须是数组`);
  for (const annotation of annotations) {
    if (annotation?.shape !== 'bezier_path') {
      throw fail(`${layerName} 的 result_refinement 仅支持 bezier_path 标注`);
    }
    if (annotation.closed !== true) throw fail(`${layerName} 的 bezier_path 必须 closed=true`);
    if (!Array.isArray(annotation.anchors) || annotation.anchors.length < 3) {
      throw fail(`${layerName} 的 bezier_path 至少需要三个 anchors 锚点`);
    }
    const distinctAnchors = new Set(annotation.anchors.map((anchor) => `${anchor?.x},${anchor?.y}`));
    if (distinctAnchors.size < 3 || !annotation.anchors.every((anchor) => (
      normalizedPoint(anchor)
      && finitePoint(anchor.in)
      && finitePoint(anchor.out)
      && typeof anchor.handlesLinked === 'boolean'
    ))) {
      throw fail(`${layerName} 的 bezier_path anchors 锚点或控制柄无效`);
    }
    const flattened = annotation.source_polygon_pixels;
    if (!Array.isArray(flattened) || flattened.length < 3) {
      throw fail(`${layerName} 的 bezier_path source_polygon_pixels 扁平像素至少需要三个点`);
    }
    if (!flattened.every((point) => (
      finitePoint(point)
      && point.x >= 0 && point.x <= pngSize.width
      && point.y >= 0 && point.y <= pngSize.height
    ))) {
      throw fail(`${layerName} 的 bezier_path source_polygon_pixels 扁平像素超出 PNG 边界`);
    }
  }
  return annotations;
}

function validateRefinementDimensions(plan, layer, output, pngSize) {
  const declaredCanvas = plan.source?.canvas;
  if (!Number.isInteger(declaredCanvas?.width)
    || !Number.isInteger(declaredCanvas?.height)
    || declaredCanvas.width !== pngSize.width
    || declaredCanvas.height !== pngSize.height) {
    throw fail('result_refinement 声明的画布尺寸必须与 PNG 像素尺寸完全一致');
  }
  if (output.width !== pngSize.width
    || output.height !== pngSize.height
    || output.original_source_x !== 0
    || output.original_source_y !== 0) {
    throw fail(`${layer.name || layer.id || '图层'}的期望输出必须等于完整 PNG 像素尺寸`);
  }
  const sourceRegion = layer.source_region_pixels;
  if (!sourceRegion
    || sourceRegion.x !== 0
    || sourceRegion.y !== 0
    || sourceRegion.width !== pngSize.width
    || sourceRegion.height !== pngSize.height) {
    throw fail(`${layer.name || layer.id || '图层'}的 source_region_pixels 必须等于完整 PNG 像素尺寸`);
  }
}

export async function buildTargetedExecutionSpec({
  jobId,
  jobDirectory,
  plan,
  clock = () => new Date().toISOString(),
}) {
  const preflightStartedAt = clock();
  if (!jobIdPattern.test(String(jobId || ''))) throw fail('jobId 格式无效');
  if (path.basename(path.resolve(jobDirectory)) !== jobId) throw fail('jobId 与任务目录不一致');
  if (!plan || typeof plan !== 'object') throw fail('权威计划无效');

  const finalDirectory = path.resolve(jobDirectory, 'final');
  const outputDirectory = path.resolve(plan.output_directory || finalDirectory);
  if (outputDirectory !== finalDirectory) throw fail('输出目录必须位于当前任务的 final 目录');
  const sourcePath = plan.source?.local_path;
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw fail('权威计划缺少原图本地路径');
  await requireFile(sourcePath, '原图');

  if (!Array.isArray(plan.layers) || plan.layers.length === 0) throw fail('权威计划缺少 layers[]');
  const hasResultRefinement = plan.layers.some((layer) => layer.execution_route_hint === 'result_refinement');
  const refinementPngSize = hasResultRefinement ? await readPngSize(sourcePath) : null;
  const layers = [];
  for (const [index, layer] of plan.layers.entries()) {
    const layerId = safeLayerId(layer.id, `layer-${index + 1}`);
    const layerName = layer.name || layerId || `拆分项 ${index + 1}`;
    if (layer.layer_index !== undefined && layer.layer_index !== index + 1) {
      throw fail(`${layerName} 的 layer_index 顺序不一致`);
    }
    const route = layer.execution_route_hint;
    if (!allowedRoutes.has(route)) throw fail(`${layerName} 的执行路线不受支持`);
    const isResultRefinement = route === 'result_refinement';
    if (isResultRefinement && plan.task !== 'refine_split_result') {
      throw fail(`${layerName} 的 result_refinement 路线要求 task === refine_split_result`);
    }
    const cropPath = isResultRefinement ? sourcePath : layer.review_snapshot?.local_crop_path;
    if (typeof cropPath !== 'string' || !path.isAbsolute(cropPath)) throw fail(`${layerName} 缺少框选预览本地路径`);
    if (!isResultRefinement) await requireFile(cropPath, `${layerName}框选预览`);
    const output = expectedOutput(layer);
    const refinementAnnotations = isResultRefinement
      ? validateRefinementPaths(layer, refinementPngSize)
      : null;
    if (isResultRefinement) {
      validateRefinementDimensions(plan, layer, output, refinementPngSize);
      if (layer.transparency_strategy !== undefined
        && layer.transparency_strategy !== 'preserve_existing_alpha') {
        throw fail(`${layerName} 的 transparency_strategy 必须是 preserve_existing_alpha`);
      }
      if (layer.rmbg_required !== undefined && layer.rmbg_required !== false) {
        throw fail(`${layerName} 的 result_refinement 要求 rmbg_required 严格为 false，禁止运行 RMBG`);
      }
      if (layer.output_resolution_policy !== undefined
        && layer.output_resolution_policy !== 'existing_result_pixels') {
        throw fail(`${layerName} 的 output_resolution_policy 必须是 existing_result_pixels`);
      }
      if (!normalizeRequirement(layer.requirement) && refinementAnnotations.length === 0) {
        throw fail(`${layerName} 必须包含文字要求或至少一条有效闭合路径`);
      }
    }
    const repairRegionsValue = repairRegions(layer);
    const inferredMetadata = buildRouteMetadata({
      category: layer.category,
      requirement: layer.requirement,
      executionMode: layer.execution_mode || 'fast',
      executionRoute: route,
      removeBackground: Boolean(layer.remove_background),
      sourceRegionPixels: output,
    });
    const transparency = layer.transparency_strategy || inferredMetadata.transparency_strategy;
    if (route === 'targeted_repair' && transparency === 'codex_rgba') {
      throw fail(`${layerName} 不支持 targeted_repair 与 codex_rgba 组合；文字透明层必须使用 codex_rgba 路线`);
    }
    const repairEngine = layer.repair_engine ?? inferredMetadata.repair_engine;
    const maximumImagegenCalls = Number(layer.maximum_imagegen_calls ?? inferredMetadata.maximum_imagegen_calls);
    if (!Number.isInteger(maximumImagegenCalls) || maximumImagegenCalls < 0) {
      throw fail(`${layerName} 的 ImageGen 调用上限无效`);
    }
    layers.push({
      layer_index: index + 1,
      id: layerId,
      name: layerName,
      category: layer.category || null,
      requirement: normalizeRequirement(layer.requirement),
      execution_mode: layer.execution_mode || 'fast',
      execution_route_hint: route,
      repair_engine: repairEngine,
      requires_global_context: layer.requires_global_context === undefined
        ? inferredMetadata.requires_global_context
        : Boolean(layer.requires_global_context),
      maximum_imagegen_calls: maximumImagegenCalls,
      transparency_strategy: transparency,
      rmbg_required: Boolean(layer.rmbg_required ?? inferredMetadata.rmbg_required),
      structure_validation_required: Boolean(
        layer.structure_validation_required ?? inferredMetadata.structure_validation_required
      ),
      imagegen_input_kind: layer.imagegen_input_kind ?? inferredMetadata.imagegen_input_kind,
      imagegen_canvas_policy: layer.imagegen_canvas_policy ?? inferredMetadata.imagegen_canvas_policy,
      output_resolution_policy: layer.output_resolution_policy
        ?? inferredMetadata.output_resolution_policy
        ?? 'logical_crop',
      expected_output: output,
      repair_regions: repairRegionsValue,
      repair_region_source: layer.repair_region_source || null,
      ...(isResultRefinement ? {
        source_region_pixels: { ...layer.source_region_pixels },
        mask_annotations: refinementAnnotations,
      } : {}),
      crop_path: cropPath,
    });
  }

  return {
    version: 1,
    job_id: jobId,
    source_path: sourcePath,
    output_directory: finalDirectory,
    generated_directory: path.resolve(jobDirectory, 'generated'),
    layers,
    timing: {
      preflight_started_at: preflightStartedAt,
      preflight_completed_at: clock(),
    },
  };
}
