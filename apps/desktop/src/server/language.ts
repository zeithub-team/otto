/**
 * The agent answers in the language the user wrote in. Models given a Russian
 * system prompt drift into Russian, so the prompt names the language outright.
 */

export interface DetectedLanguage {
  code: string;
  /** Name used inside the (Russian) system prompt. */
  name: string;
}

const STOPWORDS: Record<string, { name: string; words: string[]; chars?: RegExp }> = {
  en: { name: 'английский (English)', words: ['the', 'and', 'is', 'are', 'to', 'of', 'in', 'for', 'with', 'this', 'that', 'please', 'make', 'add', 'create', 'how', 'what', 'my', 'you', 'can', 'it', 'a', 'on', 'be'] },
  es: { name: 'испанский (español)', words: ['el', 'la', 'los', 'las', 'un', 'una', 'de', 'que', 'y', 'en', 'para', 'con', 'por', 'como', 'es', 'del', 'crea', 'haz', 'quiero', 'necesito', 'por favor', 'mi'], chars: /[ñ¿¡]/ },
  it: { name: 'итальянский (italiano)', words: ['il', 'lo', 'la', 'gli', 'le', 'un', 'una', 'di', 'che', 'e', 'per', 'con', 'come', 'è', 'del', 'della', 'crea', 'fai', 'voglio', 'vorrei', 'grazie', 'mio'] },
  de: { name: 'немецкий (Deutsch)', words: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'ich', 'wie', 'bitte', 'erstelle', 'mache', 'auf', 'zu'], chars: /[äöüß]/ },
  fr: { name: 'французский (français)', words: ['le', 'la', 'les', 'un', 'une', 'des', 'et', 'est', 'pour', 'avec', 'que', 'comment', 'je', 'crée', 'fais', 'dans', 'sur', 'mon'], chars: /[àâçéèêëîïôùûœ]/ },
  pt: { name: 'португальский (português)', words: ['o', 'os', 'as', 'um', 'uma', 'de', 'que', 'e', 'para', 'com', 'como', 'é', 'não', 'faça', 'crie', 'quero', 'meu'], chars: /[ãõ]/ },
  tr: { name: 'турецкий (Türkçe)', words: ['bir', 've', 'bu', 'için', 'ile', 'nasıl', 'yap', 'oluştur', 'lütfen', 'ben', 'benim'], chars: /[ğışİ]/ },
  az: { name: 'азербайджанский (azərbaycanca)', words: ['bir', 'və', 'bu', 'üçün', 'ilə', 'necə', 'yarat', 'et', 'zəhmət', 'mən', 'mənim', 'olan', 'də', 'da'], chars: /[əƏ]/ },
};

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

/** Best guess of the language of `text`, or null when there is nothing to go on (code, numbers, one word). */
export function detectLanguage(text: string): DetectedLanguage | null {
  // fenced code and URLs say nothing about the language
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const cyr = count(clean, /[Ѐ-ӿ]/g);
  const geo = count(clean, /[Ⴀ-ჿ]/g);
  const cjk = count(clean, /[぀-ヿ一-鿿]/g);
  const kor = count(clean, /[가-힯]/g);
  const ara = count(clean, /[؀-ۿ]/g);
  const heb = count(clean, /[֐-׿]/g);
  const lat = count(clean, /[A-Za-zÀ-ɏ]/g);
  const total = cyr + geo + cjk + kor + ara + heb + lat;
  if (total < 3) return null;

  const biggest = Math.max(cyr, geo, cjk, kor, ara, heb, lat);
  if (biggest === geo) return { code: 'ka', name: 'грузинский (ქართული)' };
  if (biggest === cjk) return { code: 'zh', name: 'китайский/японский — тот же язык, что у пользователя' };
  if (biggest === kor) return { code: 'ko', name: 'корейский (한국어)' };
  if (biggest === ara) return { code: 'ar', name: 'арабский (العربية)' };
  if (biggest === heb) return { code: 'he', name: 'иврит (עברית)' };
  if (biggest === cyr) {
    if (/[іїєґ]/i.test(clean) && !/[ыэъ]/i.test(clean)) return { code: 'uk', name: 'украинский (українська)' };
    return { code: 'ru', name: 'русский' };
  }

  // Latin script: score languages by their common words and characteristic letters
  const words = clean.toLowerCase().match(/[a-zÀ-ɏ'’]+/g) ?? [];
  let best: { code: string; score: number } | null = null;
  for (const [code, def] of Object.entries(STOPWORDS)) {
    const set = new Set(def.words);
    let score = words.filter((w) => set.has(w)).length;
    if (def.chars) score += count(clean.toLowerCase(), new RegExp(def.chars.source, 'g')) * 1.5;
    if (!best || score > best.score) best = { code, score };
  }
  if (!best || best.score < 1) return { code: 'en', name: STOPWORDS.en.name };
  return { code: best.code, name: STOPWORDS[best.code].name };
}

/**
 * System-prompt paragraph: reply in the user's language. The language of the
 * current message wins; a message with nothing to detect falls back to the
 * language of the previous user messages.
 */
export function languageRule(prompt: string, previousUserMessages: string[] = []): string {
  let found = detectLanguage(prompt);
  for (let i = previousUserMessages.length - 1; !found && i >= 0; i--) found = detectLanguage(previousUserMessages[i]);
  const which = found ? `Язык сообщения пользователя: ${found.name}. ` : '';
  return (
    `ЯЗЫК ОТВЕТА: ${which}Отвечай на том же языке, на котором написано сообщение пользователя — и пояснения, и итог, и вопросы. ` +
    'Если пользователь сменил язык, меняй и ты. Код, имена файлов, команды и идентификаторы не переводи. ' +
    'Тексты, которые ты пишешь В ФАЙЛЫ (интерфейс, сайт, документация), делай на языке, который просит пользователь или который уже используется в проекте; если не сказано — на языке сообщения пользователя.'
  );
}

type NoticeKey = 'noProject' | 'noFolder' | 'emptyAnswer' | 'stepLimit' | 'switched' | 'noTools' | 'loopStopped' | 'allLimits';

const NOTICES: Record<string, Record<NoticeKey, string>> = {
  ru: {
    noProject: 'Сначала выберите проект в обозревателе файлов.',
    noFolder: 'Папка проекта не найдена.',
    emptyAnswer: 'Модель не вернула текста ответа. Отправьте сообщение ещё раз.',
    stepLimit: 'Готово. Достигнут лимит шагов работы с файлами — если нужно продолжить, уточните запрос.',
    switched: '🔄 Смена модели: {from} → {model}',
    loopStopped: 'Готово — изменения ниже.',
    allLimits: '⛔ Лимиты исчерпаны у всех доступных провайдеров ({tried}), а локальной модели нет. Подождите сброса лимитов, добавьте ключ другого провайдера (Настройки → Модели) или скачайте локальную модель в разделе «Модели».',
    noTools: '⚠️ Модель {model} не поддерживает инструменты: она не может сама записывать файлы, запускать команды и сервисы, открывать превью и управлять Otto. Ответ будет только текстом. Для работы с проектом выберите модель с поддержкой инструментов (например qwen2.5-coder, qwen3-coder, llama3.1 или облачную).',
  },
  en: {
    noProject: 'Select a project in the file explorer first.',
    noFolder: 'The project folder was not found.',
    emptyAnswer: 'The model returned no text. Send the message again.',
    stepLimit: 'Done. The limit of file-work steps was reached — if you need more, refine the request.',
    switched: '🔄 Model switch: {from} → {model}',
    loopStopped: 'Done — the changes are below.',
    allLimits: '⛔ The limits ran out at every available provider ({tried}), and there is no local model. Wait for the limits to reset, add another provider\'s key (Settings → Models) or download a local model in Models.',
    noTools: '⚠️ The model {model} does not support tools: it cannot write files, run commands or services, open the Preview or operate Otto by itself. It will answer with text only. To work on the project, pick a model with tool support (e.g. qwen2.5-coder, qwen3-coder, llama3.1 or a cloud model).',
  },
  az: {
    noProject: 'Əvvəlcə fayl bələdçisində layihə seçin.',
    noFolder: 'Layihə qovluğu tapılmadı.',
    emptyAnswer: 'Model mətn qaytarmadı. Mesajı yenidən göndərin.',
    stepLimit: 'Hazırdır. Fayllarla iş addımlarının limitinə çatıldı — davam etmək lazımdırsa, sorğunu dəqiqləşdirin.',
    switched: '🔄 Model dəyişikliyi: {from} → {model}',
    loopStopped: 'Hazırdır — dəyişikliklər aşağıdadır.',
    allLimits: '⛔ Bütün mövcud provayderlərdə limit bitdi ({tried}), lokal model də yoxdur. Limitlərin sıfırlanmasını gözləyin, başqa provayderin açarını əlavə edin (Parametrlər → Modellər) və ya «Modellər» bölməsində lokal model yükləyin.',
    noTools: '⚠️ {model} modeli alətləri dəstəkləmir: faylları yaza, əmrləri və xidmətləri işə sala, önizləməni aça və Otto-nu idarə edə bilmir. Cavab yalnız mətn olacaq. Layihə üzərində işləmək üçün alət dəstəyi olan model seçin (məs. qwen2.5-coder, qwen3-coder, llama3.1 və ya bulud modeli).',
  },
  ka: {
    noProject: 'ჯერ აირჩიეთ პროექტი ფაილების მკვლევარში.',
    noFolder: 'პროექტის საქაღალდე ვერ მოიძებნა.',
    emptyAnswer: 'მოდელმა ტექსტი არ დააბრუნა. გაგზავნეთ შეტყობინება ხელახლა.',
    stepLimit: 'მზადაა. ფაილებთან მუშაობის ნაბიჯების ლიმიტს მიაღწია — გასაგრძელებლად დააზუსტეთ მოთხოვნა.',
    switched: '🔄 მოდელის შეცვლა: {from} → {model}',
    loopStopped: 'მზადაა — ცვლილებები ქვემოთაა.',
    allLimits: '⛔ ლიმიტები ამოიწურა ყველა ხელმისაწვდომ პროვაიდერთან ({tried}), ლოკალური მოდელი კი არ არის. დაელოდეთ ლიმიტების განახლებას, დაამატეთ სხვა პროვაიდერის გასაღები (პარამეტრები → მოდელები) ან ჩამოტვირთეთ ლოკალური მოდელი.',
    noTools: '⚠️ მოდელი {model} არ უჭერს მხარს ინსტრუმენტებს: ვერ ჩაწერს ფაილებს, ვერ გაუშვებს ბრძანებებს და სერვისებს, ვერ გახსნის პრევიუს და ვერ მართავს Otto-ს. პასუხი მხოლოდ ტექსტი იქნება. პროექტზე სამუშაოდ აირჩიეთ ინსტრუმენტების მხარდაჭერის მქონე მოდელი (მაგ. qwen2.5-coder, qwen3-coder, llama3.1 ან ღრუბლოვანი).',
  },
  it: {
    noProject: 'Seleziona prima un progetto nell’esplora file.',
    noFolder: 'Cartella del progetto non trovata.',
    emptyAnswer: 'Il modello non ha restituito testo. Invia di nuovo il messaggio.',
    stepLimit: 'Fatto. Raggiunto il limite di passaggi di lavoro sui file: per continuare, precisa la richiesta.',
    switched: '🔄 Cambio modello: {from} → {model}',
    loopStopped: 'Fatto — le modifiche sono qui sotto.',
    allLimits: '⛔ I limiti sono esauriti presso tutti i provider disponibili ({tried}) e non c\'è un modello locale. Attendi il ripristino, aggiungi la chiave di un altro provider (Impostazioni → Modelli) o scarica un modello locale in Modelli.',
    noTools: '⚠️ Il modello {model} non supporta gli strumenti: non può scrivere file, avviare comandi o servizi, aprire l’anteprima né usare Otto da solo. Risponderà solo con testo. Per lavorare sul progetto scegli un modello con strumenti (es. qwen2.5-coder, qwen3-coder, llama3.1 o un modello cloud).',
  },
  es: {
    noProject: 'Primero selecciona un proyecto en el explorador de archivos.',
    noFolder: 'No se encontró la carpeta del proyecto.',
    emptyAnswer: 'El modelo no devolvió texto. Envía el mensaje de nuevo.',
    stepLimit: 'Listo. Se alcanzó el límite de pasos de trabajo con archivos: si necesitas más, aclara la petición.',
    switched: '🔄 Cambio de modelo: {from} → {model}',
    loopStopped: 'Listo — los cambios están abajo.',
    allLimits: '⛔ Se agotaron los límites en todos los proveedores disponibles ({tried}) y no hay modelo local. Espera a que se restablezcan, añade la clave de otro proveedor (Ajustes → Modelos) o descarga un modelo local en Modelos.',
    noTools: '⚠️ El modelo {model} no admite herramientas: no puede escribir archivos, ejecutar comandos o servicios, abrir la vista previa ni manejar Otto por sí mismo. Responderá solo con texto. Para trabajar en el proyecto elige un modelo con herramientas (p. ej. qwen2.5-coder, qwen3-coder, llama3.1 o uno en la nube).',
  },
};

/** System notice in the language of the user's message (Russian when unknown, as before). */
export function notice(key: NoticeKey, prompt: string, vars: Record<string, string> = {}): string {
  const code = detectLanguage(prompt)?.code;
  const table = NOTICES[code === 'uk' ? 'ru' : code && NOTICES[code] ? code : code ? 'en' : 'ru'];
  return table[key].replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? '');
}
