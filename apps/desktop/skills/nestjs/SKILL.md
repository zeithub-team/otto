---
name: nestjs
kind: stack
category: code
description: NestJS + TypeORM: структура модулей, правильные импорты, репозитории, DTO и валидация, JWT-авторизация, Swagger, тесты
triggers: nestjs, nest.js, @nestjs, typeorm, nest new, nest-cli
---
Собирай NestJS-проект так, чтобы `npx tsc --noEmit` и `npm run build` проходили после каждого модуля.

## Порядок работы
1. `package.json`, `tsconfig.json`, `nest-cli.json` → `npm install` (сразу, иначе нечем проверить).
2. Один модуль целиком (entity → dto → service → controller → module) → подключи в `app.module.ts` → `npx tsc --noEmit` → чини → следующий модуль.
3. Не создавай `app.module.ts` с импортами модулей, которых ещё нет.

## Имена и пути (одна схема на весь проект)
`src/books/books.module.ts`, `books.service.ts`, `books.controller.ts`, `entities/book.entity.ts`, `dto/create-book.dto.ts`, `dto/update-book.dto.ts`. Классы: `BooksModule`, `BooksService`, `BooksController`, `Book`. Импорт внутри модуля — `./books.service`, из соседнего — `../authors/entities/author.entity`. Перед импортом проверь, что файл с таким именем есть.

## Правильные импорты (частые ошибки)
- `Module, Controller, Injectable, Get, Post, Patch, Delete, Body, Param, Query, ParseIntPipe, NotFoundException, BadRequestException, UnauthorizedException, ForbiddenException, SetMetadata, UseGuards, ValidationPipe` — из `@nestjs/common` (НЕ из `@nestjs/core`).
- `Reflector`, `NestFactory`, `APP_GUARD` — из `@nestjs/core`.
- `TypeOrmModule, InjectRepository` — `@nestjs/typeorm`; `Repository, Entity, Column, …` — `typeorm`.
- `PassportStrategy, AuthGuard` — `@nestjs/passport`; `Strategy, ExtractJwt` — `passport-jwt` (не из `@nestjs/passport`).
- `JwtModule, JwtService` — `@nestjs/jwt`. `ConfigModule, ConfigService` — `@nestjs/config`.
- `ApiTags, ApiProperty, ApiBearerAuth, DocumentBuilder, SwaggerModule` — `@nestjs/swagger`.
- `PartialType` для update-DTO — из `@nestjs/swagger` (или `@nestjs/mapped-types`).
- Валидаторы `IsString, IsInt, IsOptional, Min, Max, IsEmail, MinLength` — `class-validator`; `Type` — `class-transformer`.

## TypeORM — это Data Mapper, а не Active Record
Сущность — только класс с декораторами. Доступ к БД только через репозиторий:
```ts
constructor(@InjectRepository(Book) private readonly books: Repository<Book>) {}
findOne(id: number) { return this.books.findOne({ where: { id }, relations: { author: true, genre: true } }); }
```
НЕ пиши `Book.findOne()` / `User.create()`. В модуле: `imports: [TypeOrmModule.forFeature([Book])]`, `providers: [BooksService]`, `exports: [BooksService]` если нужен другим.
Подключение: `TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (c) => ({ type: 'postgres', host: c.get('DB_HOST'), …, autoLoadEntities: true, synchronize: false, migrations: ['dist/migrations/*.js'] }) })`.

## Каталог: поиск, фильтры, пагинация
`QueryBuilder`: `.leftJoinAndSelect('b.author','a')`, `.andWhere('(b.title ILIKE :q OR a.name ILIKE :q OR b.isbn ILIKE :q)', { q: \`%${q}%\` })`, `.skip((page-1)*limit).take(limit)`, `.getManyAndCount()` → `{ items, total, page, limit }`.

## main.ts
`app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`, `app.setGlobalPrefix('api')`, Swagger на `api/docs`, `app.enableShutdownHooks()`, порт из `PORT`, слушать `0.0.0.0` (иначе в Docker не достучаться).

## Авторизация
`JwtStrategy extends PassportStrategy(Strategy)` с `jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()`; `JwtAuthGuard extends AuthGuard('jwt')`; роли: декоратор `Roles = (...r) => SetMetadata('roles', r)` + `RolesGuard` с `Reflector`. Пароли — `bcrypt.hash(p, 10)`, в ответах пароль не отдавай.

## Тесты
Юнит: `Test.createTestingModule({ providers: [BooksService, { provide: getRepositoryToken(Book), useValue: mockRepo }] })`. E2E: `supertest` по `app.getHttpServer()`.
