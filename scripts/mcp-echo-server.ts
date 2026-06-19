import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'aiop-local-echo', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Return the provided text. Used to verify MCP wiring.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') {
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
    };
  }
  const args = request.params.arguments ?? {};
  const text = typeof args.text === 'string' ? args.text : JSON.stringify(args);
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
