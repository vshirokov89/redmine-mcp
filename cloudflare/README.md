# Redmine remote MCP connector (Cloudflare Worker)

Удалённый MCP-коннектор к Redmine, работающий на Cloudflare Workers. Доступен во
всех клиентах Claude — веб, десктоп и **мобильное приложение**. Вход защищён через
GitHub OAuth, доступ разрешён только аккаунтам из списка `ALLOWED_USERNAMES`
(`src/index.ts`). Redmine-ключ хранится как секрет Worker (режим «только я»).

Развёртывание — **без установки Node на вашем компьютере**: Cloudflare сам собирает
код из этого GitHub-репозитория (Workers Builds).

## Что нужно один раз

- Бесплатный аккаунт Cloudflare (dash.cloudflare.com).
- Этот GitHub-репозиторий.
- GitHub OAuth App (создаётся ниже).
- Ваш Redmine API-ключ (Redmine → «Моя учётная запись» → «Ключ доступа к API»).

## Шаги

### 1. Создать KV namespace
Cloudflare dashboard → **Storage & Databases → KV → Create a namespace**.
Имя, например, `redmine-mcp-oauth`. Скопируйте его **ID** и впишите в
`cloudflare/wrangler.jsonc` вместо `<PUT-YOUR-KV-NAMESPACE-ID-HERE>` (коммит в репозиторий).

### 2. Подключить репозиторий к Workers Builds
Dashboard → **Workers & Pages → Create → Workers → Import a repository** →
выберите репозиторий `redmine-mcp`. В настройках сборки:
- **Root directory**: `cloudflare`
- **Deploy command**: `npx wrangler deploy`
- **Build command**: оставить пустым (или `npm install`).

Запустите первый деплой. После него у Worker появится адрес вида
`https://redmine-mcp.<ваш-субдомен>.workers.dev`.

### 3. Создать GitHub OAuth App
GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
- **Homepage URL**: `https://redmine-mcp.<ваш-субдомен>.workers.dev`
- **Authorization callback URL**: `https://redmine-mcp.<ваш-субдомен>.workers.dev/callback`

Получите **Client ID** и сгенерируйте **Client Secret**.

### 4. Задать секреты Worker
Dashboard → ваш Worker → **Settings → Variables and Secrets** → добавить как **Secret**:
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `COOKIE_ENCRYPTION_KEY` — любая случайная строка (например, `openssl rand -hex 32`)
- `REDMINE_API_KEY` — ваш ключ Redmine

`REDMINE_URL` уже задан как обычная переменная в `wrangler.jsonc`
(`https://rm.egspace.ru`). После добавления секретов запустите деплой заново
(**Deployments → Retry / Redeploy**), чтобы они применились.

### 5. Подключить коннектор в Claude
Claude → **Настройки → Connectors → Add custom connector** →
URL: `https://redmine-mcp.<ваш-субдомен>.workers.dev/mcp` → сохранить.
Claude предложит войти — авторизуйтесь через GitHub. Готово во всех клиентах,
включая айфон.

### 6. Проверка
В любом чате: «вызови whoami» (покажет ваш GitHub-аккаунт и Redmine-пользователя),
затем «покажи мои проекты в Redmine».

## Доступ для коллег (позже)
Сейчас режим «только я»: один Redmine-ключ на сервере, доступ у аккаунтов из
`ALLOWED_USERNAMES`. Чтобы каждый коллега ходил под своим ключом, потребуется
мульти-режим (хранение ключа на пользователя в KV) — это отдельная доработка.

## Локальная разработка (опционально)
Нужен Node.js. `npm install`, скопировать `.dev.vars.example` → `.dev.vars`,
заполнить значения, `npm start`. Инструменты: `npx wrangler ...`.
