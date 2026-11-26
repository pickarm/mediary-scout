<p align="center">
  <img src="docs/images/hero.svg" alt="Mediary Scout" width="600">
</p>

<p align="center">
  <b>Mediary Scout (pickarm Fork)</b><br>
  <b>An agent-driven cloud-drive media library for self-hosted NAS/VPS: auto search & gap-fill, 6-drive library scan & organization, messaging bot direct import, default forced login, and GHCR auto-build images.</b>
</p>

<p align="center">
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml/badge.svg" alt="Auto Build Docker Image"></a>
  <a href="https://github.com/pickarm/mediary-scout/pkgs/container/mediary-scout"><img src="https://img.shields.io/badge/GHCR-ghcr.io%2Fpickarm%2Fmediary--scout-2ea44f?logo=github" alt="GHCR"></a>
  <a href="https://github.com/pickarm/mediary-scout/releases"><img src="https://img.shields.io/github/v/release/pickarm/mediary-scout?display_name=tag" alt="Fork Releases"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="#nas--vps-quick-start-ghcr">🚀 Quick Start</a> ·
  <a href="#authentication--access-control">🔐 Login & Security</a> ·
  <a href="#github-actions-ghcr-auto-build">⚙️ GHCR Auto-Build</a> ·
  <a href="#supported-drives">🗂️ Drives</a> ·
  <a href="#messaging-bots--direct-import">💬 Messaging Bots</a> ·
  <a href="README.md">中文文档</a>
</p>

Maintained on top of upstream [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout) (synced through `#379`), keeping full movie/TV/anime search, agent source picking, transfer verification, daily scheduled gap-fill, multi-account isolation, and Emby/Jellyfin/Plex/webhook refreshes while adding:

- **Default Forced Login & Owner Controls**: All Web routes and user APIs enforce `mt_session` authentication out of the box (over bare public VPS ports, reverse proxies, and LAN). Unclaimed instances adopt any seeded `acct_default` library on initial setup (either via `/login` or `MEDIA_TRACK_ADMIN_USERNAME` + `MEDIA_TRACK_ADMIN_PASSWORD`) and lock public self-registration by default.
- **6-Drive Existing Library Scan & Organization**: Paginated directory scan, TMDB identification, safe import (`autoAcquire` off by default), template preview & non-destructive rename/organize preserving multi-version files and subtitle language/`forced` flags across **Quark, UC, 115, 123, GuangYaPan (光鸭), and Tianyi (天翼)**.
- **Scale & Caching**: Server-side paginated library/activity views, independent non-drive preparation workers, optional Redis summary cache (gracefully degrades back to PostgreSQL on Redis failure), and shared SSE progress streams.
- **Messaging Bots & Direct Share/Magnet Import**: Built-in **WeChat (iLink QR/PIN), Feishu (long connection cards), and Telegram (grammY)** private chat bots for searching, choosing seasons/drives, querying/stopping jobs, and importing share links or magnet URLs into isolated landing directories.
- **Zero-Secret GHCR `linux/amd64` Auto-Build**: Prebuilt single-container image (`web` + in-process worker) automatically built, smoke-tested, and pushed to `ghcr.io/pickarm/mediary-scout` without external Docker Hub secrets.

> **Verification Boundary Note**: Static type checks, ESLint, database-free Web build, unit/contract tests, and isolated Linux/PostgreSQL/Redis suites have been run. Before migrating an existing database, always run a dry-run on an isolated PostgreSQL clone (`MEDIA_TRACK_REHEARSAL=1`) and validate real WeChat/Feishu/Telegram messaging and cloud-drive writes against a dedicated test folder. See [Fork Deployment Guide (Chinese)](docs/fork/DEPLOYMENT.md) and [Migration Guide (Chinese)](docs/fork/MIGRATION.md).

![Mediary Scout: search a title, hit 获取, and the agent searches, transfers, and verifies it into your drive](docs/images/demo.gif)

---

## NAS / VPS Quick Start (GHCR)

Download [`docker-compose.fork.yml`](docker-compose.fork.yml) and create `.env` (refer to [`.env.example`](.env.example)):

```dotenv
# Required external services
MEDIA_TRACK_POSTGRES_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE_NAME
PANSOU_BASE_URL=http://PANSOU_HOST:PORT

# Optional Redis summary cache (PostgreSQL remains the source of truth)
REDIS_URL=redis://REDIS_HOST:6379

# GHCR image settings (defaults to ghcr.io/pickarm/mediary-scout:latest)
# MEDIA_TRACK_IMAGE=ghcr.io/pickarm/mediary-scout
MEDIA_TRACK_IMAGE_TAG=latest
WEB_PORT=3000

# Optional pre-seeded owner credentials (applied only while unclaimed; never overwrites changed passwords)
# MEDIA_TRACK_ADMIN_USERNAME=admin
# MEDIA_TRACK_ADMIN_PASSWORD=your_strong_password
```

Start and check the service:

```bash
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d web
docker compose -f docker-compose.fork.yml ps
```

Open `http://<HOST_IP>:3000` (health check at `/api/health`) to create or log in as the owner account and connect your cloud drives in **Settings**. For source-built all-in-one Docker (`docker-compose.yml`) or the upstream desktop app, see [`docs/deploy.md`](docs/deploy.md) and [upstream releases](https://github.com/fancydirty/mediary-scout/releases/latest).

---

## Authentication & Access Control

- **Default Protected Gate**: Unlike the legacy single-user mode that trusted non-Cloudflare requests, every Web page and session-scoped API requires a signed `mt_session` cookie by default (`/api/health`, `/api/workflows/*` guarded by `MEDIA_TRACK_WORKER_SECRET`, `/api/agent/*` guarded by Agent Bearer token, and `/api/update/{busy,hold}` remain handler-guarded; `MEDIA_TRACK_DEMO_MODE=1` stays read-only/unauthenticated).
- **HTTP & HTTPS Safe Cookie**: Leaving `MEDIA_TRACK_COOKIE_SECURE` unset detects HTTPS automatically from `x-forwarded-proto` or request protocol, while working out of the box on plain HTTP IP ports.
- **Key Environment Variables**:
  - `MEDIA_TRACK_ADMIN_USERNAME` / `MEDIA_TRACK_ADMIN_PASSWORD`: Optional pair to pre-provision the owner while unclaimed.
  - `MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1`: Disables first-time owner creation through `/login` so initialization only happens via the env pair above.
  - `MEDIA_TRACK_ALLOW_REGISTRATION`: Unset lets the owner toggle public sign-up in **Settings → 账号** (closed by default); `1` or `0` locks the policy via env.
  - `MEDIA_TRACK_MULTI_USER=0`: Legacy opt-out restoring single-user LAN bypass.
- **Forgotten Password Reset CLI**:
  ```bash
  docker compose -f docker-compose.fork.yml exec web node scripts/reset-password.mjs <username>
  ```

---

## GitHub Actions GHCR Auto-Build

Two workflows in `.github/workflows/` build and verify a single `linux/amd64` container image (checking `/api/health`, `/login`, and unauthenticated `/` redirect before pushing):

- **Branch & Manual Builds ([`.github/workflows/docker-autobuild.yml`](.github/workflows/docker-autobuild.yml))**:
  - Runs on `push` to `main` (publishes `:latest`, `:edge`, and `:sha-<12>`) or `feature/pickarm-v1` (`:dev` and `:sha-<12>`), plus manual `workflow_dispatch` with custom `image_tag` / `push_latest`.
  - Pushes directly to `ghcr.io/<owner>/<repo>` using `GITHUB_TOKEN` (no external secrets needed).
- **Tagged Releases ([`.github/workflows/fork-image.yml`](.github/workflows/fork-image.yml))**:
  - Runs on `v*` tags after full [`ci.yml`](.github/workflows/ci.yml) + release preflight pass; pushes `:<tag>`, `:sha-<40>`, and `:latest` to GHCR, verifies all three remote digests match, and publishes the GitHub Release.

To enable in your own fork: ensure **Settings → Actions → General → Workflow permissions** is set to **Read and write permissions**, and after the first push set your GHCR package `mediary-scout` visibility to **Public** so NAS/servers can `docker pull` anonymously.

---

## Supported Drives

- **Quark (夸克)** · **UC Drive (UC)** · **Tianyi (天翼)**: share-link transfers, QR login, and existing library scan/organize.
- **115** · **123** · **GuangYaPan (光鸭)**: share links + magnets/offline transfers, QR/device/token login, and existing library scan/organize.

---

## Messaging Bots & Direct Import

Configure **WeChat**, **Feishu**, or **Telegram** per account in **Settings → 巡检 → 消息机器人** (off by default; owner private chat only). Supported chat actions include `帮助`, `我想看 <title>`, sharing cloud-drive links (with optional extraction code), sending `magnet:` URIs, `查询 [taskId]`, and `停止 [taskId]`.

---

## Development & Verification

Requires Node.js `>=22.13.0` and `npm` (`package-lock.json`):

```bash
npm ci
npm run build:workflow
npm run build:web
npm run typecheck
npm run typecheck:migration
npx tsc --noEmit --project apps/web/tsconfig.json
npm run lint
npx vitest run --exclude '**/*.pg.test.ts' --exclude '**/*.postgres.test.ts'
```

---

## Disclaimer & Credits

Mediary Scout is open-source, self-hosted software and never operates as a hosted service. You run your own instance and supply your own cloud-drive, LLM, and search credentials. See [project positioning](docs/distribution-and-legal-positioning.md). Not affiliated with 115, Quark, UC, GuangYaPan, 123, Tianyi, TMDB, WeChat, Feishu, Telegram, or any indexer.

Built with thanks to upstream [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout), [LINUX DO community](https://linux.do), [PanSou](https://github.com/fish2018/pansou-web), [Prowlarr](https://github.com/Prowlarr/Prowlarr), [p115client](https://github.com/ChenyangGao/p115client), [p123client](https://github.com/ChenyangGao/p123client), [AList](https://github.com/AlistGo/alist), [cloud189-auto-save](https://github.com/1307super/cloud189-auto-save) / [cloudpan189-api](https://github.com/tickstep/cloudpan189-api), and [TMDB](https://www.themoviedb.org/).
