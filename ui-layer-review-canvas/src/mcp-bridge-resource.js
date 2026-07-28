import { readFile } from 'node:fs/promises';

const scriptPlaceholder = '/*__LAYER_REVIEW_BRIDGE_SCRIPT__*/';

export async function buildBridgeWidgetHtml(htmlPath, scriptPath) {
  const [html, script] = await Promise.all([
    readFile(htmlPath, 'utf8'),
    readFile(scriptPath, 'utf8'),
  ]);
  return html.replace(scriptPlaceholder, script);
}
