# YouTube Archive — MCP Сервер

> Незалежна система архівування YouTube-контенту з інтеграцією до Claude через Model Context Protocol.

**Стек:** TypeScript / Node.js · SQLite · YouTube Data API v3  
**Платформи:** Windows · Linux · macOS

---

## Зміст

1. [Системні вимоги](#1-системні-вимоги)
2. [YouTube API ключ](#2-youtube-api-ключ)
3. [Встановлення](#3-встановлення)
4. [Підключення до Claude Desktop](#4-підключення-до-claude-desktop)
5. [Довідник інструментів MCP](#5-довідник-інструментів-mcp)
6. [Приклади використання](#6-приклади-використання)
7. [Структура проєкту](#7-структура-проєкту)

---

## 1. Системні вимоги

| Компонент | Вимога |
|-----------|--------|
| Node.js | v18 або новіше — [nodejs.org](https://nodejs.org) |
| npm | v9+ (входить до складу Node.js) |
| yt-dlp | Необов'язково — для завантаження відео/аудіо |
| Дисковий простір | Від 500 МБ (без медіафайлів) |
| YouTube API ключ | Безкоштовний, див. розділ 2 |

> **Примітка:** yt-dlp потрібен лише якщо хочеш завантажувати аудіо/відео на запит. Усі інші функції працюють без нього.

### 1.1 Встановлення Node.js

Якщо Node.js не встановлено:

- **Windows / macOS:** Завантаж інсталятор з [nodejs.org](https://nodejs.org) (рекомендовано LTS). npm входить до складу.
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
- **Будь-яка ОС через nvm** (рекомендовано для розробників):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  nvm install 22
  ```

Перевірка: `node -v` (має бути v18+) та `npm -v` (має бути v9+).

---

## 2. YouTube API ключ

API ключ потрібен для отримання метаданих відео та коментарів.  
**Безкоштовна квота: 10 000 одиниць/день** — цього достатньо для моніторингу десятків каналів.

### 2.1 Створення проєкту в Google Cloud

1. Перейди на [console.cloud.google.com](https://console.cloud.google.com)
2. Натисни спадний список проєктів вгорі → **Новий проєкт**
3. Назва: `youtube-archive` → **Створити**
4. Переконайся, що вибрано новостворений проєкт

### 2.2 Увімкнення YouTube Data API v3

1. Бічне меню → **APIs & Services → Library**
2. Пошук: `YouTube Data API v3`
3. Натисни на результат → **Enable (Увімкнути)**

### 2.3 Створення API ключа

1. **APIs & Services → Credentials**
2. **+ Create Credentials → API key**
3. Скопіюй згенерований ключ
4. Необов'язково: натисни **Restrict key** → обмеж до YouTube Data API v3

> ⚠️ **Ніколи не публікуй API ключ у відкритому репозиторії.** Зберігай лише у файлі `.env`, який додано до `.gitignore`.

### 2.4 Довідник квот

| Операція | Вартість |
|----------|----------|
| Отримати список відео каналу | 100 одиниць |
| Деталі відео (batch) | 1 одиниця |
| Коментарі (50 за запит) | 1 одиниця |
| Інформація про канал | 1 одиниця |

> **Примітка:** Транскрипції (субтитри) **не потребують** API ключа — завантажуються напряму через `youtube-transcript`.

---

## 3. Встановлення

### 3.1 Розпакування

Розпакуй `youtube-archive-v3.zip` у зручне місце:

```
Windows:  C:\Projects\youtube-archive
Linux:    ~/projects/youtube-archive
macOS:    ~/Projects/youtube-archive
```

### 3.2 Встановлення залежностей

Відкрий термінал у папці проєкту:

```bash
cd C:\Projects\youtube-archive
npm install
```

> ⚠️ **Лише Windows:** Якщо бачиш помилку _"execution of scripts is disabled"_ — запусти PowerShell від адміністратора та виконай:
> ```powershell
> Set-ExecutionPolicy RemoteSigned
> ```

### 3.3 Налаштування оточення

```bash
# Windows
copy .env.example .env

# Linux / macOS
cp .env.example .env
```

Відкрий `.env` у будь-якому редакторі та заповни:

```env
YOUTUBE_API_KEY=AIzaSy...твій_ключ_тут...

# Windows
STORAGE_PATH=C:\Projects\youtube-archive\storage
DB_PATH=C:\Projects\youtube-archive\storage\archive.db

# Linux / macOS
STORAGE_PATH=/home/yourname/projects/youtube-archive/storage
DB_PATH=/home/yourname/projects/youtube-archive/storage/archive.db
```

### 3.4 Ініціалізація бази даних

```bash
npm run build
node dist/db/init.js
node dist/db/migrate-002.js
```

Після успішного виконання з'явиться файл `storage/archive.db` — це і є весь твій архів.

---

## 4. Підключення до Claude Desktop

### 4.1 Встановлення Claude Desktop

Завантаж з [claude.ai/download](https://claude.ai/download) та встанови як звичайний застосунок.

### 4.2 Редагування конфіг-файлу

Відкрий файл конфігурації:

```
Windows:  %APPDATA%\Claude\claude_desktop_config.json
macOS:    ~/Library/Application Support/Claude/claude_desktop_config.json
Linux:    ~/.config/Claude/claude_desktop_config.json
```

Якщо файл не існує — створи його. Вкажи такий вміст:

```json
{
  "mcpServers": {
    "youtube-archive": {
      "command": "node",
      "args": [
        "C:\\Projects\\youtube-archive\\dist\\mcp\\index.js"
      ],
      "env": {
        "YOUTUBE_API_KEY": "твій_api_ключ",
        "STORAGE_PATH": "C:\\Projects\\youtube-archive\\storage",
        "DB_PATH": "C:\\Projects\\youtube-archive\\storage\\archive.db"
      }
    }
  }
}
```

> ⚠️ **Шляхи Windows у JSON потребують подвійного зворотного слеша:** `C:\\Projects\\...` а не `C:\Projects\...`

**Варіант для Linux / macOS:**

```json
{
  "mcpServers": {
    "youtube-archive": {
      "command": "node",
      "args": ["/home/yourname/projects/youtube-archive/dist/mcp/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "твій_api_ключ",
        "STORAGE_PATH": "/home/yourname/projects/youtube-archive/storage",
        "DB_PATH": "/home/yourname/projects/youtube-archive/storage/archive.db"
      }
    }
  }
}
```

### 4.3 Перезапуск Claude Desktop

Повністю закрий і знову відкрий Claude Desktop. Щоб перевірити підключення, у новому чаті запитай:

```
"Покажи список моїх YouTube підписок"
```

Якщо сервер підключено, Claude побачить інструменти `youtube-archive` і відповість (поки що порожнім списком).

---

## 5. Довідник інструментів MCP

### Підписки

| Інструмент | Опис |
|------------|------|
| `subscribe` | Додати канал за `@handle` або channel ID. Параметри: `visibility` (private/public), `note` |
| `list_subscriptions` | Список підписок. Фільтр: `all` / `private` / `public` |
| `unsubscribe` | Видалити канал з підписок |

### Стрічка

| Інструмент | Опис |
|------------|------|
| `get_feed` | Нові відео/Shorts за період. Параметри: `since` ("1d","1w","1m"), `type` (video/short/all) |
| `mark_seen` | Позначити відео як переглянуте |
| `sync` | Примусова перевірка. Без параметрів = усі канали |

### Watch Later (Переглянути пізніше)

| Інструмент | Опис |
|------------|------|
| `watch_later_add` | Додати відео. Параметри: `priority` (high/medium/low), `note`, `tags` |
| `watch_later_list` | Список із фільтрами: `status`, `priority`, `tag`, `overdue` |
| `watch_later_update` | Оновити статус / пріоритет / нотатку за ID |
| `watch_later_stats` | Статистика: pending / done / прострочено |

### Контент

| Інструмент | Опис |
|------------|------|
| `get_transcript` | Транскрипція відео (кеш або завантажити). `force_refresh` для оновлення |
| `analyze_transcript` | Завантажити транскрипцію + вказівка для аналізу (summary/key_points/quotes/full) |
| `get_comments` | Топ коментарі. Параметри: `limit`, `owner_only`, `with_replies` |

### Експорт / Імпорт

| Інструмент | Опис |
|------------|------|
| `export_opml` | Експорт підписок у OPML (сумісний із RSS-рідерами) |
| `export_json` | Експорт підписок у JSON. Параметр: `visibility` |
| `import_opml` | Імпорт підписок з OPML-файлу |

### Групи

| Інструмент | Опис |
|------------|------|
| `create_group` | Створити групу каналів (`name`, `visibility`) |
| `list_groups` | Список усіх груп |

---

## 6. Приклади використання

### Підписки

```
"Підпишись на канал @veritasium приватно. Нотатка: фізика і наука"
"Покажи всі мої публічні підписки"
```

### Стрічка та Watch Later

```
"Що нового вийшло в моїх підписках за останній тиждень?"
"Покажи лише Shorts за останні 3 дні"
"Додай це відео до watch later, пріоритет high, нотатка: цікава ідея про пам'ять"
"Що в мене в черзі на перегляд із високим пріоритетом?"
"Позначити пункт watch later 42 як done"
```

### Аналіз контенту

```
"Зроби короткий переказ відео dQw4w9WgXcQ"
"Виділи ключові тези з транскрипції цього відео: [URL]"
"Покажи топ-20 коментарів під останнім відео каналу @3blue1brown"
"Що пише сам автор каналу в коментарях до цього відео?"
```

### Експорт

```
"Експортуй мої публічні підписки в OPML"
"Збережи всі підписки як JSON"
"Імпортуй підписки з файлу C:\Downloads\subs.opml"
```

---

## 7. Структура проєкту

```
youtube-archive/
├── src/
│   ├── db/
│   │   ├── init.ts           # Схема SQLite
│   │   ├── queries.ts        # Канали, відео, транскрипції
│   │   ├── queries-v2.ts     # Watch later, коментарі
│   │   └── migrate-002.ts    # Міграція: нові таблиці
│   ├── youtube/
│   │   ├── api.ts            # YouTube Data API v3
│   │   ├── comments.ts       # Завантаження коментарів
│   │   └── export.ts         # Експорт OPML / JSON
│   ├── scheduler/
│   │   └── index.ts          # Cron: планова перевірка відео
│   └── mcp/
│       ├── index.ts          # MCP сервер (stdio, Claude Desktop)
│       └── server-http.ts    # MCP сервер (HTTP/SSE, claude.ai)
├── storage/
│   ├── archive.db            # База даних SQLite (створюється при init)
│   ├── thumbnails/           # Мініатюри відео (.jpg)
│   ├── transcripts/          # Кеш транскрипцій
│   ├── media/                # Аудіо/відео на запит
│   └── exports/              # OPML та JSON експорти
├── .env                      # Конфігурація (API ключ, шляхи)
├── .env.example              # Шаблон конфігурації
├── package.json
└── tsconfig.json
```

### Основні npm-скрипти

```bash
npm run build        # Компіляція TypeScript
npm run start:local  # Запустити MCP сервер (stdio)
npm run start:server # Запустити HTTP/SSE сервер
npm run scheduler    # Запустити лише фоновий планувальник
npm run db:init      # Ініціалізація бази даних
```

---

*youtube-archive v0.2 · MIT License*
