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
- **AI balancer**: `src/ai/` — Claude, Ollama, Groq, OpenRouter, LM Studio with fallback. Claude is routed by tier (`fast`/`balanced`/`top` → `claudeModel()`, defaults Haiku 5.5 / Sonnet 5.5 / Opus 5.5, `CLAUDE_MODEL_*` overrides); model ids, prices and capabilities live only in `MODEL_INFO` in `src/ai/claude.ts`. Calls go through `client.beta.messages` (server-side fallback), `effort` by task complexity, `schema` → structured outputs
- **Proxy**: `src/proxy/` — HTTP/HTTPS/SOCKS5 rotation, async ESM agents
- **Evaluation**: `src/evaluation/` — video scoring 0-100, AI stubs marked TODO
- **Cache**: `src/cache/` — offline-first resolver (DB → files → network)
- **Filters**: `src/filters/` — whitelist/blacklist engine
- **Scheduler**: `src/scheduler/` — cron-based channel checking; RSS detection (`src/youtube/rss.ts`) for already-synced channels, `search.list` only for first sync
- **Transcripts**: `fetchTranscript` in `src/youtube/api.ts` throws `TranscriptUnavailableError` with a reason (`src/youtube/transcript-errors.ts`); fetch hooks must return Response-like objects (ok/status/text/json); `src/export/transcript.ts` writes `.txt`
- **Whisper**: `src/youtube/whisper.ts` — audio via yt-dlp → ffmpeg 10-min chunks → Groq/OpenAI `verbose_json`; last step of `fetchTranscript` for `no_captions` only when `WHISPER_PROVIDER` allows it (default `off` = only the explicit `transcribe_audio` tool); never re-sends audio to a second provider
- **yt-dlp**: `src/youtube/ytdlp.ts` — every call adds `jsRuntimeArgs(version)` (YouTube needs a JS runtime since 2025.11.12: our own Node unless deno is on PATH); `searchVideos` = flat `ytsearchN:` (no quota; date sort is not available)
- **Doctor**: `src/doctor/index.ts` — `runDoctor({ network })` used by the `doctor` tool and `npm run doctor`; each check really runs the dependency and returns status + fix
- **Secrets**: `src/redact.ts` — `redactCredentials` / `safeErrorMessage` strip `user:pass@` from text that reaches the chat or logs (proxy URLs, yt-dlp command lines); use them for any error text that may contain a URL
- **AI summaries**: `src/summary/` — `summarize.ts` (chunks with `[mm:ss]` marks → map-reduce via `ask()`, PROMPT_VERSION invalidates stored summaries), `index.ts` (table `summaries`, queue for channels with `auto_summary`, retry/skip by `TranscriptUnavailableError` reason, digest); run by the scheduler after each check (`runAutoSummaries`)
- **Media library**: `src/export/` — Jellyfin/Emby/Plex export (`nfo.ts` pure generators, `library.ts` hardlink → block clone → copy/symlink chain + rebuild guard)
- **Logger**: `src/logger.ts` — pino structured logging, **stderr only** (stdout is the stdio MCP protocol channel)
- **Validation**: `src/mcp/validation.ts` — Zod schemas for all MCP tool inputs

## Database

SQLite singleton via `getDb()` from `src/db/init.ts`. Never call `db.close()` manually — the connection is closed automatically on process exit.

Timestamps from `CURRENT_TIMESTAMP` are UTC without a zone — parse with `parseSqliteTime()` (`src/db/time.ts`), never `new Date(row.x)`.

Migrations: `src/db/migrate-002.ts` through `migrate-007.ts`
(005: profiles + music tables, 006: sheet_exports, 007: summaries + `channels.auto_summary` —
applied lazily by `ensureSummarySchema()`).

## Key conventions

- Version is read from `package.json` at runtime (PKG_VERSION in MCP servers)
- YouTube client (`getYoutube()`) is shared — exported from `src/youtube/api.ts`, used in `comments.ts`
- Proxy agent functions are async (ESM dynamic imports): `buildAgent()`, `axiosProxyConfig()`, `googleApiProxyConfig()`
- All MCP tool inputs validated via Zod schemas in `src/mcp/validation.ts`
- Logging via `createLogger('module')` from `src/logger.ts` — never use `console.log`
- Nothing may write to stdout in the stdio server except JSON-RPC: `dotenv.config({ quiet: true })` everywhere (dotenv 17 prints tips to stdout); `npm run smoke` enforces it
- Node.js >= 20 (`engines`); release version lives in package.json, package-lock.json and README/docs footers — `npm run check:version`

## Testing

```bash
npm test               # vitest run (365 tests)
npm run test:watch
npm run test:coverage  # + coverage report; thresholds in vitest.config.mts (CI fails below them)
npm run smoke          # build + smoke test of both MCP transports
npm run doctor         # diagnostics after build (-- --network for API key / proxies / AI)
```

Tests in `tests/` run against the real modules: `tests/helpers/temp-db.ts` gives each file its own
storage + SQLite schema (init + all migrations) — call `useTempStorage()` at the top level, then
import `src/` modules dynamically (they read `STORAGE_PATH`/`DB_PATH` on import). Only the network
is mocked (googleapis, axios, child_process, Anthropic SDK). Don't reimplement logic inside a test.
Entry points (`src/mcp/index.ts`, `server-http.ts`) are covered by `npm run smoke`, not coverage.

## CI/CD

- `.github/workflows/ci.yml` — type check + version check → tests (Node 20/22/24, Windows, macOS; coverage on Linux/Node 22) → build, package, smoke test of the release archive
- `.github/workflows/freebsd.yml` — FreeBSD 14/15 VM (better-sqlite3 built from source): main, PRs, weekly
- `.github/workflows/release.yml` — on `v*` tag (or web-UI release): gates, `ytome-X.Y.Z.{tar.gz,zip}`, SHA256SUMS, provenance attestation, notes from `CHANGELOG.md` (hand-written descriptions are kept). Manual run = dry-run
- `scripts/` — `check-version.mjs`, `release-notes.mjs`, `package.sh`, `smoke.mjs` (shared by CI and release)
- Releasing: bump version, move `## [Unreleased]` → `## [X.Y.Z] - date` in CHANGELOG.md, merge, then create the release in the GitHub UI
