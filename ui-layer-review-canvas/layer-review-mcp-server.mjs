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
import { buildBridgeWidgetHtml } from './src/mcp-bridge-resource.js';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetUri = 'ui://layer-review/conversation-bridge-v3.html';
const widgetHtml = await buildBridgeWidgetHtml(
  path.join(rootDirectory, 'public', 'layer-review-bridge-widget.html'),
  path.join(rootDirectory, 'public', 'layer-review-bridge-widget.js'),
);

function createLayerReviewBridgeServer() {
  const server = new McpServer({
    name: 'layer-review-workbench',
    version: '0.3.0',
  });

  registerAppResource(
    server,
    'layer-review-workbench',
    widgetUri,
    {},
    async () => ({
      contents: [{
        uri: widgetUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            csp: {
              connectDomains: ['http://127.0.0.1:4173'],
              resourceDomains: [],
            },
            prefersBorder: true,
          },
          'openai/widgetDescription': '连接右侧的 Layer Review 工作台，把已确认的拆分任务发送到当前 Codex 任务。',
        },
      }],
    }),
  );

  registerAppTool(
    server,
    'connect_layer_review_workbench',
    {
      title: '连接 Layer Review 工作台',
      description: 'Connect the Layer Review workbench to the current Codex task. Use this whenever the user asks to open or use the Layer Review workbench.',
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
    },
    async () => ({
      content: [{
        type: 'text',
        text: 'Layer Review 工作台已连接当前 Codex 任务。点击“拆分”会把任务发送到当前任务。',
      }],
      structuredContent: {
        state: 'ready',
        workbenchUrl: 'http://127.0.0.1:4173/',
      },
    }),
  );

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
    response.end('Layer Review conversation bridge');
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
  console.log(`Layer Review MCP bridge listening on http://127.0.0.1:${port}${mcpPath}`);
});
