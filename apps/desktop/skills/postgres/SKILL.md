---
name: postgres
kind: stack
category: code
description: PostgreSQL: схема и типы, внешние ключи и индексы, миграции, сид-данные, поиск ILIKE, транзакции, подключение из приложения и Docker
triggers: postgres, postgresql, psql, pg_dump, pg_isready
---
## Схема
- Ключи: `id` — `SERIAL`/`BIGSERIAL` или `uuid` (`gen_random_uuid()`); внешние ключи с `ON DELETE` осознанно (`CASCADE` для отзывов книги, `RESTRICT` для автора с книгами).
- Деньги — `NUMERIC(10,2)` (не float); даты — `timestamptz`; флаги — `boolean`; перечисления — `text` + `CHECK` или enum.
- Индексы: на внешние ключи, на поля фильтров и сортировки (`price`, `rating`), для поиска по подстроке — `pg_trgm` + GIN или хотя бы `lower(title)`.
- `NOT NULL` по умолчанию, `UNIQUE` для email/ISBN.

## Миграции и сид
- Схема меняется только миграциями (TypeORM `migration:generate/run`, Prisma `migrate`, Laravel `migrate`); `synchronize: true` — только в песочнице, не в проде.
- Сид — идемпотентный: проверяй, есть ли уже данные, или `ON CONFLICT DO NOTHING`; связи создавай по порядку (жанры → авторы → книги → отзывы).
- Правдоподобные данные: реальные названия, разные цены, остатки, рейтинги.

## Запросы
- Поиск: `title ILIKE $1` с `%q%`; параметры всегда через плейсхолдеры, никакой склейки строк.
- Пагинация: `LIMIT/OFFSET` + отдельный `count(*)` (или `getManyAndCount`).
- Заказ, который уменьшает остаток, — в транзакции, с проверкой `stock >= qty` (`UPDATE … SET stock = stock - $2 WHERE id = $1 AND stock >= $2` и проверка числа изменённых строк).

## Подключение
Параметры из окружения (`DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME`); в Docker хост — имя сервиса (`db`). Приложение должно ждать готовности базы (`depends_on: condition: service_healthy`).
