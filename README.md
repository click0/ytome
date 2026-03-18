# ytome

> Independent YouTube archiving system with Claude integration via Model Context Protocol.

**Stack:** TypeScript / Node.js · SQLite · YouTube Data API v3  
**Platforms:** Windows · Linux · macOS  
**Author:** Vladyslav V. Prodan · [github.com/click0](https://github.com/click0)  
**License:** BSD 3-Clause · v0.75 · 2026

---

## Table of Contents

1. [Requirements](#1-requirements)
2. [YouTube API Key](#2-youtube-api-key)
3. [Installation](#3-installation)
4. [Claude Setup](#4-claude-setup)
5. [MCP Tools Reference](#5-mcp-tools-reference)
6. [Usage Examples](#6-usage-examples)
7. [Project Structure](#7-project-structure)

---

## 1. Requirements

| Component | Requirement |
|-----------|-------------|
| Node.js | v18 or newer — [nodejs.org](https://nodejs.org) |
| npm | v9+ (bundled with Node.js) |
| yt-dlp | Optional — for downloading audio/video |
| Disk space | ~50 MB for archive data (metadata + transcripts + thumbnails) |
| | + ~150 MB node_modules (build dependency) |
| | + media files if downloaded (separate, on demand) |
| YouTube API key | Free — see section 2 |

> **Note:** yt-dlp is only needed for audio/video downloads. All other features work without it.

### 1.1 Install Node.js

If Node.js is not installed on your system:

- **Windows / macOS:** Download the installer from [nodejs.org](https://nodejs.org) (LTS recommended). npm is included.
- **Linux (Ubuntu/Debian):**
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- **Linux (Fedora/RHEL):**
  ```bash
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
  sudo dnf install -y nodejs
  ```
- **Any OS via nvm** (recommended for developers):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  nvm install 22
  ```

Verify: `node -v` (should show v18+) and `npm -v` (should show v9+).

---

## 2. YouTube API Key

The API key is used for fetching video metadata and comments.  
**Free quota: 10,000 units/day** — sufficient for monitoring dozens of channels.

### 2.1 Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Click the project dropdown → **New Project** → name: `ytome` → **Create**

### 2.2 Enable YouTube Data API v3

1. Side menu → **APIs & Services → Library**
2. Search: `YouTube Data API v3` → **Enable**

### 2.3 Create an API Key

1. **APIs & Services → Credentials → + Create Credentials → API key**
2. Copy the key. Optional: restrict to YouTube Data API v3

> ⚠️ **Never commit your API key to a public repository.** Store it only in `.env` (listed in `.gitignore`).

### 2.4 Quota Reference

| Operation | Cost (units) |
|-----------|-------------|
| Get channel video list | 100 |
| Video details (batch) | 1 |
| Comments (50 per request) | 1 |
| Channel info | 1 |
| Transcripts (subtitles) | **0** — fetched directly, no API key needed |

---

## 3. Installation

### 3.1 Unpack

```
Windows:  C:\Projects\ytome
Linux:    ~/projects/ytome
macOS:    ~/Projects/ytome
```

### 3.2 Install Dependencies

```bash
cd C:\Projects\ytome
npm install
```

> ⚠️ **Windows only:** If you see _"execution of scripts is disabled"_, run PowerShell as Administrator:
> ```powershell
> Set-ExecutionPolicy RemoteSigned
> ```

### 3.3 Configure Environment

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Open `.env` and fill in:

```env
YOUTUBE_API_KEY=AIzaSy...your_key_here...

# Windows
STORAGE_PATH=C:\Projects\ytome\storage
DB_PATH=C:\Projects\ytome\storage\archive.db

# Linux / macOS
STORAGE_PATH=/home/yourname/projects/ytome/storage
DB_PATH=/home/yourname/projects/ytome/storage/archive.db
```

### 3.4 Initialize the Database

```bash
npm run build
node dist/db/init.js
node dist/db/migrate-002.js
node dist/db/migrate-003.js
node dist/db/migrate-004.js
```

> After successful execution, `storage/archive.db` will be created — this file **is** your archive.

---

## 4. Claude Setup

### 4.1 Claude Desktop (stdio)

Open the configuration file:

```
Windows:  %APPDATA%\Claude\claude_desktop_config.json
macOS:    ~/Library/Application Support/Claude/claude_desktop_config.json
Linux:    ~/.config/Claude/claude_desktop_config.json
```

Add:

```json
{
  "mcpServers": {
    "ytome": {
      "command": "node",
      "args": ["C:\\Projects\\ytome\\dist\\mcp\\index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key",
        "STORAGE_PATH": "C:\\Projects\\ytome\\storage",
        "DB_PATH": "C:\\Projects\\ytome\\storage\\archive.db"
      }
    }
  }
}
```

> ⚠️ Windows paths in JSON require double backslashes: `C:\\Projects\\...`

### 4.2 claude.ai / Remote (HTTP/SSE)

```bash
npm run start:server
```

Server starts on port 3000 by default (`MCP_HTTP_PORT` in `.env`). Connect in claude.ai via:

```
http://localhost:3000/sse
```

> For LAN access from another device: set `MCP_HOST=0.0.0.0` in `.env`. The server prints all LAN URLs on startup.

### 4.3 AI Proxy (optional)

Route AI requests through any OpenAI-compatible router via `AI_PROXY_URL` in `.env`:

| Router | `AI_PROXY_URL` value |
|--------|---------------------|
| claude-code-router | `http://localhost:3456` |
| olla | `http://localhost:40114/olla/openai` |
| OmniRoute / NadirClaw | `http://localhost:8402` |
| Ollama on another PC | `http://192.168.1.50:11434` |
| Not set | Internal balancer (Ollama → Groq → Claude) |

---

## 5. MCP Tools Reference

### Subscriptions
| Tool | Description |
|------|-------------|
| `subscribe` | Add a channel by `@handle` or channel ID. Params: `visibility`, `note` |
| `list_subscriptions` | List subscriptions. Filter: `all` / `private` / `public` |
| `unsubscribe` | Remove a channel |

### Feed
| Tool | Description |
|------|-------------|
| `get_feed` | New videos/Shorts. Params: `since` ("1d","1w","1m"), `type` (video/short/all) |
| `mark_seen` | Mark a video as watched |
| `sync` | Force-check for new videos |

### Watch Later
| Tool | Description |
|------|-------------|
| `watch_later_add` | Add a video. Params: `priority` (high/medium/low), `note`, `tags` |
| `watch_later_list` | List with filters: `status`, `priority`, `tag`, `overdue` |
| `watch_later_update` | Update status / priority / note |
| `watch_later_stats` | Pending / done / overdue count |

### Content
| Tool | Description |
|------|-------------|
| `get_transcript` | Local cache first — network only if missing. `force_refresh` to update |
| `analyze_transcript` | Transcript + AI analysis (summary / key_points / quotes / full) |
| `get_comments` | Top comments. Params: `limit`, `owner_only`. Cached locally |
| `download` | Download via yt-dlp. `format`: audio / video / video_hd |

### Cache & Offline
| Tool | Description |
|------|-------------|
| `cache_status` | What is stored locally: transcript, comments, thumbnail, audio/video |

> If a video is **deleted from YouTube** — your local archive still has it.  
> `fully_offline: true` means no network is needed at all.

### AI Evaluation
| Tool | Description |
|------|-------------|
| `evaluate_video` | Score 0–100 for knowledge base (freshness, quality, relevance, tech currency) |
| `evaluate_batch` | Evaluate multiple videos sorted by score. Returns 🟢/🟡/🔴/⛔ |

### AI Balancer
| Tool | Description |
|------|-------------|
| `ai_status` | Current mode + provider routing table |
| `ai_set_mode` | Change mode: `priority` / `cost` / `roundrobin` |
| `ai_usage` | Usage stats and cost by provider for N days |

### Proxy
| Tool | Description |
|------|-------------|
| `proxy_add` | Add HTTP/HTTPS/SOCKS5 proxy |
| `proxy_list` | List proxies with health status |
| `proxy_remove` / `proxy_test` | Remove or test a proxy |
| `proxy_set_mode` | `disabled` / `single` / `rotation` / `fallback` |

### Filters
| Tool | Description |
|------|-------------|
| `filter_add` | Whitelist or blacklist rule (scope: `channel`, `description`) |
| `filter_list` | All rules with hit counts |
| `filter_remove` / `filter_clear` | Remove one or all |

### Export / Import / Groups / Quota
| Tool | Description |
|------|-------------|
| `export_opml` | Export to OPML (RSS-reader compatible) |
| `export_json` | Export to JSON |
| `import_opml` | Import from OPML file |
| `create_group` / `list_groups` | Channel groups |
| `quota_status` | YouTube API quota for today with history |

---

## 6. Usage Examples

```
"Subscribe to @veritasium privately. Note: physics and science"
"What's new from my subscriptions this week?"
"Show only Shorts from the last 3 days"

"Add this video to watch later, priority high"
"Mark watch later item 42 as done"

"Summarize video dQw4w9WgXcQ"
"Extract key points from the transcript of this video: [URL]"
"Show top 20 comments on the latest video from @3blue1brown"
"Download audio of this video"

"Is video dQw4w9WgXcQ fully available offline?"
"Evaluate this video for my knowledge base: dQw4w9WgXcQ"
"Rate the last 10 unseen videos — what's worth watching?"

"Add SOCKS5 proxy 192.168.1.1:1080 and set rotation mode"
"Blacklist channels with 'shorts' in description"
"Export my public subscriptions to OPML"
```

---

## 7. Project Structure

```
ytome/
├── src/
│   ├── mcp/
│   │   ├── handlers.ts       # All MCP tools logic (shared)
│   │   ├── index.ts          # stdio server — Claude Desktop
│   │   └── server-http.ts    # HTTP/SSE server — claude.ai
│   ├── youtube/
│   │   ├── api.ts            # YouTube Data API v3 + offline-first
│   │   ├── comments.ts       # Comments fetcher
│   │   ├── export.ts         # OPML / JSON export
│   │   └── ytdlp.ts          # yt-dlp integration
│   ├── cache/
│   │   └── resolver.ts       # Offline-first: DB → file → network
│   ├── ai/
│   │   ├── balancer.ts       # cost / priority / roundrobin modes
│   │   ├── claude.ts         # Anthropic API adapter
│   │   └── providers.ts      # Ollama · Groq · OpenRouter · LM Studio
│   ├── db/
│   │   ├── init.ts           # SQLite schema
│   │   ├── queries.ts        # Channels, videos, transcripts
│   │   ├── queries-v2.ts     # Watch later, comments
│   │   ├── quota.ts          # API quota tracking
│   │   └── migrate-002..004  # DB migrations
│   ├── proxy/
│   │   └── manager.ts        # HTTP/HTTPS/SOCKS5 with rotation
│   ├── filters/
│   │   └── index.ts          # Whitelist / blacklist
│   ├── evaluation/
│   │   └── index.ts          # Video scoring for knowledge base
│   └── scheduler/
│       └── index.ts          # Cron + quota guard + filters
├── storage/
│   ├── archive.db            # SQLite — your archive
│   ├── thumbnails/
│   ├── transcripts/
│   ├── media/
│   └── exports/
├── docs/
│   ├── README.en.md
│   └── README.uk.md
├── .env.example
├── package.json
└── tsconfig.json
```

### npm scripts

```bash
npm run build          # Compile TypeScript
npm run start:local    # stdio MCP server (Claude Desktop)
npm run start:server   # HTTP/SSE server (claude.ai)
npm run db:init        # Initialize database
```

---

*ytome v0.75 · [github.com/click0/ytome](https://github.com/click0/ytome) · BSD 3-Clause License · Vladyslav V. Prodan · 2026*
