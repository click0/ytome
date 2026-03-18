# YouTube Archive — MCP Server

> Independent YouTube archiving system with Claude integration via Model Context Protocol.

**Stack:** TypeScript / Node.js · SQLite · YouTube Data API v3  
**Platforms:** Windows · Linux · macOS

---

## Table of Contents

1. [Requirements](#1-requirements)
2. [YouTube API Key](#2-youtube-api-key)
3. [Installation](#3-installation)
4. [Claude Desktop Setup](#4-claude-desktop-setup)
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
| Disk space | 500 MB+ (without media files) |
| YouTube API key | Free, see section 2 |

> **Note:** yt-dlp is only needed if you want to download audio/video on demand. All other features work without it.

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
2. Click the project dropdown at the top → **New Project**
3. Name: `youtube-archive` → **Create**
4. Make sure the new project is selected

### 2.2 Enable YouTube Data API v3

1. Side menu → **APIs & Services → Library**
2. Search: `YouTube Data API v3`
3. Click the result → **Enable**

### 2.3 Create an API Key

1. **APIs & Services → Credentials**
2. **+ Create Credentials → API key**
3. Copy the generated key
4. Optional: click **Restrict key** → limit to YouTube Data API v3

> ⚠️ **Never commit your API key to a public repository.** Store it only in the `.env` file, which is listed in `.gitignore`.

### 2.4 Quota Reference

| Operation | Cost |
|-----------|------|
| Get channel video list | 100 units |
| Video details (batch) | 1 unit |
| Comments (50 per request) | 1 unit |
| Channel info | 1 unit |

> **Note:** Transcripts (subtitles) do **not** require an API key — they are fetched directly via `youtube-transcript`.

---

## 3. Installation

### 3.1 Unpack

Extract `youtube-archive-v3.zip` to a convenient location:

```
Windows:  C:\Projects\youtube-archive
Linux:    ~/projects/youtube-archive
macOS:    ~/Projects/youtube-archive
```

### 3.2 Install Dependencies

Open a terminal in the project folder:

```bash
cd C:\Projects\youtube-archive
npm install
```

> ⚠️ **Windows only:** If you see _"execution of scripts is disabled"_, run PowerShell as Administrator and execute:
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

Open `.env` in any text editor and fill in:

```env
YOUTUBE_API_KEY=AIzaSy...your_key_here...

# Windows
STORAGE_PATH=C:\Projects\youtube-archive\storage
DB_PATH=C:\Projects\youtube-archive\storage\archive.db

# Linux / macOS
STORAGE_PATH=/home/yourname/projects/youtube-archive/storage
DB_PATH=/home/yourname/projects/youtube-archive/storage/archive.db
```

### 3.4 Initialize the Database

```bash
npm run build
node dist/db/init.js
node dist/db/migrate-002.js
```

After successful execution, the file `storage/archive.db` will be created — this file contains your entire archive.

---

## 4. Claude Desktop Setup

### 4.1 Install Claude Desktop

Download from [claude.ai/download](https://claude.ai/download) and install normally.

### 4.2 Edit the Config File

Open the configuration file:

```
Windows:  %APPDATA%\Claude\claude_desktop_config.json
macOS:    ~/Library/Application Support/Claude/claude_desktop_config.json
Linux:    ~/.config/Claude/claude_desktop_config.json
```

If the file doesn't exist — create it. Paste the following content:

```json
{
  "mcpServers": {
    "youtube-archive": {
      "command": "node",
      "args": [
        "C:\\Projects\\youtube-archive\\dist\\mcp\\index.js"
      ],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key",
        "STORAGE_PATH": "C:\\Projects\\youtube-archive\\storage",
        "DB_PATH": "C:\\Projects\\youtube-archive\\storage\\archive.db"
      }
    }
  }
}
```

> ⚠️ **Windows paths in JSON require double backslashes:** `C:\\Projects\\...` not `C:\Projects\...`

**Linux / macOS variant:**

```json
{
  "mcpServers": {
    "youtube-archive": {
      "command": "node",
      "args": ["/home/yourname/projects/youtube-archive/dist/mcp/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "your_api_key",
        "STORAGE_PATH": "/home/yourname/projects/youtube-archive/storage",
        "DB_PATH": "/home/yourname/projects/youtube-archive/storage/archive.db"
      }
    }
  }
}
```

### 4.3 Restart Claude Desktop

Fully close and reopen Claude Desktop. To verify the connection, in a new chat ask:

```
"Show my YouTube subscriptions"
```

If the server is connected, Claude will see the `youtube-archive` tools and respond (with an empty list for now).

---

## 5. MCP Tools Reference

### Subscriptions

| Tool | Description |
|------|-------------|
| `subscribe` | Add a channel by `@handle` or channel ID. Params: `visibility` (private/public), `note` |
| `list_subscriptions` | List subscriptions. Filter: `all` / `private` / `public` |
| `unsubscribe` | Remove a channel from subscriptions |

### Feed

| Tool | Description |
|------|-------------|
| `get_feed` | New videos/Shorts for a period. Params: `since` ("1d","1w","1m"), `type` (video/short/all) |
| `mark_seen` | Mark a video as watched |
| `sync` | Force check for new videos. No params = all channels |

### Watch Later

| Tool | Description |
|------|-------------|
| `watch_later_add` | Add a video. Params: `priority` (high/medium/low), `note`, `tags` |
| `watch_later_list` | List with filters: `status`, `priority`, `tag`, `overdue` |
| `watch_later_update` | Update status / priority / note by ID |
| `watch_later_stats` | Stats: pending / done / overdue count |

### Content

| Tool | Description |
|------|-------------|
| `get_transcript` | Video transcript (cache or fetch). `force_refresh` to update |
| `analyze_transcript` | Fetch transcript + analysis instruction (summary/key_points/quotes/full) |
| `get_comments` | Top comments. Params: `limit`, `owner_only`, `with_replies` |

### Export / Import

| Tool | Description |
|------|-------------|
| `export_opml` | Export subscriptions to OPML (compatible with RSS readers) |
| `export_json` | Export subscriptions to JSON. Param: `visibility` |
| `import_opml` | Import subscriptions from an OPML file |

### Groups

| Tool | Description |
|------|-------------|
| `create_group` | Create a channel group (`name`, `visibility`) |
| `list_groups` | List all groups |

---

## 6. Usage Examples

### Subscriptions

```
"Subscribe to @veritasium privately. Note: physics and science"
"Show all my public subscriptions"
```

### Feed & Watch Later

```
"What's new from my subscriptions this week?"
"Show only Shorts from the last 3 days"
"Add this video to watch later, priority high, note: interesting idea about memory"
"What's in my high priority watch queue?"
"Mark watch later item 42 as done"
```

### Content Analysis

```
"Summarize video dQw4w9WgXcQ"
"Extract key points from the transcript of this video: [URL]"
"Show top 20 comments on the latest video from @3blue1brown"
"What does the channel author write in the comments on this video?"
```

### Export

```
"Export my public subscriptions to OPML"
"Save all subscriptions as JSON"
"Import subscriptions from file C:\Downloads\subs.opml"
```

---

## 7. Project Structure

```
youtube-archive/
├── src/
│   ├── db/
│   │   ├── init.ts           # SQLite schema
│   │   ├── queries.ts        # Channels, videos, transcripts
│   │   ├── queries-v2.ts     # Watch later, comments
│   │   └── migrate-002.ts    # Migration: new tables
│   ├── youtube/
│   │   ├── api.ts            # YouTube Data API v3
│   │   ├── comments.ts       # Comments fetcher
│   │   └── export.ts         # OPML / JSON export
│   ├── scheduler/
│   │   └── index.ts          # Cron: periodic video checks
│   └── mcp/
│       ├── index.ts          # MCP server (stdio, Claude Desktop)
│       └── server-http.ts    # MCP server (HTTP/SSE, claude.ai)
├── storage/
│   ├── archive.db            # SQLite database (created on init)
│   ├── thumbnails/           # Video thumbnails (.jpg)
│   ├── transcripts/          # Transcript cache
│   ├── media/                # Audio/video on demand
│   └── exports/              # OPML and JSON exports
├── .env                      # Configuration (API key, paths)
├── .env.example              # Configuration template
├── package.json
└── tsconfig.json
```

### Key npm scripts

```bash
npm run build       # Compile TypeScript
npm run start:local # Start MCP server (stdio)
npm run start:server # Start HTTP/SSE server
npm run scheduler   # Start background scheduler only
npm run db:init     # Initialize database
```

---

*youtube-archive v0.2 · MIT License*
