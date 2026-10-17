---
name: docker-compose
kind: stack
category: code
description: Docker и docker compose по best practices: multi-stage Dockerfile, не-root, .dockerignore, сервисы, своя сеть, healthcheck, volumes, секреты через .env, проверка запуска
triggers: docker, dockerfile, docker-compose, docker compose, compose.yaml, контейнер, container
---
## Dockerfile (Node / NestJS пример)
```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/main.js"]
```
`npm ci` требует `package-lock.json` — сначала `npm install` локально. `.dockerignore`: `node_modules`, `dist`, `.git`, `.env`, `*.log`, `coverage`.

## docker-compose.yml
```yaml
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_DB: ${DB_NAME}, POSTGRES_USER: ${DB_USER}, POSTGRES_PASSWORD: ${DB_PASSWORD} }
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [backend]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"], interval: 5s, timeout: 3s, retries: 10 }
    restart: unless-stopped
    # без ports: база доступна только внутри сети
  app:
    build: .
    env_file: .env
    environment: { DB_HOST: db }
    depends_on: { db: { condition: service_healthy } }
    networks: [backend, frontend]
    ports: ["3000:3000"]
    restart: unless-stopped
networks: { backend: { internal: true }, frontend: {} }
volumes: { pgdata: {} }
```
- Хост БД внутри compose — имя сервиса (`db`), не `localhost`.
- `internal: true` у backend-сети: у базы нет выхода наружу. Приложение в двух сетях.
- Секреты только в `.env` (в `.gitignore`), рядом `.env.example` с пустыми значениями.
- Миграции при старте: `command: sh -c "node dist/migrate.js && node dist/main.js"` или отдельный сервис `migrate` с `depends_on`.
- nginx (если нужен) — отдельный сервис в frontend-сети, `proxy_pass http://app:3000`.

## Проверка
1. `docker compose config` — синтаксис и подстановка переменных.
2. `docker compose up -d --build`, затем `docker compose ps` — все сервисы `healthy`/`running`.
3. `docker compose logs app --tail 50` при ошибке.
4. `curl.exe -s http://127.0.0.1:3000/api/health`, открой сайт и `/api/docs`.
