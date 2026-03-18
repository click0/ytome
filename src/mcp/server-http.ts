/**
 * MCP сервер — HTTP/SSE транспорт
 * Для підключення через claude.ai у браузері
 *
 * Запуск: node dist/mcp/server-http.js
 * SSE endpoint: GET  http://localhost:PORT/sse
 * Messages:     POST http://localhost:PORT/messages?sessionId=...
 * Health:       GET  http://localhost:PORT/health
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { TOOLS, handleTool } from './handlers.js';
import { createLogger } from '../logger.js';

dotenv.config();

const log = createLogger('http');

const PORT     = parseInt(process.env.MCP_HTTP_PORT || '3000');
const API_KEY  = process.env.MCP_API_KEY || '';            // опц. захист
const HOST     = process.env.MCP_HOST    || 'localhost';   // '0.0.0.0' для LAN

// =============================================
// Сесії (SSEServerTransport прив'язаний до res)
// =============================================

const sessions = new Map<string, SSEServerTransport>();

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function createMcpServer(): Server {
  const server = new Server(
    { name: 'ytome', version: '0.75.0' },
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

  return server;
}

// =============================================
// Express app
// =============================================

const app = express();

// CORS — дозволяємо claude.ai
app.use(cors({
  origin: [
    'https://claude.ai',
    'https://app.claude.ai',
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
    /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

app.use(express.json());

// =============================================
// Rate Limiting
// =============================================

const RATE_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000');  // 1 min
const RATE_MAX       = parseInt(process.env.RATE_LIMIT_MAX || '60');           // 60 req/min

const limiter = rateLimit({
  windowMs:  RATE_WINDOW_MS,
  max:       RATE_MAX,
  standardHeaders: true,   // RateLimit-* headers
  legacyHeaders:   false,
  message: { error: `Rate limit exceeded. Max ${RATE_MAX} requests per ${RATE_WINDOW_MS / 1000}s` },
  keyGenerator: (req: Request) => {
    // API key або IP як ключ
    return (req.headers['x-api-key'] as string)
        || req.headers['authorization']?.replace('Bearer ', '')
        || req.ip
        || 'unknown';
  },
  handler: (req: Request, res: Response) => {
    log.warn({ ip: req.ip, path: req.path }, 'rate limit exceeded');
    res.status(429).json({
      error: `Rate limit exceeded. Max ${RATE_MAX} requests per ${RATE_WINDOW_MS / 1000}s`,
    });
  },
});

// Застосовуємо rate limit до /messages та /sse (не до /health і /tools)
app.use('/messages', limiter);
app.use('/sse', limiter);

// =============================================
// Middleware: опціональна API key авторизація
// =============================================

function authMiddleware(req: Request, res: Response, next: Function) {
  if (!API_KEY) return next(); // захист не налаштований

  const token =
    req.headers['authorization']?.replace('Bearer ', '') ||
    req.headers['x-api-key'] as string;

  if (token !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized. Set MCP_API_KEY in .env' });
    return;
  }
  next();
}

// =============================================
// Endpoints
// =============================================

// Health check — без авторизації
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'ytome-mcp',
    version: '0.75.0',
    transport: 'http+sse',
    sessions: sessions.size,
    tools: TOOLS.length,
    uptime_sec: Math.floor(process.uptime()),
  });
});

// Список інструментів — без авторизації (для discovery)
app.get('/tools', (_req: Request, res: Response) => {
  res.json({ tools: TOOLS.map(t => ({ name: t.name, description: t.description })) });
});

// SSE endpoint — claude.ai підключається сюди
app.get('/sse', authMiddleware, async (req: Request, res: Response) => {
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  log.info({ sessionId, ip: req.ip }, 'SSE connection opened');

  const server    = createMcpServer();
  const transport = new SSEServerTransport(`/messages?sessionId=${sessionId}`, res);

  sessions.set(sessionId, transport);

  // Підключаємо сервер до транспорту
  await server.connect(transport);

  // Чистимо при відключенні
  req.on('close', () => {
    log.info({ sessionId }, 'SSE connection closed');
    sessions.delete(sessionId);
  });
});

// POST /messages — claude.ai шле повідомлення сюди
app.post('/messages', authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId query parameter' });
    return;
  }

  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: `Session ${sessionId} not found. Reconnect via /sse` });
    return;
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (e: any) {
    log.error({ sessionId, error: e.message }, 'SSE message error');
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

// =============================================
// Запуск
// =============================================

app.listen(PORT, HOST, () => {
  const baseUrl = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

  log.info({
    transport: 'http+sse',
    host: HOST,
    port: PORT,
    sse:     `${baseUrl}/sse`,
    messages:`${baseUrl}/messages`,
    health:  `${baseUrl}/health`,
    tools:   TOOLS.length,
    rateLimit: `${RATE_MAX} req / ${RATE_WINDOW_MS / 1000}s`,
    apiKeyProtection: !!API_KEY,
  }, 'YouTube Archive MCP — HTTP/SSE server started');

  if (HOST === '0.0.0.0') {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          log.info({ lan: `http://${net.address}:${PORT}/sse` }, 'LAN access available');
        }
      }
    }
  }

  log.info({
    mcpServers: {
      'youtube-archive': {
        url: `${baseUrl}/sse`,
        ...(API_KEY ? { headers: { Authorization: `Bearer ${API_KEY}` } } : {}),
      },
    },
  }, 'Claude Desktop Remote config');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log.info('shutting down');
  sessions.clear();
  process.exit(0);
});
