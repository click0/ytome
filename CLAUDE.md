# ytome

Independent YouTube archiving system with Claude integration via MCP.

## Quick start

```bash
npm ci
npm run build
npm test
```

## Architecture

- **MCP server**: `src/mcp/` — stdio (Claude Desktop) + HTTP/SSE (claude.ai), 50+ tools
- **YouTube API**: `src/youtube/` — Data API v3, transcript (youtube-transcript-plus), yt-dlp
- **Database**: `src/db/` — SQLite via better-sqlite3, singleton connection (WAL mode)
- **AI balancer**: `src/ai/` — Claude, Ollama, Groq, OpenRouter, LM Studio with fallback
- **Proxy**: `src/proxy/` — HTTP/HTTPS/SOCKS5 rotation, async ESM agents
- **Evaluation**: `src/evaluation/` — video scoring 0-100, AI stubs marked TODO
- **Cache**: `src/cache/` — offline-first resolver (DB → files → network)
- **Filters**: `src/filters/` — whitelist/blacklist engine
- **Scheduler**: `src/scheduler/` — cron-based channel checking
- **Logger**: `src/logger.ts` — pino structured logging
- **Validation**: `src/mcp/validation.ts` — Zod schemas for all MCP tool inputs

## Database

SQLite singleton via `getDb()` from `src/db/init.ts`. Never call `db.close()` manually — the connection is closed automatically on process exit.

Migrations: `src/db/migrate-002.ts` through `migrate-006.ts`
(005: profiles + music tables, 006: sheet_exports).

## Key conventions

- Version is read from `package.json` at runtime (PKG_VERSION in MCP servers)
- YouTube client (`getYoutube()`) is shared — exported from `src/youtube/api.ts`, used in `comments.ts`
- Proxy agent functions are async (ESM dynamic imports): `buildAgent()`, `axiosProxyConfig()`, `googleApiProxyConfig()`
- All MCP tool inputs validated via Zod schemas in `src/mcp/validation.ts`
- Logging via `createLogger('module')` from `src/logger.ts` — never use `console.log`

## Testing

```bash
npm test          # vitest run (87 tests)
npm run test:watch
```

Tests in `tests/`: validation, helpers, filters, evaluation, logger.

## CI/CD

- `.github/workflows/ci.yml` — type check + build + test on push/PR
- `.github/workflows/release.yml` — build + package `ytome-{version}.tar.gz` on `v*` tags
