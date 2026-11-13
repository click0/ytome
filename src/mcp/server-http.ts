/**
 * MCP сервер — HTTP/SSE транспорт
 * Для підключення через claude.ai у браузері
 *
 * Запуск: node dist/mcp/server-http.js
 * SSE endpoint: GET  http://localhost:PORT/sse
 * Messages:     POST http://localhost:PORT/messages?sessionId=...
 * Health:       GET  http://localhost:PORT/health
 *
 * Безпека:
 *   - не на loopback (MCP_HOST=0.0.0.0 тощо) сервер без MCP_API_KEY не стартує;
 *   - ключ — у Authorization: Bearer або x-api-key, порівняння за сталий час;
 *   - без ключа приймаються лише запити з Host = localhost (захист від DNS rebinding);
 *   - rate limit за IP ще до перевірки ключа, ліміт сесій і розміру тіла.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TOOLS, handleTool } from './handlers.js';
import { createLogger } from '../logger.js';
import { safeErrorMessage } from '../redact.js';
import { ensureSchema } from '../db/schema.js';

const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')).version;

dotenv.config({ quiet: true });

const log = createLogger('http');

export interface HttpConfig {
  host: string;
  port: number;
  apiKey: string;
  rateWindowMs: number;
  rateMax: number;
  maxSessions: number;
  /** Додаткові дозволені значення заголовка Host (без порту) */
  allowedHosts: string[];
  corsOrigins: string[];
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const list = (v?: string) => (v || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    host:         env.MCP_HOST || 'localhost',
    port:         parseInt(env.MCP_HTTP_PORT || '3000'),
    apiKey:       env.MCP_API_KEY || '',
    rateWindowMs: parseInt(env.RATE_LIMIT_WINDOW_MS || '60000'),
    rateMax:      parseInt(env.RATE_LIMIT_MAX || '60'),
    maxSessions:  parseInt(env.MCP_MAX_SESSIONS || '20'),
    allowedHosts: list(env.MCP_ALLOWED_HOSTS).map(h => h.toLowerCase()),
    corsOrigins:  list(env.MCP_CORS_ORIGINS),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase()) || /^127\./.test(host);
}

/** Ім'я хоста із заголовка Host без порту ("[::1]:3000" → "[::1]") */
function hostHeaderName(value?: string): string {
  if (!value) return '';
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  return v.split(':')[0];
}

/** Порівняння ключа за сталий час (довжина теж не витікає) */
function keyMatches(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Усі ключі, які клієнт міг надіслати */
function presentedKeys(req: Request): string[] {
  const keys: string[] = [];
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) keys.push(auth.replace(/^Bearer\s+/i, '').trim());
  const x = req.headers['x-api-key'];
  if (typeof x === 'string') keys.push(x.trim());
  return keys;
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function createMcpServer(): Server {
  const server = new Server(
    { name: 'ytome', version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args || {});
    } catch (e: any) {
      return err(safeErrorMessage(e));
    }
  });

  return server;
}

/** Причина, з якої конфігурація небезпечна для запуску, або null */
export function unsafeConfigReason(cfg: HttpConfig): string | null {
  if (!isLoopback(cfg.host) && !cfg.apiKey) {
    return `MCP_HOST=${cfg.host} відкриває сервер у мережу, але MCP_API_KEY не задано — ` +
      'будь-хто в мережі отримав би доступ до всіх інструментів. Задай MCP_API_KEY або MCP_HOST=localhost';
  }
  return null;
}

export function createApp(cfg: HttpConfig) {
  const sessions = new Map<string, SSEServerTransport>();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // claude.ai підключається з сервера, не з браузера; CORS — лише для локальних інструментів
  app.use(cors({
    origin: ['https://claude.ai', 'https://app.claude.ai', /^http:\/\/localhost(:\d+)?$/,
      /^http:\/\/127\.0\.0\.1(:\d+)?$/, ...cfg.corsOrigins],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  }));

  // Без ключа — лише локальні імена в Host: сайт через DNS rebinding сюди не дістанеться
  const allowedHostNames = new Set([...LOOPBACK, ...cfg.allowedHosts]);
  if (!isLoopback(cfg.host)) allowedHostNames.add(cfg.host.toLowerCase());
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (cfg.apiKey) return next();
    if (allowedHostNames.has(hostHeaderName(req.headers.host))) return next();
    res.status(403).json({ error: 'Host not allowed' });
  });

  const limiter = rateLimit({
    windowMs: cfg.rateWindowMs,
    limit: cfg.rateMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Ключ — IP (типовий генератор з урахуванням IPv6-підмереж), не заголовок клієнта
    handler: (req: Request, res: Response) => {
      log.warn({ ip: req.ip, path: req.path }, 'rate limit exceeded');
      res.status(429).json({ error: `Rate limit exceeded. Max ${cfg.rateMax} requests per ${cfg.rateWindowMs / 1000}s` });
    },
  });
  // До перевірки ключа — підбирати ключ теж обмежено
  app.use('/messages', limiter);
  app.use('/sse', limiter);

  function auth(req: Request, res: Response, next: NextFunction) {
    if (!cfg.apiKey) return next();
    if (presentedKeys(req).some(k => keyMatches(k, cfg.apiKey))) return next();
    res.status(401).json({ error: 'Unauthorized. Send MCP_API_KEY as Authorization: Bearer <key> or x-api-key' });
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'ytome-mcp',
      version: PKG_VERSION,
      transport: 'http+sse',
      sessions: sessions.size,
      tools: TOOLS.length,
      uptime_sec: Math.floor(process.uptime()),
    });
  });

  app.get('/tools', (_req: Request, res: Response) => {
    res.json({ tools: TOOLS.map(t => ({ name: t.name, description: t.description })) });
  });

  // SSE — клієнт отримує endpoint /messages?sessionId=<uuid транспорту>
  app.get('/sse', auth, async (req: Request, res: Response) => {
    if (sessions.size >= cfg.maxSessions) {
      res.status(503).json({ error: `Too many open sessions (max ${cfg.maxSessions})` });
      return;
    }
    const server = createMcpServer();
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    sessions.set(sessionId, transport);
    log.info({ sessionId, ip: req.ip }, 'SSE connection opened');

    res.on('close', () => {
      sessions.delete(sessionId);
      server.close().catch(() => { /* вже закрито */ });
      log.info({ sessionId }, 'SSE connection closed');
    });

    try {
      await server.connect(transport);
    } catch (e) {
      sessions.delete(sessionId);
      log.error({ error: safeErrorMessage(e) }, 'SSE connect failed');
    }
  });

  app.post('/messages', auth, express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ error: 'Unknown or missing sessionId. Reconnect via /sse' });
      return;
    }
    try {
      // Тіло вже розібрано express.json — передаємо його, потік прочитати вдруге не можна
      await transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      log.error({ sessionId, error: safeErrorMessage(e) }, 'SSE message error');
      if (!res.headersSent) res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  return { app, sessions };
}

function start(): void {
  const cfg = configFromEnv();
  const unsafe = unsafeConfigReason(cfg);
  if (unsafe) {
    log.fatal(unsafe);
    process.exitCode = 1;
    return;
  }

  ensureSchema();
  const { app, sessions } = createApp(cfg);
  const httpServer = app.listen(cfg.port, cfg.host, (e?: Error) => {
    if (e) return;   // обробляє 'error' нижче
    const baseUrl = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`;
    log.info({
      transport: 'http+sse', host: cfg.host, port: cfg.port,
      sse: `${baseUrl}/sse`, health: `${baseUrl}/health`, tools: TOOLS.length,
      rateLimit: `${cfg.rateMax} req / ${cfg.rateWindowMs / 1000}s`,
      apiKeyProtection: !!cfg.apiKey,
    }, 'YouTube Archive MCP — HTTP/SSE server started');

    if (cfg.host === '0.0.0.0') {
      for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets || []) {
          if (net.family === 'IPv4' && !net.internal) {
            log.info({ lan: `http://${net.address}:${cfg.port}/sse` }, 'LAN access available');
          }
        }
      }
    }

    // Сам ключ у лог не пишемо
    log.info({
      mcpServers: {
        ytome: {
          url: `${baseUrl}/sse`,
          ...(cfg.apiKey ? { headers: { Authorization: 'Bearer <MCP_API_KEY>' } } : {}),
        },
      },
    }, 'Claude Desktop Remote config');
  });

  httpServer.on('error', (e: NodeJS.ErrnoException) => {
    log.fatal({ error: e.message, code: e.code }, e.code === 'EADDRINUSE'
      ? `port ${cfg.port} is already in use — set MCP_HTTP_PORT`
      : 'HTTP server failed to start');
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    log.info('shutting down');
    sessions.clear();
    httpServer.close(() => process.exit(0));
  });
}

if (require.main === module) {
  start();
}
