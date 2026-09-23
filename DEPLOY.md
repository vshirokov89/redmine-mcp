# Развёртывание своего экземпляра Redmine-коннектора

Эта инструкция — для коллеги, который хочет пользоваться Redmine в Claude
**под своей учётной записью Redmine** (со своим API-ключом).

## Почему нельзя просто «дать ссылку на мой коннектор»

Текущий коннектор работает в режиме **«только я»**: на сервере хранится один
Redmine-ключ (владельца), а доступ разрешён только его GitHub-аккаунту. Если
коллега подключит этот же URL, он либо не получит доступ, либо (будь он в списке)
ходил бы под чужим ключом. Поэтому у коллеги должен быть **свой экземпляр**
коннектора — со своим ключом и своим входом. Разворачивается он один раз, дальше
работает во всех клиентах Claude (веб, десктоп, айфон).

> Альтернатива — «общий» коннектор с несколькими пользователями, где ключ каждого
> хранится отдельно. Это отдельная доработка (мультирежим). Здесь описан простой и
> надёжный путь: у каждого свой экземпляр.

## Что понадобится коллеге

- Аккаунт GitHub.
- Бесплатный аккаунт Cloudflare.
- Свой Redmine API-ключ (Redmine → «Моя учётная запись» → «Ключ доступа к API»).
- Доступ к нужному Redmine (тот же `rm.egspace.ru` или другой — из интернета).

---

## Шаги

### 1. Получить свою копию репозитория
Workers Builds собирает из репозитория, которым владеет сам пользователь, поэтому
нужен **свой** репозиторий:
- Откройте `https://github.com/vshirokov89/redmine-mcp` и нажмите **Fork**
  (если репозиторий приватный — владелец добавляет коллегу в Collaborators, либо
  отдаёт архив, и коллега создаёт свой репозиторий из этих файлов).

### 2. Подправить настройки под себя
В своей копии откройте `cloudflare/wrangler.jsonc`, блок `vars`:
- `REDMINE_URL` — адрес вашего Redmine (если тот же — оставьте `https://rm.egspace.ru`).
- `ALLOWED_GITHUB_USERNAMES` — **ваш** GitHub-логин (замените `vshirokov89`).

Больше в коде менять ничего не нужно.

### 3. Аккаунт Cloudflare
Зарегистрируйтесь на **dash.cloudflare.com** (бесплатно, без карты).

### 4. Создать KV namespace
Dashboard → **Storage & Databases → KV → Create a namespace** (имя любое,
например `redmine-mcp-oauth`). Скопируйте **ID** и впишите его в
`cloudflare/wrangler.jsonc` вместо значения `id` у `OAUTH_KV` (коммит в свой репозиторий).

### 5. Подключить репозиторий к сборке
Dashboard → **Workers & Pages → Create → Workers → Import a repository** →
**Continue with GitHub** → выберите свою копию `redmine-mcp`. Настройки сборки:
- **Root directory**: `cloudflare`
- **Build command**: `npm install`
- **Deploy command**: `sh deploy.sh`
- **Branch**: `main`

Запустите первый деплой. Появится адрес вида
`https://redmine-mcp.<ваш-субдомен>.workers.dev` (при первом разе Cloudflare
попросит выбрать workers.dev subdomain — придумайте любой).

### 6. Создать GitHub OAuth App
GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
(или `https://github.com/settings/applications/new`):
- **Homepage URL**: `https://redmine-mcp.<ваш-субдомен>.workers.dev`
- **Authorization callback URL** (в новом интерфейсе поле называется **Redirect URI**):
  `https://redmine-mcp.<ваш-субдомен>.workers.dev/callback`

Получите **Client ID** и **Generate a new client secret** (секрет показывается один раз).

### 7. Задать переменные сборки (секреты)
В настройках Worker → раздел **Build** → **Variables and secrets** (именно в блоке
Build, не в runtime!). Добавьте 4 штуки, каждую как **Secret / Encrypt**:

| Variable name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | Client ID из шага 6 |
| `GITHUB_CLIENT_SECRET` | Client secret из шага 6 |
| `COOKIE_ENCRYPTION_KEY` | любая случайная строка (например, `openssl rand -hex 32`) |
| `REDMINE_API_KEY` | **ваш** ключ Redmine |

> Почему в Build-переменные, а не в runtime: при сборке из GitHub `wrangler deploy`
> стирает runtime-секреты (cloudflare/workers-sdk#8871). Скрипт `deploy.sh`
> подставляет их в момент деплоя через `--secrets-file`, читая эти Build-переменные.

### 8. Пересобрать и проверить привязки
Deployments/Builds → **⋯ → Retry build**. В логе, в блоке
`Your Worker has access to the following bindings:`, должны появиться все 4 секрета
(как `(hidden)`), плюс `MCP_OBJECT`, `OAUTH_KV`, `REDMINE_URL`, `ALLOWED_GITHUB_USERNAMES`.

### 9. Подключить коннектор в Claude
Claude → **Настройки → Connectors → Add custom connector**:
- **URL**: `https://redmine-mcp.<ваш-субдомен>.workers.dev/mcp`
- Authentication: **Sign in now** (детектируется), OAuth client: **Register automatically**, заголовки — пусто.

Нажмите **Connect** → вход через **GitHub** → **Approve**. Готово во всех клиентах,
включая айфон.

### 10. Проверка
В новом чате: «вызови **whoami** из Redmine» — должен показать ваш GitHub-аккаунт и
вашего Redmine-пользователя. Затем «покажи мои проекты в Redmine».

---

## Частые проблемы (проверено на практике)

- **`Could not detect a directory containing static files`** — не задан
  **Root directory = `cloudflare`**.
- **`ERESOLVE` при npm install** — устаревшая версия `@cloudflare/workers-types`;
  в `package.json` должна быть `^5.x` (в этом репозитории уже так).
- **`Internal server error: cookieSecret is required`** — секреты не дошли до
  worker'а: они должны быть в **Build-переменных**, а Deploy command = `sh deploy.sh`.
  После настройки — **Retry build**, и в логе убедитесь, что секреты появились в bindings.
- **Redmine отвечает 403/404** — это права вашей учётки в самом Redmine, не ошибка коннектора.

## Обновления
Любой коммит в свой репозиторий (папка `cloudflare/`) запускает пересборку
автоматически. Сменить/отозвать ключ — обновить Build-переменную `REDMINE_API_KEY`
и **Retry build**.
