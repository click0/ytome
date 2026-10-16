# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/), версії — [SemVer](https://semver.org/).
Опис кожного GitHub-релізу береться з розділу його версії.

## [Unreleased]

### Added
- `transcribe_audio`: розпізнавання аудіо через Whisper для відео без субтитрів — Groq
  `whisper-large-v3` (безкоштовний тариф) або OpenAI; з таймкодами, зберігається як транскрипт.
  `WHISPER_PROVIDER=auto` вмикає його автоматично (за замовчуванням вимкнено — аудіо йде
  стороннім лише за явним викликом), до другого провайдера аудіо не пересилається
- `search_videos`: пошук на YouTube через yt-dlp без API-ключа й квоти
- `doctor` (і `npm run doctor`): діагностика yt-dlp і JS-середовища, ffmpeg, ключа API й квоти,
  бази, місця на диску, cookies профілів, проксі, AI, Whisper, Google — з підказками, як виправити

### Changed
- Claude: поточні моделі — Haiku 5.5 / Sonnet 5.5 / Opus 5.5 замість Haiku 4.5 / Sonnet 4.6 /
  Opus 4.6, актуальні ціни; рівні fast / balanced / top змінюються через `CLAUDE_MODEL_*`
  (наприклад, `CLAUDE_MODEL_TOP=claude-fable-5-1`). Режим `priority`: критичні задачі — Opus
- Claude: глибина роздумів (`effort`) за складністю задачі, запас токенів на роздуми,
  серверний fallback Anthropic при відмові класифікатора (Opus / Sonnet / Fable)
- Підсумки транскриптів через Claude — structured outputs: формат відповіді гарантований схемою
- `ai_status` з `check_health: true` перевіряє доступність моделей Claude через Models API
  (без витрат токенів)

### Fixed
- Безпека: пароль проксі потрапляв у чат — `proxy_test` і `proxy_add` повертали повний URL,
  а збій yt-dlp повертав увесь командний рядок з `--proxy user:pass@…`; тепер облікові дані
  вирізаються з відповідей і логів
- yt-dlp не отримував JS-середовище, якого YouTube вимагає з yt-dlp 2025.11.12 (за
  замовчуванням увімкнений лише deno) — без deno завантаження й субтитри могли не працювати;
  тепер передається Node, на якому працює ytome (`YTDLP_JS_RUNTIME` — щоб змінити)
- Оновлений транскрипт не змінював позначку джерела (youtube / whisper)
- Відмова Claude (`stop_reason: refusal`) і порожня відповідь, обрізана `max_tokens`, тепер
  помилки — балансувальник переходить до наступного провайдера; раніше повертався порожній текст

## [0.96.0] - 2026-10-12

### Added
- AI-підсумки транскриптів: `summarize_video` — TL;DR, ключові тези, розділи з таймкодами
  й посиланнями; довгі відео — частинами (map-reduce); зберігаються в архіві
- Автопідсумки: `summary_auto` для каналу — планувальник підсумовує нові відео після
  синхронізації; збої транскрипту (блок IP, AI недоступний) повторюються з паузою,
  «немає субтитрів» — ні; денний ліміт `SUMMARY_DAILY_LIMIT`; `summary_run` — вручну
- `digest`: Markdown-дайджест нових відео з підсумками за каналами
- TL;DR у `get_feed`; підсумок в описі `.nfo` медіабібліотеки (Jellyfin / Emby / Plex)

### Fixed
- npm 12 за замовчуванням блокує install-скрипти — better-sqlite3 не збирався
  (`Could not locate the bindings file`); дозвіл у `allowScripts` у package.json
- `get_comments` і `cache_status` падали для будь-якого відео з архіву (запит до
  неіснуючої колонки); метадані в кеші завжди вважались застарілими
- `watch_later_list` з `overdue: true` падав з помилкою SQL
- Фільтр-whitelist за ID каналу не спрацьовував із налаштуваннями за замовчуванням
  (без урахування регістру) — блокувались усі відео
- Коментарі автора каналу не розпізнавались: `owner_only` повертав порожньо
- Планувальник: збій `videos.list` (зокрема вичерпана квота) після RSS запускав
  дорогий `search.list` (100 одиниць); час останньої перевірки зсувався на часовий
  пояс — поза UTC нові відео могли пропускатись
- OPML-експорт ігнорував групи каналів; імпорт не декодував `&amp;` тощо
- Експорт статистики в Sheets губив частину розбивки за операціями
- `export_transcript`: мова з запиту більше не може вивести файл за межі теки експорту;
  запит до Drive екранує ID папки
- Логи міграцій і AI-провайдерів ішли в stdout/консоль повз логер

### Changed
- Тести працюють зі справжніми модулями на тимчасовій БД (раніше фільтри й оцінка
  тестували копію коду): 161 → 304 тести, покриття 19 % → 96 % рядків;
  `npm run test:coverage`, пороги покриття в CI

## [0.95.0] - 2026-10-06

### Added
- `export_transcript`: транскрипт у локальний `.txt` (назва, канал, посилання; опційно
  таймкоди `[mm:ss]`), зокрема для відео поза архівом

### Fixed
- Транскрипти не працювали з проксі та cookies профілю: fetch-хуки повертали дані
  замість Response-подібного об'єкта, якого чекає youtube-transcript-plus
- Помилка транскрипту тепер називає причину: блок IP («підтвердіть, що ви не бот»),
  потрібен вхід, відео недоступне, немає субтитрів чи потрібної мови — з підказкою;
  раніше завжди було «No transcripts available»

### Changed
- FreeBSD CI: кожен етап — окремий крок через `cpa.sh` (вхід `run` дії застарів)
- dependabot не пропонує better-sqlite3 13: немає готових бінарників для Windows
- Залежності: TypeScript 7, vitest 5, googleapis 182, @anthropic-ai/sdk 0.131,
  @modelcontextprotocol/sdk 1.31, zod 4.6, axios 1.20, youtube-transcript-plus 2.0.3

## [0.90.0] - 2026-10-04

### Added
- Медіабібліотека для Jellyfin / Emby / Plex: `library_export`, `library_rebuild` —
  `.nfo`, постери, структура `Канал/Season РРРР`, стабільна нумерація епізодів
- Файли бібліотеки без витрат місця: хардлінк → клон блоків (reflink) → symlink;
  `LIBRARY_LINK_MODE=copy` для Jellyfin у Docker та бібліотеки на іншому датасеті ZFS
- Нові відео через RSS-фіди каналів: ~1 одиниця квоти на канал замість 100
- Надійні завантаження: докачка, ретраї, ретраї фрагментів, налаштовуваний таймаут
- CI: тести на Node 20/22/24, Windows, macOS і FreeBSD; smoke-тест обох транспортів MCP;
  перевірка узгодженості версій; реліз з контрольними сумами й атестацією походження

### Fixed
- stdio-сервер писав у stdout підказки dotenv 17 і логи pino, ламаючи протокол MCP
  з Claude Desktop — тепер stdout лише для JSON-RPC, логи в stderr
- `npm run dev` не запускався з TypeScript 6
- Квота `videos.list` рахувалась за кожне відео замість кожного запиту

### Changed
- Мінімальна версія Node.js — 20 (вимога better-sqlite3 12 і vitest 4)

## [0.85.0] - 2026-07-11

### Added
- Браузерні профілі: cookies.txt для приватних і вікових відео, власний API-ключ
  профілю (окрема квота), прив'язка каналів до профілів
- Google Drive: бекап бази, експорт транскриптів
- Google Sheets: експорт підписок, watch later, статистики квоти
- YouTube Music: архівування плейлистів
- Профілі каналів підхоплюються в планувальнику, транскриптах і завантаженнях

## [0.80.0] - 2026-07-07

### Changed
- Оновлені всі мажорні залежності: TypeScript 6, Express 5, Zod 4, better-sqlite3 12,
  @anthropic-ai/sdk 0.110, googleapis 173, proxy-агенти (ESM)
- Одне спільне з'єднання з SQLite (WAL) замість відкриття на кожен запит
- Транскрипти через youtube-transcript-plus (InnerTube API)

### Fixed
- SQL-ін'єкції, path traversal в імпорті OPML, гонка в round-robin балансері,
  витоки з'єднань з БД

## [0.75.0] - 2026-03-18

### Added
- Структуроване логування (pino), Zod-валідація входів MCP, rate limiting HTTP-сервера, тести
- GitHub Actions: CI і реліз

### Changed
- Проєкт перейменовано з youtube-archive на ytome

## [0.73.0] - 2026-03-18

- Перший публічний реліз

[Unreleased]: https://github.com/click0/ytome/compare/v0.96...HEAD
[0.96.0]: https://github.com/click0/ytome/compare/v0.95...v0.96
[0.95.0]: https://github.com/click0/ytome/compare/v0.90...v0.95
[0.90.0]: https://github.com/click0/ytome/compare/v0.85...v0.90
[0.85.0]: https://github.com/click0/ytome/compare/v0.75...v0.85
[0.80.0]: https://github.com/click0/ytome/compare/v0.75...v0.85
[0.75.0]: https://github.com/click0/ytome/compare/v0.73...v0.75
[0.73.0]: https://github.com/click0/ytome/releases/tag/v0.73
