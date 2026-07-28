import { readFile } from 'node:fs/promises';
import path from 'node:path';

const scriptPlaceholder = '/*__LAYER_REVIEW_BRIDGE_SCRIPT__*/';
const workbenchOrigin = 'http://127.0.0.1:4173/';

export async function buildBridgeWidgetHtml(htmlPath, scriptPath) {
  const [html, script] = await Promise.all([
    readFile(htmlPath, 'utf8'),
    readFile(scriptPath, 'utf8'),
  ]);
  return html.replace(scriptPlaceholder, script);
}

function assetPath(indexPath, source) {
  return path.join(path.dirname(indexPath), source.replace(/^\/+/, ''));
}

export async function buildWorkbenchWidgetHtml(indexPath) {
  let html = await readFile(indexPath, 'utf8');
  const scriptMatches = [...html.matchAll(/<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/gi)];
  const styleMatches = [...html.matchAll(/<link\b([^>]*?)\bhref="([^"]+\.css)"([^>]*)>/gi)];

  for (const match of scriptMatches) {
    const script = await readFile(assetPath(indexPath, match[2]), 'utf8');
    html = html.replace(match[0], `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`);
  }
  for (const match of styleMatches) {
    const style = await readFile(assetPath(indexPath, match[2]), 'utf8');
    html = html.replace(match[0], `<style>${style.replace(/<\/style/gi, '<\\/style')}</style>`);
  }

  return html.replace(/<head>/i, `<head>\n    <base href="${workbenchOrigin}">`);
}
