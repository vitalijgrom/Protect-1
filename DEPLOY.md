# Деплой на Cloudflare Pages: `viferon-reviews.dump.su`

Пошагово, от пустого проекта до работающего поддомена.

Зона `dump.su` уже обслуживается неймсерверами Cloudflare
(`mona.ns.cloudflare.com`, `rory.ns.cloudflare.com`), поддомена
`viferon-reviews` пока нет. Поэтому DNS-запись руками создавать не придётся —
Cloudflare добавит её сам на шаге 4.

Единственное условие: зона `dump.su` и проект Pages должны быть **в одном
аккаунте Cloudflare**. Если зона в другом аккаунте, шаг 4 попросит
подтверждающую TXT-запись — Cloudflare покажет её значение прямо в интерфейсе.

---

## Шаг 0. Влить ветку в `main`

Pages собирает production-ветку. Смержите
[PR #1](https://github.com/vitalijgrom/Protect-1/pull/1) в `main` — тогда
production-веткой будет `main`.

Альтернатива: оставить PR открытым, а на шаге 1 указать production-веткой
`claude/google-sheets-dashboard-0r083w`. Но это временное решение — после
мержа ветку придётся переключать.

## Шаг 1. Создать проект Pages

**Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**,
выбрать репозиторий `vitalijgrom/Protect-1`.

Настройки сборки:

| Поле | Значение |
|---|---|
| Project name | `viferon-reviews-dashboard` |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *оставить пустым* |
| Build output directory | `public` |
| Root directory | `/` (по умолчанию) |

Имя проекта лучше оставить таким же, как `name` в `wrangler.toml` — иначе
`wrangler pages deploy` из командной строки будет ругаться на несовпадение.

Нажать **Save and Deploy**. Сборки как таковой нет — Cloudflare просто
разложит содержимое `public/`, это занимает секунды. Каталог `functions/`
подхватывается автоматически, включать ничего не нужно.

## Шаг 2. Переменные окружения

**Ничего делать не нужно.** `SHEET_ID`, `SHEET_NAME` и `CACHE_TTL` лежат в
`wrangler.toml`, а для Pages этот файл — источник истины: в дашборде вы увидите
эти переменные, но поля будут недоступны для правки.

Чтобы менять переменные из дашборда, удалите блок `[vars]` из `wrangler.toml`,
запушьте и добавьте их в **Settings → Variables and Secrets** — для
Production и Preview отдельно.

Если ID таблицы считается чувствительным, второй вариант предпочтительнее:
переменная, заданная в дашборде как **Secret**, не хранится в репозитории.

## Шаг 3. Проверить на технической выдаче

Пока без своего домена, на `*.pages.dev`:

```bash
curl -sI https://viferon-reviews-dashboard.pages.dev/api/reviews | grep -i 'x-cache\|^HTTP'
```

Ожидаемо: `HTTP/2 200` и `x-cache: MISS` (на втором запросе — `HIT`).

Откройте страницу в браузере. Жёлтого баннера быть не должно, в подвале —
`Источник: Google Таблица`. Если баннер есть, функция не поднялась: смотрите
таблицу диагностики ниже.

## Шаг 4. Подключить `viferon-reviews.dump.su`

Проект → **Custom domains** → **Set up a domain** → ввести
`viferon-reviews.dump.su` → **Continue** → **Activate domain**.

Cloudflare сам создаст в зоне `dump.su` проксированный CNAME на
`viferon-reviews-dashboard.pages.dev` и выпустит сертификат. Обычно это пара
минут, изредка до пятнадцати.

> **Не создавайте CNAME руками заранее.** Если запись появится в DNS до того,
> как домен привязан к проекту, поддомен ответит **522**. Тогда удалите запись
> и пройдите через **Custom domains** заново.

## Шаг 5. Проверка

```bash
curl -sI https://viferon-reviews.dump.su/ | head -3
curl -s  https://viferon-reviews.dump.su/api/reviews | head -c 120
```

Второй запрос должен начинаться с `{"ok":true,"source":"google-sheets"`.

## Шаг 6. Закрыть доступ (рекомендуется)

Дашборд внутренний. В разметке стоит `noindex, nofollow`, но от прямой ссылки
это не защищает — закройте его Cloudflare Access:

**Zero Trust → Access → Applications → Add an application → Self-hosted**

| Поле | Значение |
|---|---|
| Application name | `Viferon reviews` |
| Domain | `viferon-reviews.dump.su` |
| Policy action | **Allow** |
| Include | `Emails` со списком адресов, либо `Emails ending in` + ваш домен |

Вход будет по одноразовому коду на почту. `/api/reviews` закроется вместе со
страницей — это правильно: дашборд ходит в него с той же авторизованной
сессии, отдельная настройка не нужна.

## Обновления

Любой push в `main` запускает новый деплой автоматически. Откат — в
**Deployments**: у нужного деплоя `···` → **Rollback to this deployment**.

## Данные и кэш

* Ответ прослойки живёт на edge `CACHE_TTL` секунд (сейчас 300). Дашборд, кроме
  того, сам перезапрашивает данные раз в 5 минут.
* Кнопка **«Обновить»** дёргает `/api/reviews?refresh=1` — это обходит кэш и
  идёт в таблицу напрямую.
* Поменять TTL: `CACHE_TTL` в `wrangler.toml` → push.
* Заголовок `x-cache: STALE` означает, что Google сейчас недоступен и отдаётся
  последний удачный ответ. Само пройдёт, как только таблица ответит.
* Снапшот `public/data/fallback.json` подтягивается, только если сама прослойка
  не отвечает. Обновляется командой `npm run snapshot` и попадает в репозиторий
  обычным коммитом.

## Диагностика

| Симптом | Причина | Что делать |
|---|---|---|
| Поддомен отдаёт **522** | CNAME создали руками до привязки домена к проекту | Удалить запись в DNS, пройти **Custom domains → Set up a domain** |
| `/api/reviews` отдаёт **404** | неверный Build output directory или `functions/` не в корне репозитория | Output directory — `public`, каталог `functions/` — в корне |
| **502**, `"Google Sheets ответил 404"` | неверный `SHEET_ID` | Сверить ID с URL таблицы |
| **502**, `"gviz вернул ошибку"` | у таблицы нет доступа по ссылке | Google Таблица → Доступ → «Любой, у кого есть ссылка» → Читатель |
| Жёлтый баннер про снапшот | `/api/reviews` не отвечает | Открыть `/api/reviews` напрямую и посмотреть тело ошибки |
| Данные не меняются после правки таблицы | edge-кэш | Нажать «Обновить» или подождать `CACHE_TTL` |
| Домен не активируется дольше 15 минут | зона `dump.su` в другом аккаунте Cloudflare | Добавить TXT-запись, которую показывает мастер привязки |

## Альтернатива: деплой из командной строки

Без подключения к Git, разово:

```bash
npm install
npx wrangler pages project create viferon-reviews-dashboard
npx wrangler pages deploy public
```

Поддомен подключается так же — через **Custom domains** в интерфейсе.

Учтите: проект, созданный загрузкой напрямую (Direct Upload), потом **нельзя**
подключить к Git — придётся создавать новый. Если планируете автодеплой из
репозитория, идите по шагу 1.
