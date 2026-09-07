# Redmine для Claude Code

Работа с Redmine (задачи, учёт времени, проекты и справочники) прямо из Claude Code.

Есть два способа — выберите один:

- **Плагин (skill на curl)** — рекомендуется. Ничего не разворачивать, никаких зависимостей: Claude сам ходит в Redmine REST API через `curl`.
- **MCP-сервер (Python)** — структурированные инструменты, но нужен `uv`/Python.

---

## Способ 1 — Плагин (без сервера) ⭐

### Установка

В Claude Code:

```
/plugin marketplace add vshirokov89/redmine-mcp
/plugin install redmine@redmine-mcp
```

### Настройка доступа

Задайте адрес и API-ключ Redmine одним из способов.

Вариант А — переменные окружения (например, в `~/.zshrc`):

```bash
export REDMINE_URL="https://redmine.example.com"
export REDMINE_API_KEY="ваш_ключ"
```

Вариант Б — файл конфигурации:

```bash
mkdir -p ~/.config/redmine
cat > ~/.config/redmine/config <<'EOF'
REDMINE_URL="https://redmine.example.com"
REDMINE_API_KEY="ваш_ключ"
EOF
chmod 600 ~/.config/redmine/config
```

API-ключ: в Redmine → «Моя учётная запись» → «Ключ доступа к API».

### Использование

Просто просите на естественном языке, например:
- «Покажи мои открытые задачи в проекте website»
- «Заведи задачу в проекте backend: не грузится отчёт»
- «Залогируй 2 часа на задачу #1234, работал над API»
- «Что я списал по времени за эту неделю?»

Что умеет: поиск/просмотр/создание/обновление/комментирование задач; просмотр и логирование времени; список проектов, статусов, трекеров, приоритетов, активностей, пользователей.

---

## Способ 2 — MCP-сервер (Python)

Файл сервера: [`redmine_mcp.py`](redmine_mcp.py). Даёт те же операции в виде MCP-инструментов.

Требуется [`uv`](https://docs.astral.sh/uv/) (сам поставит нужный Python и зависимости):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Проверка запуска:

```bash
REDMINE_URL="https://redmine.example.com" REDMINE_API_KEY="ваш_ключ" uv run redmine_mcp.py
```

Подключение к Claude Code:

```bash
claude mcp add redmine \
  -e REDMINE_URL="https://redmine.example.com" \
  -e REDMINE_API_KEY="ваш_ключ" \
  -- uv run "$HOME/redmine-mcp/redmine_mcp.py"
```

Опционально `REDMINE_VERIFY_SSL="false"` — для самоподписанного сертификата.

---

## Требования на стороне Redmine

REST API должен быть включён: Администрирование → Настройки → Аутентификация → «Включить веб-сервис REST». Все действия выполняются от имени владельца API-ключа с его правами.

## Безопасность

Не коммитьте API-ключ в репозиторий. Держите его в переменных окружения или в `~/.config/redmine/config` (с правами `600`).

## Лицензия

MIT
