/**
 * MCP сервер — stdio транспорт
 * Для підключення до Claude Desktop
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { TOOLS, handleTool } from './handlers.js';

dotenv.config();

function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

async function main() {
  const server = new Server(
    { name: 'youtube-archive', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args || {});
    } catch (e: any) {
      return err(e.message || 'Unknown error');
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ YouTube Archive MCP server started (stdio)');
}

main().catch(console.error);
