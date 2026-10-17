---
name: laravel
kind: stack
category: code
description: Laravel: установка, модели и миграции, контроллеры и маршруты, Blade, валидация, авторизация и роли, проверка, что страницы реально открываются
triggers: laravel, artisan, blade, eloquent, composer create-project
---
Делай Laravel-проект так, чтобы каждая страница реально открывалась, а не только «файлы созданы».

## Установка
- `composer create-project laravel/laravel .` (в текущую папку). Если composer блокирует версию из-за security advisories — НЕ отключай `policy.advisories`: скажи пользователю, что нужна более новая PHP (8.2+), или поставь последнюю версию Laravel, которую позволяет PHP.
- SQLite: в `.env` `DB_CONNECTION=sqlite`, файл `database/database.sqlite` (PowerShell: `New-Item -ItemType File database/database.sqlite`). `php artisan key:generate` если `APP_KEY` пуст.
- Пути: сидеры в `database/seeders/`, миграции `database/migrations/`, модели `app/Models/`, контроллеры `app/Http/Controllers/`, шаблоны `resources/views/`.

## Контроллер ↔ шаблон (главный источник ошибок 500)
Каждая переменная, которую использует Blade-шаблон (`$books`, `$counts`, `$author`…), должна передаваться из контроллера: `return view('authors.show', compact('author', 'books'))`. Перед тем как писать шаблон, посмотри, что отдаёт контроллер, и наоборот. Связи — `$author->load('books.genre')`, счётчики — `withCount('books')`.

## Маршруты и формы
- Ресурсы: `Route::resource('books', BookController::class)`; каждая форма из шаблона должна иметь маршрут (`reviews.store` для формы отзыва!).
- Формы: `@csrf`, для PUT/DELETE `@method('PUT')`, ошибки `@error('field')`, старые значения `old('field')`.
- Валидация: `$request->validate([...])` или FormRequest.

## Авторизация и админка
Поле `role` у `users` (миграция), `isAdmin()` в модели, middleware `admin` (регистрация в `Kernel.php` для Laravel 10 или `bootstrap/app.php` для 11+), группа `Route::middleware(['auth','admin'])->prefix('admin')->name('admin.')`. Кнопки создания/правки в шаблонах — `@auth @if(auth()->user()->isAdmin()) … @endif @endauth`.

## Проверка перед ответом «готово» (обязательно)
1. `php artisan migrate:fresh --seed`
2. `php artisan route:list`
3. Запусти сервер в фоне (`php artisan serve --port 8000`, background) и открой КАЖДУЮ новую страницу: `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8000/books/1` — все должны вернуть 200 (или 302 для закрытых). Для 500 смотри `storage/logs/laravel.log` (последние строки) и чини.
4. `php artisan test`.
Временные файлы проверок (cookies, html, ps1) удали.
