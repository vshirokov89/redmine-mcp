# Redmine MCP-коннектор

MCP-сервер, дающий Claude инструменты для работы с Redmine через REST API.

## Возможности

**Задачи**
- `list_issues` — поиск задач с фильтрами (проект, статус, исполнитель, трекер, текст)
- `get_issue` — задача целиком (с комментариями, вложениями, связями, подзадачами)
- `create_issue` — создание задачи/подзадачи
- `update_issue` — изменение полей и/или добавление комментария
- `add_issue_comment` — только комментарий

**Учёт времени**
- `list_time_entries` — записи о времени (по задаче/проекту/пользователю/датам)
- `create_time_entry` — залогировать часы на задачу или проект

**Проекты и справочники**
- `list_projects`, `get_project`
- `list_statuses`, `list_trackers`, `list_priorities`, `list_time_entry_activities`
- `list_users`, `current_user`

## Требования

- **API-ключ Redmine**: в Redmine → «Моя учётная запись» → «Ключ доступа к API».
- REST API должен быть включён на сервере: Администрирование → Настройки → Аутентификация → «Включить веб-сервис REST».
- **uv** (менеджер Python, ставит нужный Python и зависимости сам).

## Установка uv (один раз)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

После установки перезапустите терминал (или `source ~/.zshrc`), проверьте: `uv --version`.

## Проверка вручную

```bash
REDMINE_URL="https://redmine.example.com" REDMINE_API_KEY="ваш_ключ" uv run redmine_mcp.py
```

Сервер запустится и будет ждать MCP-подключение по stdio (Ctrl+C для выхода). Ошибок при старте быть не должно.

## Подключение к Claude Code

Замените путь, URL и ключ на свои:

```bash
claude mcp add redmine \
  -e REDMINE_URL="https://redmine.example.com" \
  -e REDMINE_API_KEY="ваш_ключ" \
  -- uv run "/полный/путь/к/redmine_mcp.py"
```

Либо вручную добавьте в `.mcp.json` (в корне проекта) или в пользовательский конфиг:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "uv",
      "args": ["run", "/полный/путь/к/redmine_mcp.py"],
      "env": {
        "REDMINE_URL": "https://redmine.example.com",
        "REDMINE_API_KEY": "ваш_ключ"
      }
    }
  }
}
```

Опционально: `REDMINE_VERIFY_SSL="false"` — если у Redmine самоподписанный сертификат.

## Безопасность

Не коммитьте API-ключ в репозиторий. Держите его в `env` конфига MCP или в переменных окружения, а не в самом коде.
