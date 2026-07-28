import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { buildWorkbenchWidgetHtml } from './src/mcp-bridge-resource.js';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetUri = 'ui://layer-review/workbench-v4.html';
const legacyWidgetUris = [
  'ui://layer-review/conversation-bridge-v3.html',
  'ui://layer-review/workbench-v2.html',
];
const widgetHtml = await buildWorkbenchWidgetHtml(path.join(rootDirectory, 'dist', 'index.html'));

function createLayerReviewBridgeServer() {
  const server = new McpServer({
    name: 'layer-review-workbench',
    version: '0.3.0',
  });

  for (const [index, resourceUri] of [widgetUri, ...legacyWidgetUris].entries()) {
    registerAppResource(
      server,
      `layer-review-workbench-${index}`,
      resourceUri,
      {},
      async () => ({
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: widgetHtml,
          _meta: {
            ui: {
              csp: {
                connectDomains: ['http://127.0.0.1:4173'],
                resourceDomains: [],
              },
              prefersBorder: false,
            },
            'openai/widgetDescription': '完整的 Layer Review 拆图工作台；在当前 Codex 任务内直接提交拆分消息并接收 PNG。',
          },
        }],
      }),
    );
  }

  const toolDefinition = {
      title: '打开 Layer Review 工作台',
      description: 'Open the full Layer Review workbench in the current Codex task. Use this whenever the user asks to open or use the Layer Review workbench.',
      inputSchema: {},
      outputSchema: {
        state: z.literal('ready'),
        workbenchUrl: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { resourceUri: widgetUri },
        'openai/outputTemplate': widgetUri,
      },
    };
  const toolHandler = async () => ({
      content: [{
        type: 'text',
        text: 'Layer Review 工作台已在当前 Codex 任务中打开。点击“拆分”会直接发送到当前任务。',
      }],
      structuredContent: {
        state: 'ready',
        workbenchUrl: 'http://127.0.0.1:4173/',
      },
    });

  registerAppTool(server, 'connect_layer_review_workbench', toolDefinition, toolHandler);
  registerAppTool(server, 'open_layer_review_workbench', toolDefinition, toolHandler);

  return server;
}

const port = Number(process.env.LAYER_REVIEW_MCP_PORT || 4174);
const mcpPath = '/mcp';
const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
  if (request.method === 'OPTIONS' && url.pathname === mcpPath) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Layer Review MCP App');
    return;
  }
  if (url.pathname === mcpPath && ['POST', 'GET', 'DELETE'].includes(request.method || '')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    const server = createLayerReviewBridgeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) response.writeHead(500).end('Internal server error');
    }
    return;
  }
  response.writeHead(404).end('Not Found');
});

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`Layer Review MCP App listening on http://127.0.0.1:${port}${mcpPath}`);
});
