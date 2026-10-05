# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/), версії — [SemVer](https://semver.org/).
Опис кожного GitHub-релізу береться з розділу його версії.

## [Unreleased]

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

[Unreleased]: https://github.com/click0/ytome/compare/v0.90...HEAD
[0.90.0]: https://github.com/click0/ytome/compare/v0.85...v0.90
[0.85.0]: https://github.com/click0/ytome/compare/v0.75...v0.85
[0.80.0]: https://github.com/click0/ytome/compare/v0.75...v0.85
[0.75.0]: https://github.com/click0/ytome/compare/v0.73...v0.75
[0.73.0]: https://github.com/click0/ytome/releases/tag/v0.73
