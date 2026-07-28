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
const widgetUri = 'ui://layer-review/conversation-bridge.html';
const widgetHtml = await buildBridgeWidgetHtml(
  path.join(rootDirectory, 'public', 'layer-review-bridge-widget.html'),
  path.join(rootDirectory, 'public', 'layer-review-bridge-widget.js'),
);

function createLayerReviewBridgeServer() {
  const server = new McpServer({
    name: 'layer-review-conversation-bridge',
    version: '0.1.0',
  });

  registerAppResource(
    server,
    'layer-review-conversation-bridge',
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
          'openai/widgetDescription': '把 Layer Review 工作台提交的拆分任务直接发送到当前 Codex 会话。',
        },
      }],
    }),
  );

  registerAppTool(
    server,
    'open_layer_review_conversation_bridge',
    {
      title: '打开 Layer Review 会话桥接',
      description: 'Use this when the Layer Review workbench should send split tasks into the current Codex conversation instead of starting hidden background turns.',
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
        text: 'Layer Review 会话桥接已打开。请在工作台点击“拆分”。',
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
