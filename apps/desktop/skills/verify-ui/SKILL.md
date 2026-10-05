---
name: verify-ui
description: Как проверять готовую страницу в реальном браузере (preview_page, run_in_page) и не заявлять «проверено» без запуска
triggers: html, лендинг, landing, страниц, форм, вёрстк, верстк, интерфейс, ui
---
Правило: «работает / проверено / соответствует чек-листу» можно писать только после запуска инструмента, который это подтвердил.

## Порядок
1. `preview_page(path)` — ошибки JS, горизонтальная прокрутка на 375px, битые якоря/картинки, структура. Исправь всё из «НАЙДЕНЫ ПРОБЛЕМЫ». В самом конце можно один раз `preview_page(path, look:true)` для отзыва по скриншоту.
2. `run_in_page(path, script)` — сценарии. Тело скрипта — async-функция; доступны `$`, `$$`, `visible(el)`, `wait(ms)`; верни объект. `alert()` перехватывается (попадёт в `alerts`).
3. Если сценарий показал ложь там, где ожидалась правда — почини код и повтори сценарий.

## Шаблоны сценариев
Форма с успехом:
```
$('input[type=email]').value = 'a@b.co';
$('form').requestSubmit();
await wait(300);
return { formHidden: !visible($('form')), successVisible: visible($('.success, #success, [role=status]')) };
```
Форма с ошибкой:
```
$('input[type=email]').value = 'не-почта';
$('form').requestSubmit();
await wait(200);
return { errorVisible: visible($('[role=alert]')), errorText: $('[role=alert]')?.textContent };
```
Бургер-меню (телефон, `width:375`):
```
const b = $('.burger, .menu-toggle, [aria-controls]');
const before = b.getAttribute('aria-expanded');
b.click(); await wait(200);
return { before, after: b.getAttribute('aria-expanded'), navVisible: visible($('nav ul, .nav-links')) };
```
Счётчик/кнопка:
```
const btn = $('.like, .hug, button[data-count]'); const t0 = btn.textContent;
btn.click(); btn.click(); await wait(100);
return { before: t0, after: btn.textContent };
```
Наличие обязательного контента:
```
return { ctaInHeader: !!$('header a[href="#subscribe"], header .btn, header button'), cards: $$('.card').length, footerCols: $$('footer > * > *').length };
```

## Итог
В ИТОГе — таблица: что проверено каким инструментом и результат. Что не проверено (нет браузера, не хватило шагов) — так и написать.
