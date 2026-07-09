import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { MongoClient } from 'mongodb';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const { TELEGRAM_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, API_SECRET, MONGODB_URI, PORT = 3000 } = process.env;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Часовой пояс пользователя (Тель-Авив) и «ночная» граница дня ──
// Дмитрий — «сова»: ночь до DAY_START_HOUR по Тель-Авиву считается ещё текущим днём.
// Поэтому в 3:00 «завтра» = ближайшее утро, а не следующая календарная дата. Меняй DAY_START_HOUR при желании.
const USER_TZ = 'Asia/Jerusalem';
const DAY_START_HOUR = 5;
function userTodayParts() {
  const shifted = new Date(Date.now() - DAY_START_HOUR * 3600 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: USER_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(shifted);
  const get = t => parts.find(p => p.type === t)?.value;
  return { y: +get('year'), m: +get('month'), d: +get('day') };
}
function userDateKey() { const t = userTodayParts(); return `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`; }
function userTodayLine() {
  const shifted = new Date(Date.now() - DAY_START_HOUR * 3600 * 1000);
  return new Intl.DateTimeFormat('ru-RU', { timeZone: USER_TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(shifted);
}

// ── MONGODB ──
let mongoCol = null;
let mongoFiles = null; // отдельная коллекция для нот/файлов (чтобы не раздувать основной документ)
let timelogCol = null; // отдельная коллекция для тайм-трекинга (Clockify)

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI не задан — данные не сохранятся'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db('identity-map');
    mongoCol = db.collection('data');
    mongoFiles = db.collection('files');
    timelogCol = db.collection('timelog'); // записи Clockify — отдельно, их десятки тысяч
    console.log('✓ MongoDB подключён');
  } catch(e) {
    console.error('MongoDB ошибка подключения:', e.message);
  }
}

const EMPTY_UI_STATE = () => ({ doneTasks: [], taskCols: {}, shopDone: [], shopCols: {}, published: {}, deleted: [] });
const EMPTY_FINANCE = () => ({ services: [], recurring: [], debts: [] });
const EMPTY_DB = () => ({ library: [], cards: [], events: [], beliefs: [], intro: null, birthdays: [], notified: [], appointments: [], works: [], uiState: EMPTY_UI_STATE(), finance: EMPTY_FINANCE(), ownerChatId: null, pendingCat: {} });

async function load() {
  if (!mongoCol) return EMPTY_DB();
  try {
    const doc = await mongoCol.findOne({ _id: 'main' });
    if (!doc) return EMPTY_DB();
    const { _id, ...data } = doc;
    return { library:[], cards:[], events:[], beliefs:[], intro:null, birthdays:[], notified:[], appointments:[], works:[], uiState: EMPTY_UI_STATE(), finance: EMPTY_FINANCE(), ownerChatId: null, pendingCat: {}, ...data };
  } catch(e) {
    console.error('Load error:', e.message);
    return EMPTY_DB();
  }
}

async function save(d) {
  d.updatedAt = new Date().toISOString();
  if (!mongoCol) return;
  try {
    await mongoCol.replaceOne({ _id: 'main' }, { _id: 'main', ...d }, { upsert: true });
  } catch(e) {
    console.error('Save error:', e.message);
  }
}

let DB = EMPTY_DB();

async function tgApi(method, payload) {
  try {
    const r = await fetch(`${TG}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    return await r.json();
  } catch(e) { console.error('tgApi', method, e.message); }
}

async function tgSend(chatId, text, extra = {}) {
  try {
    await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
    });
  } catch(e) { console.error('tgSend error:', e); }
}

async function downloadFile(fileId) {
  const r = await fetch(`${TG}/getFile?file_id=${fileId}`);
  const j = await r.json();
  const fp = j.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fp}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filePath: fp };
}

// сохраняем присланное в Telegram фото в коллекцию files, возвращаем id
async function storeTelegramPhoto(photoArray) {
  if (!mongoFiles || !photoArray?.length) return null;
  try {
    const best = photoArray[photoArray.length - 1]; // самый крупный размер
    const { buffer } = await downloadFile(best.file_id);
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const data = 'data:image/jpeg;base64,' + buffer.toString('base64');
    await mongoFiles.insertOne({ _id: id, mime: 'image/jpeg', name: 'photo.jpg', data, createdAt: new Date().toISOString() });
    return id;
  } catch (e) { console.error('storeTelegramPhoto:', e.message); return null; }
}

// ── Альбомы (media group): несколько фото в одном сообщении приходят как отдельные апдейты ──
const mediaGroups = {}; // media_group_id -> { chatId, fileIds:[], caption, timer }

async function processMediaGroup(mgid) {
  const buf = mediaGroups[mgid];
  if (!buf) return;
  delete mediaGroups[mgid];
  const { chatId, fileIds, caption } = buf;
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric', timeZone: USER_TZ });
  const timeStr = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone: USER_TZ });
  // сохраняем все фото альбома
  const images = [];
  for (const fid of fileIds) {
    try {
      const { buffer } = await downloadFile(fid);
      const id = Date.now() + Math.floor(Math.random() * 100000);
      const data = 'data:image/jpeg;base64,' + buffer.toString('base64');
      if (mongoFiles) await mongoFiles.insertOne({ _id: id, mime: 'image/jpeg', name: 'photo.jpg', data, createdAt: new Date().toISOString() });
      images.push({ id, mime: 'image/jpeg' });
    } catch(e) { console.error('media group photo:', e.message); }
  }
  if (!caption) {
    DB.library.unshift({ id: Date.now(), date: dateStr, time: timeStr, sourceType: 'photo', rubric: 'media', artType: '', text: '', title: '📷 Фото ' + dateStr, body: '', images, analyzedAt: new Date().toISOString() });
    save(DB);
    await tgSend(chatId, `📷 ${images.length} фото сохранено в «Искусство» одной заметкой.`);
    return;
  }
  // с подписью — анализируем, всё в ОДНУ запись
  try {
    const result = await analyze(caption, '');
    const rubric = result.rubric || 'thought';
    const items = result.items || [];
    const dateShort = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });
    const entry = {
      id: Date.now(), date: dateStr, time: timeStr, sourceType: 'photo', rubric, text: caption,
      title: items[0]?.title || caption.slice(0, 60), body: items[0]?.body || '',
      tags: [...new Set(items.flatMap(i => i.tags || []))],
      artType: rubric === 'media' ? (result.artType || '') : undefined,
      workTitle: rubric === 'media' ? (result.workTitle || '') : undefined,
      images, analyzedAt: new Date().toISOString()
    };
    DB.library.unshift(entry);
    items.forEach(item => DB.cards.unshift({ ...item, rubric, date: dateShort, libId: entry.id, addedAt: new Date().toISOString() }));
    save(DB);
    await tgSend(chatId, `${R_EMOJI[rubric]||'•'} <b>${R_LABEL[rubric]||rubric}</b> · ${images.length} фото\n<b>${entry.title}</b>\n<i>${(entry.body||'').slice(0,120)}</i>`);
  } catch(e) {
    console.error('media group analyze:', e);
    DB.library.unshift({ id: Date.now(), date: dateStr, time: timeStr, sourceType: 'photo', rubric: 'media', text: caption, title: caption.slice(0, 60), images, analyzedAt: null });
    save(DB);
    await tgSend(chatId, `📷 ${images.length} фото сохранены, текст без анализа.`);
  }
}

async function transcribe(buffer, filePath) {
  if (!OPENAI_API_KEY) return '[голосовое — нет OpenAI ключа]';
  const form = new FormData();
  const ext = filePath.split('.').pop() || 'ogg';
  form.append('file', buffer, { filename: `audio.${ext}`, contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'ru');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form
  });
  const j = await r.json();
  return j.text || '[не удалось расшифровать]';
}

const SYSTEM = `Ты анализируешь личные сообщения человека. Определи рубрику и извлеки данные.

Отвечай ТОЛЬКО валидным JSON без markdown:
{
  "rubric": "idea|dream|task|thought|notebook|birthday|event|shopping|media|work|money|quote",
  "split": false,
  "birthdayName": "",
  "birthdayDay": null,
  "birthdayMonth": null,
  "birthdayYear": null,
  "toastFor": "",
  "giftFor": "",
  "eventName": "",
  "eventDay": null,
  "eventMonth": null,
  "eventYear": null,
  "eventTime": "",
  "artType": "",
  "workTitle": "",
  "noteKind": "",
  "moneyKind": "",
  "debtWho": "",
  "debtAmount": null,
  "debtCurrency": "",
  "items": [{
    "title": "название до 70 символов",
    "body": "суть 1-3 предложения СВОИМИ СЛОВАМИ — ОБЯЗАТЕЛЬНО, никогда не оставляй пустым",
    "type": "belief|question|shifting|tension|abandoned",
    "domain": "love|mind|society|self|work|other",
    "was": "",
    "now": "",
    "emotion": "",
    "priority": "",
    "tags": ["2-4 тега ОБЯЗАТЕЛЬНО — тематические слова из текста"]
  }]
}

ВАЖНО: body и tags заполняй ВСЕГДА, для любой рубрики. body — краткая выжимка, по которой человек мгновенно поймёт о чём запись.

ПОЛЕ split: поставь true ТОЛЬКО если в сообщении есть явная цифра или числительное указывающее количество задач — например "3 задачи", "две вещи", "4 дела", "пять штук". Если конкретного числа нет — split всегда false. "Несколько", "пара" без цифры — НЕ считается, split=false.

ИСКЛЮЧЕНИЕ для SHOPPING: если рубрика shopping и в сообщении несколько разных вещей (списком, по строкам/абзацам, через запятую, или несколько "купить …") — ОБЯЗАТЕЛЬНО раздели на отдельные items, по одной вещи в каждом items[].title, и поставь split=true. Одна вещь — один item. Пример: "купить вилку\nсредство от ржавчины\nграфин с фильтром\nножнички" → 4 отдельных items.

РУБРИКИ:

TASK (задача) — действие/дело которое надо сделать: позвонить, отправить, починить, сходить, записаться, планирую. priority: high=срочно, medium=обычное, low=когда-нибудь. НО: если это покупка вещи/продукта — это SHOPPING, не task.

SHOPPING (покупки) — нужно КУПИТЬ вещь/продукт/товар: "купить молоко", "нужен новый зонт", "заказать наушники", "в магазин: хлеб, яйца". Каждая вещь = отдельный items[].title (см. правило split выше — список разбивай по позициям). priority: high если "важное/серьёзное/дорогое", иначе medium.

EVENT (мероприятие) — событие/встреча с датой или днём: митинг, созвон, звонок, встреча, концерт, приём, поездка, дедлайн, выставка, "у врача в среду", "созвон в понедельник в 15:00". Заполни eventName, eventDay, eventMonth, eventYear, eventTime ("19:00" если есть). items[0].title = название.
ОТНОСИТЕЛЬНЫЕ ДАТЫ: используй "СЕГОДНЯ" (дано ниже) чтобы вычислить конкретную дату. "в понедельник/вторник/…" без даты = БЛИЖАЙШИЙ будущий такой день (если сегодня среда и сказано "в понедельник" — это понедельник следующей недели). "завтра", "послезавтра", "через неделю", "в эти выходные" — тоже вычисли eventDay/eventMonth/eventYear. Год бери ближайший будущий.

IDEA — философская мысль, убеждение о жизни, наблюдение о мире. Требует type и domain.

THOUGHT — рассуждение вслух, незавершённая мысль, вопрос к себе. НЕ задача и НЕ идея.

NOTEBOOK (не забыть) — факт, пароль, адрес, число, информация которую надо помнить: "ключи лежат...", "пароль от...", "код от...", "адрес...", "не забыть что...". Конкретная информация без действия.

BIRTHDAY (день рождения) — если упоминается дата ДР человека → заполни birthdayName, birthdayDay, birthdayMonth, birthdayYear (если есть). Если это тост/поздравление → заполни toastFor + текст в items[0].body. Если идея подарка → заполни giftFor + текст в items[0].body.

DREAM — сон, что приснилось.

MEDIA — про искусство: фильм/кино, книга/литература, картина/живопись, музыка/песня/слова песни, актёр, подкаст, статья, ссылка (в т.ч. Instagram/Reels/YouTube с комментарием об искусстве). Заполни artType ("film"=фильм/кино, "book"=книга/литература, "painting"=картина/живопись, "music"=музыка/песня/текст песни, "other"=прочее) и workTitle (название фильма/книги/картины/песни, если упоминается). Если это группа/трек/плейлист, который пользователь хочет НЕ ЗАБЫТЬ включать (под вайб, тусовку, настроение — «классика», «включить на вечеринке») — поставь noteKind:"vibe".

WORK (работа) — рабочая заметка: задача по работе, идея как организовать работу, рабочее наблюдение, рабочий проект. НЕ личные дела (это task) и НЕ встречи/митинги с датой (это event).

MONEY (деньги) — займы, долги, обязательные платежи. Заполни moneyKind, debtWho, debtAmount (число или null), debtCurrency ("₽","$","€","₪" — определи из контекста, по умолчанию "₪"):
- «занял У Клавы 2000 рублей», «взял в долг у X» → я должен → moneyKind:"debt_i_owe", debtWho:"Клава"
- «занял КлавЕ / одолжил X / дал в долг X» → мне должны → moneyKind:"debt_owed_to_me"
- «X мне должен N» → "debt_owed_to_me"; «я должен X N» → "debt_i_owe"
- «надо/должен оплатить X» (Битуах Леуми, штраф, счёт, налог) → moneyKind:"payment_due", debtWho — кому платить
Будь внимателен к падежу: «занял у X» = я взял (я должен), «занял X-у» = я дал (мне должны).

QUOTE — пересланный чужой контент + комментарий.

Если непонятно — thought.`;

async function analyze(text, context = '') {
  const msg = context ? `${context}\n\nТекст:\n${text}` : text;
  // «логическое сегодня» пользователя (Тель-Авив, ночь до 5:00 — ещё этот день) для относительных дат
  const todayLine = userTodayLine();
  const systemDated = `${SYSTEM}\n\nСЕГОДНЯ: ${todayLine} (Тель-Авив; ночь до 5:00 считается ещё этим днём, т.к. пользователь не ложился). Для относительных дат («завтра» = ближайшее утро, «в понедельник», «через неделю») вычисляй ближайшую будущую дату от этого дня.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1500, system: systemDated, messages: [{ role: 'user', content: msg }] })
  });
  const data = await r.json();
  if (data.error) { console.error('Claude API error:', JSON.stringify(data.error)); }
  const raw = data.content?.map(c => c.text || '').join('') || '{}';
  console.log('Claude response rubric preview:', raw.slice(0, 150));
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch(e) { console.error('JSON parse error:', e.message, 'raw:', raw.slice(0, 200)); return { rubric: 'thought', items: [{ title: text.slice(0, 60), body: text }] }; }
}

const R_EMOJI = { idea:'🔥', dream:'🌙', task:'🎯', thought:'💭', notebook:'📌', birthday:'🎂', event:'📅', shopping:'🛒', work:'💼', money:'💰', resentment:'😤', admiration:'✨', quote:'💬', media:'🎨', context:'🌀' };
const R_LABEL = { idea:'Идея', dream:'Сон', task:'Задача', thought:'Мысль', notebook:'Не забыть', birthday:'День рождения', event:'Мероприятие', shopping:'Покупка', work:'Работа', money:'Деньги', resentment:'Обида', admiration:'Восхищение', quote:'Цитата', media:'Искусство', context:'Контекст' };

// ── /cat: явный выбор категорий кнопками для СЛЕДУЮЩЕГО сообщения ──
const CAT_LIST = [
  ['idea','🔥 Идея'],['thought','💭 Мысль'],['task','🎯 Задача'],
  ['shopping','🛒 Покупка'],['work','💼 Работа'],['money','💰 Деньги'],
  ['event','📅 Мероприятие'],['notebook','📌 Не забыть'],['dream','🌙 Сон'],
  ['birthday','🎂 ДР'],['media','🎨 Искусство'],['quote','💬 Цитата'],
  ['project','✍ Мой проект']
];
const CAT_TTL = 10 * 60 * 1000; // выбор действует 10 минут
function catKeyboard(sel) {
  const rows = [];
  for (let i = 0; i < CAT_LIST.length; i += 3)
    rows.push(CAT_LIST.slice(i, i + 3).map(([k, l]) => ({ text: (sel.includes(k) ? '✓ ' : '') + l, callback_data: 'cat:' + k })));
  rows.push([{ text: '✅ Готово', callback_data: 'cat:done' }, { text: '✖ Отмена', callback_data: 'cat:cancel' }]);
  return { inline_keyboard: rows };
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id, mid = cb.message?.message_id, data = cb.data || '';
  const ack = (t) => tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: t || '' });
  if (!chatId) return ack();
  DB.pendingCat = DB.pendingCat || {};
  const st = DB.pendingCat[chatId];
  // выбор конкретного проекта
  if (data.startsWith('prj:')) {
    if (!st) return ack('устарело — набери /cat заново');
    st.projectId = Number(data.slice(4)); st.armed = true; st.ts = Date.now(); save(DB);
    const w = (DB.works || []).find(x => x.id === st.projectId);
    const others = st.sel.filter(k => k !== 'project').map(k => R_LABEL[k] || k).join(', ');
    await tgApi('editMessageText', { chat_id: chatId, message_id: mid, parse_mode: 'HTML',
      text: `📂 Жду сообщение для: ✍ проект «<b>${w?.title || ''}</b>»${others ? ' + ' + others : ''}\n(действует 10 минут)` });
    return ack('жду сообщение');
  }
  if (!data.startsWith('cat:')) return ack();
  if (!st) return ack('устарело — набери /cat заново');
  const key = data.slice(4);
  if (key === 'cancel') {
    delete DB.pendingCat[chatId]; save(DB);
    await tgApi('editMessageText', { chat_id: chatId, message_id: mid, text: '✖ Отменено.' });
    return ack();
  }
  if (key === 'done') {
    if (!st.sel.length) return ack('ничего не выбрано');
    if (st.sel.includes('project')) {
      const projects = (DB.works || []).filter(w => w.type === 'project');
      if (projects.length === 1) st.projectId = projects[0].id;
      else if (projects.length > 1) {
        save(DB);
        await tgApi('editMessageText', { chat_id: chatId, message_id: mid, text: 'К какому проекту относится?',
          reply_markup: { inline_keyboard: projects.slice(0, 10).map(w => [{ text: '✍ ' + w.title, callback_data: 'prj:' + w.id }]) } });
        return ack();
      }
    }
    st.armed = true; st.ts = Date.now(); save(DB);
    const labels = st.sel.map(k => CAT_LIST.find(c => c[0] === k)?.[1] || k).join(', ');
    await tgApi('editMessageText', { chat_id: chatId, message_id: mid, parse_mode: 'HTML',
      text: `📂 Жду сообщение для: <b>${labels}</b>\n(текст, голос или пересылка · действует 10 минут)` });
    return ack('жду сообщение');
  }
  // переключение категории
  st.sel = st.sel.includes(key) ? st.sel.filter(x => x !== key) : [...st.sel, key];
  st.ts = Date.now(); save(DB);
  await tgApi('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: catKeyboard(st.sel) });
  return ack();
}

// Склейка «комментарий → ссылка» (Instagram шлёт их двумя сообщениями подряд)
const lastNote = {}; // chatId -> { libId, ts, urlOnly }
const MERGE_WINDOW_MS = 90 * 1000;
const isUrlOnly = (t) => /^\s*(?:https?:\/\/\S+\s*)+$/.test(t || '');

async function handle(msg) {
  const chatId = msg.chat.id;
  if (DB.ownerChatId !== chatId) DB.ownerChatId = chatId; // запоминаем чат для /api/cron-напоминаний
  const ts = new Date(msg.date * 1000);
  const dateStr = ts.toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric', timeZone: USER_TZ });
  const timeStr = ts.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit', timeZone: USER_TZ });

  let text = '', sourceType = 'text', context = '', photoFileId = null;

  // Альбом (несколько фото одним сообщением) — копим по media_group_id и обрабатываем одной заметкой
  if (msg.media_group_id && msg.photo) {
    const mgid = msg.media_group_id;
    const best = msg.photo[msg.photo.length - 1];
    const buf = mediaGroups[mgid] || (mediaGroups[mgid] = { chatId, fileIds: [], caption: '' });
    buf.fileIds.push(best.file_id);
    if (msg.caption) buf.caption = msg.caption;
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => { processMediaGroup(mgid).catch(e => console.error('processMediaGroup:', e)); }, 1800);
    return;
  }

  if (msg.text?.startsWith('/')) {
    const cmd = msg.text.split(' ')[0];
    if (cmd === '/start') {
      await tgSend(chatId, `👋 <b>Привет! Я твой личный дневник.</b>\n\nПросто пиши или диктуй — разберу и сохраню в нужную рубрику.\n\n🔥 Идеи & убеждения\n🌙 Сны\n🎯 Задачи\n📌 Не забыть\n🎂 Дни рождения\n📅 Мероприятия (напомню за 3/1/0 дн)\n🛒 Покупки\n💭 Мысли вслух\n🎨 Искусство (кино, книги, живопись)\n💬 Чужое + комментарий\n\n<b>Форматы:</b> текст, голосовое 🎙, пересланное с комментарием\n\n📂 /cat — выбрать категорию кнопками, если хочешь положить следующее сообщение точно в нужное место (например, заметку о своём проекте)\n\n/stats /last /tasks /events /dreams`);
      return;
    }
    if (cmd === '/stats') {
      const counts = {};
      DB.library.forEach(e => counts[e.rubric] = (counts[e.rubric]||0)+1);
      const lines = Object.entries(R_EMOJI).map(([k,e]) => `${e} ${R_LABEL[k]}: ${counts[k]||0}`).join('\n');
      await tgSend(chatId, `📊 <b>Дневник:</b>\n${lines}\n\n<b>Всего:</b> ${DB.library.length}`);
      return;
    }
    if (cmd === '/last') {
      const last = DB.library.slice(0, 6);
      if (!last.length) { await tgSend(chatId, 'Пока пусто.'); return; }
      const lines = last.map(e => `${R_EMOJI[e.rubric]||'•'} <b>${e.title||e.text?.slice(0,40)||'—'}</b> · ${e.date}`).join('\n');
      await tgSend(chatId, `🗂 <b>Последние:</b>\n\n${lines}`);
      return;
    }
    if (cmd === '/tasks') {
      const tasks = DB.library.filter(e => e.rubric === 'task').slice(0, 10);
      if (!tasks.length) { await tgSend(chatId, 'Задач пока нет.'); return; }
      const hi = tasks.filter(t => t.priority === 'high').map(t => `🔴 ${t.title}`).join('\n');
      const md = tasks.filter(t => t.priority !== 'high').map(t => `⚪ ${t.title}`).join('\n');
      await tgSend(chatId, `<b>Задачи:</b>\n${hi ? hi+'\n' : ''}${md}`);
      return;
    }
    if (cmd === '/dreams') {
      const dreams = DB.library.filter(e => e.rubric === 'dream').slice(0, 5);
      if (!dreams.length) { await tgSend(chatId, 'Снов пока нет.'); return; }
      const lines = dreams.map(e => `🌙 <b>${e.title||'Сон'}</b>\n${e.date}\n<i>${e.body?.slice(0,100)||''}...</i>`).join('\n\n');
      await tgSend(chatId, lines);
      return;
    }
    if (cmd === '/cat') {
      DB.pendingCat = DB.pendingCat || {};
      DB.pendingCat[chatId] = { sel: [], ts: Date.now(), armed: false };
      save(DB);
      await tgSend(chatId, '📂 <b>Куда положить следующее сообщение?</b>\nВыбери одну или несколько категорий и нажми «Готово».', { reply_markup: catKeyboard([]) });
      return;
    }
    if (cmd === '/events') {
      const all = (DB.appointments||[]).filter(a => !a.done).map(a => ({ ...a, days: apptDaysUntil(a) }));
      const upcoming = all.filter(a => a.days >= 0).sort((x,y) => x.days - y.days).slice(0, 10);
      const missed = all.filter(a => a.days < 0).sort((x,y) => y.days - x.days).slice(0, 5);
      if (!upcoming.length && !missed.length) { await tgSend(chatId, 'Мероприятий пока нет. Напиши «концерт 25 июля в 19:00».'); return; }
      let out = '';
      if (upcoming.length) {
        out += '<b>Ближайшие:</b>\n' + upcoming.map(a => {
          const when = `${a.day} ${MONTHS_RU[a.month-1]}${a.time?', '+a.time:''}`;
          const left = a.days===0?'сегодня':a.days===1?'завтра':`через ${a.days} дн`;
          return `📅 <b>${a.title}</b> — ${when} <i>(${left})</i>`;
        }).join('\n');
      }
      if (missed.length) {
        out += (out?'\n\n':'') + '<b>Пропущено (закрой в карте):</b>\n' + missed.map(a =>
          `⚠️ ${a.title} — ${a.day} ${MONTHS_RU[a.month-1]} <i>(${-a.days} дн назад)</i>`).join('\n');
      }
      await tgSend(chatId, out);
      return;
    }
    return;
  }

  if (msg.voice || msg.audio) {
    // Голосовое или пересланное голосовое — всегда транскрибируем
    await tgSend(chatId, '🎙 Транскрибирую...');
    const fileId = (msg.voice || msg.audio).file_id;
    const { buffer, filePath } = await downloadFile(fileId);
    text = await transcribe(buffer, filePath);
    sourceType = 'voice';
    context = 'Голосовая заметка, мысли вслух.';
    if (msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
      const from = msg.forward_from_chat?.title || msg.forward_from?.first_name || msg.forward_sender_name || 'неизвестно';
      sourceType = 'forward';
      context = `Пересланное голосовое от: "${from}"`;
    }
  } else if (msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
    const from = msg.forward_from_chat?.title || msg.forward_from?.first_name || msg.forward_sender_name || 'неизвестно';
    sourceType = 'forward';
    context = `Человек переслал контент из: "${from}"`;
    if (msg.caption) context += `\nЕго комментарий к пересланному: "${msg.caption}"`;
    text = msg.text || msg.caption || '';
  } else if (msg.photo) {
    text = msg.caption || '';
    sourceType = 'photo';
    photoFileId = await storeTelegramPhoto(msg.photo);
    if (!text) {
      // Фото без подписи — сохраняем как запись в «Искусство» с прикреплённой картинкой, без Claude
      const entry = {
        id: Date.now(), date: dateStr, time: timeStr,
        sourceType: 'photo', rubric: 'media', artType: '',
        text: '', title: '📷 Фото ' + dateStr, body: '',
        images: photoFileId ? [{ id: photoFileId, mime: 'image/jpeg' }] : [],
        analyzedAt: new Date().toISOString()
      };
      DB.library.unshift(entry); save(DB);
      await tgSend(chatId, photoFileId ? '📷 Фото сохранено в «Искусство».' : '📷 Фото получено (хранилище недоступно).');
      return;
    }
  } else if (msg.text) {
    text = msg.text;
  } else return;

  if (!text.trim()) return;

  // Проверяем напоминания о ДР и мероприятиях при каждом сообщении
  checkBirthdayReminders(chatId).catch(()=>{});
  checkEventReminders(chatId).catch(()=>{});

  // ── Склейка сообщений, отправленных подряд (комментарий + ссылка = ОДНА заметка) ──
  const prevNote = lastNote[chatId];
  const incomingUrlOnly = isUrlOnly(text);
  if (prevNote && Date.now() - prevNote.ts < MERGE_WINDOW_MS) {
    const entry = DB.library.find(e => e.id === prevNote.libId);
    if (entry) {
      if (incomingUrlOnly) {
        // пришла голая ссылка после текста → прикрепляем к предыдущей заметке
        const urls = text.match(/https?:\/\/\S+/g) || [];
        entry.mediaUrls = [...new Set([...(entry.mediaUrls || []), ...urls])];
        entry.text = (entry.text || '').trim() + '\n' + text.trim();
        save(DB);
        lastNote[chatId] = { libId: entry.id, ts: Date.now(), urlOnly: prevNote.urlOnly };
        await tgSend(chatId, `🔗 Ссылка прикреплена к заметке «${entry.title || '...'}»`);
        return;
      }
      if (prevNote.urlOnly) {
        // пришёл комментарий после голой ссылки → объединяем и переанализируем
        const combined = text.trim() + '\n' + (entry.text || '').trim();
        try {
          const r2 = await analyze(combined, context);
          const it2 = (r2.items || [])[0] || {};
          entry.rubric = r2.rubric || entry.rubric;
          entry.title = it2.title || entry.title;
          entry.body = it2.body || entry.body;
          entry.tags = [...new Set((r2.items || []).flatMap(i => i.tags || []))];
          if (entry.rubric === 'media') {
            entry.artType = r2.artType || entry.artType || '';
            entry.workTitle = r2.workTitle || entry.workTitle || '';
            entry.noteKind = r2.noteKind || entry.noteKind || '';
          }
        } catch (e) { console.error('merge re-analyze:', e.message); }
        entry.text = combined;
        entry.analyzedAt = new Date().toISOString();
        save(DB);
        lastNote[chatId] = { libId: entry.id, ts: Date.now(), urlOnly: false };
        await tgSend(chatId, `📝 Комментарий объединён со ссылкой:\n<b>${entry.title || ''}</b>`);
        return;
      }
    }
  }

  // ── применяем выбор /cat: этот текст/голос идёт в явно выбранные категории ──
  let forcedSel = null, forcedPrimary = null, forcedExtras = [], forcedProjectId = null;
  const pc = (DB.pendingCat || {})[chatId];
  if (pc && pc.armed) {
    if (Date.now() - pc.ts < CAT_TTL) {
      forcedSel = pc.sel; forcedProjectId = pc.projectId || null;
      forcedPrimary = forcedSel.includes('project') ? 'media' : forcedSel[0];
      forcedExtras = forcedSel.filter(k => k !== 'project' && k !== forcedPrimary);
      context = (context ? context + '\n' : '') + `ВАЖНО: пользователь вручную выбрал рубрику "${forcedPrimary}"${forcedSel.includes('project') ? ' (это заметка о его СОБСТВЕННОМ творческом проекте — истории/сценарии)' : ''} — поставь rubric именно её и заполни её поля.`;
    }
    delete DB.pendingCat[chatId];
  }

  await tgSend(chatId, '⏳ Анализирую...');

  try {
    const result = await analyze(text, context);
    if (forcedPrimary) { result.rubric = forcedPrimary; if (forcedSel.includes('project')) result.artType = 'project'; }
    const rubric = result.rubric || 'thought';
    const items = result.items || [];

    // ── BIRTHDAY рубрика — отдельная обработка ──
    if (rubric === 'birthday') {
      let reply = '';
      if (result.birthdayName && result.birthdayDay && result.birthdayMonth) {
        // Добавляем/обновляем день рождения
        const existing = DB.birthdays.find(b => b.name.toLowerCase() === result.birthdayName.toLowerCase());
        if (existing) {
          existing.day = result.birthdayDay;
          existing.month = result.birthdayMonth;
          if (result.birthdayYear) existing.year = result.birthdayYear;
        } else {
          DB.birthdays.push({ id: Date.now(), name: result.birthdayName, day: result.birthdayDay, month: result.birthdayMonth, year: result.birthdayYear||null, toasts: [], gifts: [] });
        }
        const daysLeft = getDaysUntil(result.birthdayDay, result.birthdayMonth);
        reply += `🎂 День рождения <b>${result.birthdayName}</b> — ${result.birthdayDay} ${MONTHS_RU[result.birthdayMonth-1]}${result.birthdayYear?' '+result.birthdayYear:''}\n`;
        reply += daysLeft === 0 ? '🎉 Сегодня!' : daysLeft === 1 ? '⏰ Завтра!' : `⏰ Через ${daysLeft} дней`;
      }
      if (result.toastFor && items[0]?.body) {
        const person = DB.birthdays.find(b => b.name.toLowerCase().includes(result.toastFor.toLowerCase()));
        if (person) { person.toasts = person.toasts || []; person.toasts.push({ text: items[0].body, addedAt: new Date().toISOString() }); }
        reply += `\n🥂 Тост для ${result.toastFor} сохранён`;
      }
      if (result.giftFor && items[0]?.body) {
        const person = DB.birthdays.find(b => b.name.toLowerCase().includes(result.giftFor.toLowerCase()));
        if (person) { person.gifts = person.gifts || []; person.gifts.push({ text: items[0].body, addedAt: new Date().toISOString() }); }
        reply += `\n🎁 Идея подарка для ${result.giftFor} сохранена`;
      }
      // Всё попадает в библиотеку — определяем subtype
      const subtype = result.toastFor ? 'toast' : result.giftFor ? 'gift' : 'person';
      const linkedName = result.toastFor || result.giftFor || result.birthdayName || '';
      const bdayEntry = {
        id: Date.now(),
        date: dateStr, time: timeStr,
        sourceType, rubric: 'birthday', subtype, linkedName,
        text,
        title: subtype === 'person'
          ? `ДР: ${result.birthdayName||''} — ${result.birthdayDay||'?'} ${result.birthdayMonth ? MONTHS_RU[result.birthdayMonth-1] : ''}`
          : subtype === 'toast' ? `Тост для ${linkedName}` : `Подарок для ${linkedName}`,
        body: items[0]?.body || text.slice(0, 200),
        tags: items[0]?.tags || [],
        analyzedAt: new Date().toISOString()
      };
      DB.library.unshift(bdayEntry);
      save(DB);
      await tgSend(chatId, reply || '🎂 Сохранено');
      return;
    }

    // ── MONEY (долги / обязательные платежи) — отдельная обработка ──
    if (rubric === 'money' && (result.moneyKind || result.debtWho || result.debtAmount != null)) {
      DB.finance = DB.finance || EMPTY_FINANCE();
      DB.finance.debts = DB.finance.debts || [];
      const kind = ['debt_i_owe','debt_owed_to_me','payment_due'].includes(result.moneyKind) ? result.moneyKind : 'debt_i_owe';
      const debt = {
        id: Date.now(),
        who: result.debtWho || '',
        amount: result.debtAmount ?? null,
        currency: result.debtCurrency || '₪',
        direction: kind,
        date: dateStr,
        note: items[0]?.body || '',
        closed: false,
        createdAt: new Date().toISOString()
      };
      DB.finance.debts.push(debt);
      const amtStr = debt.amount != null ? ` ${debt.amount} ${debt.currency}` : '';
      const title = kind === 'payment_due' ? `Оплатить: ${debt.who}${amtStr}`
        : kind === 'debt_owed_to_me' ? `${debt.who} должен мне${amtStr}`
        : `Я должен ${debt.who}${amtStr}`;
      DB.library.unshift({
        id: Date.now() + 1, date: dateStr, time: timeStr,
        sourceType, rubric: 'money', text, title,
        body: items[0]?.body || '',
        tags: items[0]?.tags || [],
        // обязательный платёж полезно видеть и в «Не забыть» — карточка мультикатегориальная
        extraRubrics: [...new Set([...(kind === 'payment_due' ? ['notebook'] : []), ...forcedExtras])],
        debtId: debt.id,
        analyzedAt: new Date().toISOString()
      });
      save(DB);
      const msg = kind === 'payment_due'
        ? `📌 Обязательный платёж: <b>${debt.who}</b>${amtStr ? ` —${amtStr}` : ''}`
        : kind === 'debt_owed_to_me'
          ? `🤝 <b>${debt.who}</b> должен тебе<b>${amtStr || ' ?'}</b>`
          : `🤝 Ты должен <b>${debt.who}</b>:<b>${amtStr || ' ?'}</b>`;
      await tgSend(chatId, msg + '\n💰 Записано во вкладку «Деньги»');
      return;
    }

    // ── EVENT (мероприятие) — отдельная обработка ──
    if (rubric === 'event' && result.eventDay && result.eventMonth) {
      const appt = {
        id: Date.now(),
        title: result.eventName || items[0]?.title || text.slice(0, 60),
        day: result.eventDay, month: result.eventMonth,
        year: result.eventYear || inferEventYear(result.eventDay, result.eventMonth),
        time: result.eventTime || '',
        note: items[0]?.body || '',
        done: false,
        createdAt: new Date().toISOString()
      };
      DB.appointments = DB.appointments || [];
      DB.appointments.push(appt);
      const eventEntry = {
        id: Date.now() + 1,
        date: dateStr, time: timeStr,
        sourceType, rubric: 'event',
        text,
        title: appt.title,
        body: items[0]?.body || '',
        eventDay: appt.day, eventMonth: appt.month, eventYear: appt.year, eventTime: appt.time,
        apptId: appt.id,
        tags: items[0]?.tags || [],
        extraRubrics: forcedExtras.length ? forcedExtras : undefined,
        analyzedAt: new Date().toISOString()
      };
      DB.library.unshift(eventEntry);
      save(DB);
      const daysLeft = getDaysUntil(appt.day, appt.month);
      let reply = `📅 <b>${appt.title}</b> — ${appt.day} ${MONTHS_RU[appt.month-1]}${appt.year?' '+appt.year:''}${appt.time?', '+appt.time:''}\n`;
      reply += daysLeft === 0 ? '🔔 Сегодня!' : daysLeft === 1 ? '🔔 Завтра!' : `🔔 Через ${daysLeft} дн.`;
      await tgSend(chatId, reply);
      return;
    }

    // Извлекаем URL из текста (медиа-ссылки сохраняем вместе с записью)
    const urlMatch = text.match(/https?:\/\/\S+/g);
    const mediaUrls = urlMatch || [];

    const dateShort = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });

    // Claude сам решает разбивать или нет; покупки делим всегда при нескольких позициях
    const splitRequested = (result.split === true || rubric === 'shopping') && items.length > 1;

    if (splitRequested) {
      // Каждый item → отдельная запись в library
      items.forEach((item, idx) => {
        const entry = {
          id: Date.now() + idx,
          date: dateStr, time: timeStr,
          sourceType, rubric,
          text: item.title || text.slice(0, 60),
          title: item.title || text.slice(0, 60),
          body: item.body || '',
          emotion: item.emotion || '',
          priority: item.priority || '',
          tags: item.tags || [],
          mediaUrls: idx === 0 ? mediaUrls : [],
          context: context || null,
          images: (idx === 0 && photoFileId) ? [{ id: photoFileId, mime: 'image/jpeg' }] : undefined,
          analyzedAt: new Date().toISOString()
        };
        DB.library.unshift(entry);
        if (rubric === 'idea') {
          DB.cards.unshift({ ...item, rubric, date: dateShort, libId: entry.id, addedAt: new Date().toISOString() });
        }
      });

      save(DB);

      const emoji = R_EMOJI[rubric] || '•';
      const label = R_LABEL[rubric] || rubric;
      let reply = `${emoji} <b>${label} — ${items.length} шт. (разделено)</b>\n\n`;
      items.forEach(item => {
        reply += `<b>${item.title}</b>\n<i>${(item.body||'').slice(0, 100)}${(item.body||'').length > 100 ? '…' : ''}</i>\n`;
        if (item.priority === 'high') reply += `🔴 срочно\n`;
        reply += '\n';
      });
      await tgSend(chatId, reply.trim());

    } else {
      // Стандартно — одна запись на сообщение
      const allTags = [...new Set(items.flatMap(i => i.tags || []))];
      const libEntry = {
        id: Date.now(),
        date: dateStr, time: timeStr,
        sourceType, rubric, text,
        title: items[0]?.title || text.slice(0, 60),
        body: items[0]?.body || '',
        emotion: items[0]?.emotion || '',
        priority: items[0]?.priority || '',
        tags: allTags,
        mediaUrls,
        context: context || null,
        items,
        artType: rubric === 'media' ? (result.artType || '') : undefined,
        workTitle: rubric === 'media' ? (result.workTitle || '') : undefined,
        noteKind: rubric === 'media' ? (result.noteKind || '') : undefined,
        extraRubrics: forcedExtras.length ? forcedExtras : undefined,
        workId: forcedProjectId || undefined,
        images: photoFileId ? [{ id: photoFileId, mime: 'image/jpeg' }] : undefined,
        analyzedAt: new Date().toISOString()
      };
      DB.library.unshift(libEntry);
      lastNote[chatId] = { libId: libEntry.id, ts: Date.now(), urlOnly: incomingUrlOnly };

      items.forEach(item => {
        DB.cards.unshift({ ...item, rubric, date: dateShort, libId: libEntry.id, addedAt: new Date().toISOString() });
      });

      save(DB);

      const emoji = R_EMOJI[rubric] || '•';
      const label = R_LABEL[rubric] || rubric;
      let reply = `${emoji} <b>${label}</b>\n`;
      if (sourceType === 'voice') reply += `<i>🎙 расшифровано из аудио</i>\n`;
      reply += '\n';
      if (items.length) {
        items.forEach(item => {
          reply += `<b>${item.title}</b>\n<i>${(item.body||'').slice(0, 120)}${(item.body||'').length > 120 ? '…' : ''}</i>\n`;
          if (item.emotion) reply += `<i>${item.emotion}</i>\n`;
          if (item.priority === 'high') reply += `🔴 высокий приоритет\n`;
        });
      } else {
        reply += '<i>сохранено</i>';
      }
      await tgSend(chatId, reply.trim());
    }
  } catch(e) {
    console.error('Handle error:', e);
    DB.library.unshift({ id: Date.now(), date: dateStr, time: timeStr, sourceType, rubric: 'thought', text, title: text.slice(0,60), analyzedAt: null });
    save(DB);
    await tgSend(chatId, '⚠️ Ошибка анализа, текст сохранён.');
  }
}

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const { message, callback_query } = req.body;
  if (callback_query) { try { await handleCallback(callback_query); } catch(e) { console.error('callback:', e); } return; }
  if (message) { try { await handle(message); } catch(e) { console.error(e); } }
});

function auth(req, res) {
  if (!API_SECRET) return true;
  if (req.headers.authorization !== `Bearer ${API_SECRET}`) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, library: DB.library.length, cards: DB.cards.length, updatedAt: DB.updatedAt }));

// Внешний пингер (cron-job.org и т.п.): будит Render и рассылает напоминания БЕЗ входящего сообщения.
// Настройка: GET https://<хост>/api/cron?key=API_SECRET каждые 30 минут.
app.get('/api/cron', async (req, res) => {
  if (API_SECRET && req.query.key !== API_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    DB = await load();
    if (!DB.ownerChatId) return res.json({ ok: false, reason: 'ownerChatId ещё не известен — напиши боту любое сообщение' });
    await checkBirthdayReminders(DB.ownerChatId);
    await checkEventReminders(DB.ownerChatId);
    res.json({ ok: true, checked: (DB.appointments||[]).length + (DB.birthdays||[]).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/data', async (req, res) => { if (!auth(req,res)) return; DB = await load(); res.json(DB); });
app.post('/api/sync', (req, res) => {
  if (!auth(req,res)) return;
  const { cards, events, beliefs, intro } = req.body;
  if (cards) DB.cards = cards;
  if (events) DB.events = events;
  if (beliefs) DB.beliefs = beliefs;
  if (intro !== undefined) DB.intro = intro;
  save(DB); res.json({ ok: true, updatedAt: DB.updatedAt });
});
// ── UI-СОСТОЯНИЕ (выполненные задачи, колонки, куплено, опубликовано, удалённые) ──
// Раньше жило только в localStorage браузера → терялось при смене устройства. Теперь сервер — источник правды.
app.post('/api/state', (req, res) => {
  if (!auth(req, res)) return;
  const allowed = ['doneTasks', 'taskCols', 'shopDone', 'shopCols', 'published', 'deleted'];
  DB.uiState = DB.uiState || EMPTY_UI_STATE();
  for (const k of allowed) if (req.body[k] !== undefined) DB.uiState[k] = req.body[k];
  DB.uiState.updatedAt = new Date().toISOString();
  save(DB);
  res.json({ ok: true });
});

app.put('/api/cards/:idx', (req, res) => {
  if (!auth(req,res)) return;
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= DB.cards.length) return res.status(404).json({ error: 'not found' });
  DB.cards[idx] = { ...DB.cards[idx], ...req.body }; save(DB); res.json({ ok: true });
});
app.delete('/api/cards/:idx', (req, res) => {
  if (!auth(req,res)) return;
  DB.cards.splice(parseInt(req.params.idx), 1); save(DB); res.json({ ok: true });
});
app.delete('/api/library/:idx', (req, res) => {
  if (!auth(req,res)) return;
  DB.library.splice(parseInt(req.params.idx), 1); save(DB); res.json({ ok: true });
});
// Надёжное удаление по id (индекс клиента не совпадает с серверным после сортировки/мёржа)
app.delete('/api/library/by-id/:id', (req, res) => {
  if (!auth(req,res)) return;
  const id = Number(req.params.id);
  const before = DB.library.length;
  DB.library = DB.library.filter(e => e.id !== id);
  // подчищаем связанные карточки-идеи
  DB.cards = (DB.cards || []).filter(c => c.libId !== id);
  save(DB);
  res.json({ ok: true, removed: before - DB.library.length });
});

// Bulk import endpoint
app.post('/api/import', async (req, res) => {
  if (!auth(req,res)) return;
  const { text, source } = req.body;
  if (!text) return res.status(400).json({ error: 'no text' });
  try {
    const chunks = text.match(/.{1,3000}/gs) || [text];
    let allItems = [];
    for (const chunk of chunks.slice(0, 10)) {
      const result = await analyze(chunk, source ? `Источник импорта: ${source}` : '');
      if (result.items) allItems = allItems.concat(result.items.map(i => ({ ...i, rubric: result.rubric })));
    }
    const dateShort = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });
    allItems.forEach(item => DB.cards.unshift({ ...item, date: dateShort, fromImport: source || 'import', addedAt: new Date().toISOString() }));
    DB.library.unshift({ id: Date.now(), date: dateShort, time: '', sourceType: 'import', rubric: 'context', text: text.slice(0, 500) + (text.length > 500 ? '…' : ''), title: `Импорт: ${source || 'файл'}`, body: `${allItems.length} записей`, analyzedAt: new Date().toISOString() });
    save(DB);
    res.json({ ok: true, imported: allItems.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BULK RAW IMPORT (без Claude-анализа) ──
app.post('/api/bulk-raw', async (req, res) => {
  if (!auth(req, res)) return;
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries must be array' });
  let added = 0, skipped = 0;
  const existingIds = new Set(DB.library.map(e => e.id));
  for (const entry of entries) {
    if (existingIds.has(entry.id)) { skipped++; continue; }
    DB.library.push(entry);
    existingIds.add(entry.id);
    added++;
  }
  // Сортируем по дате (новые сначала)
  DB.library.sort((a, b) => b.id - a.id);
  save(DB);
  res.json({ ok: true, added, skipped, total: DB.library.length });
});

// ── BATCH RE-ANALYZE ──
app.post('/api/reanalyze-batch', async (req, res) => {
  if (!auth(req, res)) return;
  const batchSize = parseInt(req.query.n) || 20;

  // Берём записи без анализа
  const pending = DB.library.filter(e => !e.analyzedAt || e.analyzedAt === 'null').slice(0, batchSize);
  console.log('reanalyze: total=', DB.library.length, 'pending=', pending.length, 'sample analyzedAt=', DB.library[0]?.analyzedAt, typeof DB.library[0]?.analyzedAt);
  if (!pending.length) return res.json({ ok: true, processed: 0, remaining: 0, debug: { total: DB.library.length, sample: DB.library[0]?.analyzedAt, type: typeof DB.library[0]?.analyzedAt } });

  const BATCH = 5; // по 5 за вызов Claude
  let processed = 0;

  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    const numbered = chunk.map((e, j) => `${j+1}. [${e.sourceType||'text'}] ${e.text||e.title||''}`).join('\n\n');

    const prompt = `Проанализируй ${chunk.length} коротких записей из личного дневника Дмитрия. Это его твиты, тредсы, заметки.

${numbered}

Верни JSON массив из ${chunk.length} объектов (строго по порядку):
[{
  "rubric": "idea|dream|task|thought|resentment|admiration|quote|media|context",
  "title": "до 70 символов",
  "body": "суть 1-3 предложения",
  "type": "belief|question|shifting|tension|abandoned",
  "domain": "love|mind|society|self|work|other",
  "emotion": "",
  "priority": "high|medium|low",
  "tags": ["тег1","тег2"]
}]

РУБРИКИ: idea=убеждение/философия, dream=сон, task=конкретная задача/план сделать, thought=рассуждение, resentment=обида/раздражение, admiration=восхищение, quote=чужое+комментарий, media=книга/фильм/подкаст, context=бытовое
Для task: priority обязателен. Для idea: type и domain обязательны.
Отвечай ТОЛЬКО JSON массивом.`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await r.json();
      const raw = data.content?.map(c => c.text || '').join('') || '[]';
      console.log('claude raw:', raw.slice(0, 300), 'error:', data.error);
      const results = JSON.parse(raw.replace(/```json|```/g, '').trim());

      chunk.forEach((entry, j) => {
        const result = Array.isArray(results) ? results[j] : null;
        if (!result) return;
        // Обновляем запись в library
        const idx = DB.library.findIndex(e => e.id === entry.id);
        if (idx === -1) return;
        DB.library[idx] = {
          ...DB.library[idx],
          rubric: result.rubric || 'thought',
          title: result.title || entry.title,
          body: result.body || entry.body,
          emotion: result.emotion || '',
          priority: result.priority || '',
          tags: result.tags || [],
          analyzedAt: new Date().toISOString(),
        };
        // Если идея — добавляем в cards
        if (result.rubric === 'idea') {
          const exists = DB.cards.find(c => c.libId === entry.id);
          if (!exists) {
            const dateShort = new Date(entry.id).toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
            DB.cards.unshift({
              title: result.title, body: result.body,
              type: result.type || 'belief', domain: result.domain || 'other',
              was: '', now: '', rubric: 'idea',
              date: dateShort, libId: entry.id, addedAt: new Date().toISOString(),
              tags: result.tags || [],
            });
          }
        }
        processed++;
      });
    } catch (e) {
      console.error('reanalyze chunk error:', e.message);
      save(DB);
      const remaining = DB.library.filter(e => !e.analyzedAt || e.analyzedAt === 'null').length;
      return res.json({ ok: false, error: e.message, processed, remaining });
    }
  }

  save(DB);
  const remaining = DB.library.filter(e => !e.analyzedAt || e.analyzedAt === 'null').length;
  res.json({ ok: true, processed, remaining });
});

// ── MANUAL RECLASSIFY ──
app.put('/api/library/:idx/rubric', (req, res) => {
  if (!auth(req, res)) return;
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= DB.library.length) return res.status(404).json({ error: 'not found' });
  const { rubric, type, priority, subtype } = req.body;
  DB.library[idx].rubric = rubric;
  if (type !== undefined) DB.library[idx].type = type;
  if (priority !== undefined) DB.library[idx].priority = priority;
  if (subtype !== undefined) DB.library[idx].subtype = subtype;
  DB.library[idx].analyzedAt = new Date().toISOString();
  save(DB);
  res.json({ ok: true });
});

// Надёжное обновление записи по id: рубрика, подтип И текстовые поля.
// Раньше клиент слал только рубрику по индексу — правки title/body/text/tags терялись при следующем пуле.
app.put('/api/library/by-id/:id', (req, res) => {
  if (!auth(req, res)) return;
  const id = Number(req.params.id);
  const e = DB.library.find(x => x.id === id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const { rubric, type, priority, subtype, title, body, text, tags, bucket, linkedName, workId, artType, noteKind, extraRubrics, images } = req.body;
  if (rubric !== undefined) e.rubric = rubric;
  if (extraRubrics !== undefined) e.extraRubrics = Array.isArray(extraRubrics) ? extraRubrics : [];
  if (images !== undefined) e.images = Array.isArray(images) ? images : [];
  if (type !== undefined) e.type = type;
  if (priority !== undefined) e.priority = priority;
  if (subtype !== undefined) e.subtype = subtype;
  if (title !== undefined) e.title = title;
  if (body !== undefined) e.body = body;
  if (text !== undefined) e.text = text;
  if (tags !== undefined) e.tags = tags;
  if (bucket !== undefined) e.bucket = bucket;
  if (linkedName !== undefined) e.linkedName = linkedName;
  if (workId !== undefined) e.workId = workId;
  if (artType !== undefined) e.artType = artType;
  if (noteKind !== undefined) e.noteKind = noteKind;
  e.analyzedAt = new Date().toISOString();
  // синхронизируем связанную карточку-идею, если есть
  const card = (DB.cards || []).find(c => c.libId === id);
  if (card) {
    if (title !== undefined) card.title = title;
    if (body !== undefined) card.body = body;
    if (type !== undefined) card.type = type;
  }
  save(DB);
  res.json({ ok: true });
});

// ── BIRTHDAYS API ──
app.get('/api/birthdays', (req, res) => { if (!auth(req,res)) return; res.json(DB.birthdays||[]); });
app.post('/api/birthdays', (req, res) => {
  if (!auth(req,res)) return;
  const b = req.body;
  if (!b.name||!b.day||!b.month) return res.status(400).json({error:'name, day, month required'});
  const existing = (DB.birthdays||[]).find(x=>x.name.toLowerCase()===b.name.toLowerCase());
  if (existing) { Object.assign(existing, b); } else { DB.birthdays = DB.birthdays||[]; DB.birthdays.push({id:Date.now(),...b,toasts:b.toasts||[],gifts:b.gifts||[]}); }
  save(DB); res.json({ok:true});
});
app.delete('/api/birthdays/:id', (req, res) => {
  if (!auth(req,res)) return;
  const id = parseInt(req.params.id);
  DB.birthdays = (DB.birthdays||[]).filter(b=>b.id!==id);
  save(DB); res.json({ok:true});
});
app.put('/api/birthdays/:id/toast', (req, res) => {
  if (!auth(req,res)) return;
  const b = (DB.birthdays||[]).find(x=>x.id===parseInt(req.params.id));
  if (!b) return res.status(404).json({error:'not found'});
  b.toasts = b.toasts||[]; b.toasts.push({id:Date.now(),text:req.body.text,addedAt:new Date().toISOString()});
  save(DB); res.json({ok:true});
});
app.put('/api/birthdays/:id/gift', (req, res) => {
  if (!auth(req,res)) return;
  const b = (DB.birthdays||[]).find(x=>x.id===parseInt(req.params.id));
  if (!b) return res.status(404).json({error:'not found'});
  b.gifts = b.gifts||[]; b.gifts.push({id:Date.now(),text:req.body.text,addedAt:new Date().toISOString()});
  save(DB); res.json({ok:true});
});

// ── ДЕНЬГИ: балансы сервисов + ежемесячные платежи ──
app.get('/api/finance', (req,res)=>{ if(!auth(req,res))return; res.json(DB.finance||EMPTY_FINANCE()); });
app.post('/api/finance/service', (req,res)=>{
  if(!auth(req,res))return;
  const b=req.body;
  if(!b.name) return res.status(400).json({error:'name required'});
  DB.finance=DB.finance||EMPTY_FINANCE();
  const now=new Date().toISOString();
  if(b.id){
    const ex=DB.finance.services.find(s=>s.id===b.id);
    if(ex){ Object.assign(ex,b); if(b.balance!==undefined)ex.balanceUpdatedAt=now; save(DB); return res.json({ok:true,id:ex.id}); }
  }
  const s={ id:Date.now(), name:b.name, balance:b.balance??null, currency:b.currency||'$', monthlyCost:b.monthlyCost??null, renewDay:b.renewDay??null, note:b.note||'', balanceUpdatedAt:now, createdAt:now };
  DB.finance.services.push(s);
  save(DB); res.json({ok:true,id:s.id});
});
app.delete('/api/finance/service/:id', (req,res)=>{
  if(!auth(req,res))return;
  DB.finance=DB.finance||EMPTY_FINANCE();
  DB.finance.services=DB.finance.services.filter(s=>s.id!==Number(req.params.id));
  save(DB); res.json({ok:true});
});
app.post('/api/finance/recurring', (req,res)=>{
  if(!auth(req,res))return;
  const b=req.body;
  if(!b.title||b.amount==null) return res.status(400).json({error:'title, amount required'});
  DB.finance=DB.finance||EMPTY_FINANCE();
  if(b.id){
    const ex=DB.finance.recurring.find(r=>r.id===b.id);
    if(ex){ Object.assign(ex,b); save(DB); return res.json({ok:true,id:ex.id}); }
  }
  const r={ id:Date.now(), title:b.title, amount:b.amount, currency:b.currency||'$', kind:b.kind==='income'?'income':'expense', day:b.day??null, note:b.note||'', createdAt:new Date().toISOString() };
  DB.finance.recurring.push(r);
  save(DB); res.json({ok:true,id:r.id});
});
app.delete('/api/finance/recurring/:id', (req,res)=>{
  if(!auth(req,res))return;
  DB.finance=DB.finance||EMPTY_FINANCE();
  DB.finance.recurring=DB.finance.recurring.filter(r=>r.id!==Number(req.params.id));
  save(DB); res.json({ok:true});
});
app.post('/api/finance/debt', (req,res)=>{
  if(!auth(req,res))return;
  const b=req.body;
  DB.finance=DB.finance||EMPTY_FINANCE();
  DB.finance.debts=DB.finance.debts||[];
  if(b.id){
    const ex=DB.finance.debts.find(d=>d.id===b.id);
    if(ex){ Object.assign(ex,b); save(DB); return res.json({ok:true,id:ex.id}); }
  }
  if(!b.who) return res.status(400).json({error:'who required'});
  const d={ id:Date.now(), who:b.who, amount:b.amount??null, currency:b.currency||'₪', direction:b.direction||'debt_i_owe', date:b.date||new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric',timeZone:USER_TZ}), note:b.note||'', closed:false, createdAt:new Date().toISOString() };
  DB.finance.debts.push(d);
  save(DB); res.json({ok:true,id:d.id});
});
app.delete('/api/finance/debt/:id', (req,res)=>{
  if(!auth(req,res))return;
  DB.finance=DB.finance||EMPTY_FINANCE();
  DB.finance.debts=(DB.finance.debts||[]).filter(d=>d.id!==Number(req.params.id));
  save(DB); res.json({ok:true});
});

// ── ВРЕМЯ (Clockify): отдельная коллекция, компактные записи ──
// entry: { _id: clockify id, s: start ms, d: минуты, p: проект, t: [теги], ds: описание }
app.post('/api/timelog/bulk', async (req,res)=>{
  if(!auth(req,res))return;
  const { entries } = req.body;
  if(!Array.isArray(entries)) return res.status(400).json({error:'entries must be array'});
  if(!timelogCol) return res.status(500).json({error:'no storage'});
  let added=0, skipped=0;
  // порциями, дубликаты по _id игнорируем
  for(let i=0;i<entries.length;i+=500){
    const chunk=entries.slice(i,i+500).map(e=>({_id:e.id,s:e.s,d:e.d,p:e.p||'',t:e.t||[],ds:(e.ds||'').slice(0,300)}));
    try{ const r=await timelogCol.insertMany(chunk,{ordered:false}); added+=r.insertedCount; }
    catch(err){ added+=err.result?.insertedCount||err.insertedCount||0; skipped+=chunk.length-(err.result?.insertedCount||err.insertedCount||0); }
  }
  const total=await timelogCol.countDocuments();
  res.json({ok:true,added,skipped,total});
});
app.get('/api/timelog', async (req,res)=>{
  if(!auth(req,res))return;
  if(!timelogCol) return res.json([]);
  try{
    const since=req.query.since?Number(req.query.since):0;
    const list=await timelogCol.find(since?{s:{$gt:since}}:{}).sort({s:1}).toArray();
    res.json(list);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ── МЕРОПРИЯТИЯ API ──
app.get('/api/appointments', (req,res)=>{ if(!auth(req,res))return; res.json(DB.appointments||[]); });
app.post('/api/appointments', (req,res)=>{
  if(!auth(req,res))return;
  const b=req.body;
  if(!b.title||!b.day||!b.month) return res.status(400).json({error:'title, day, month required'});
  DB.appointments=DB.appointments||[];
  if(b.id){ const ex=DB.appointments.find(x=>x.id===b.id); if(ex){ Object.assign(ex,b); save(DB); return res.json({ok:true,id:ex.id}); } }
  const appt={ id:Date.now(), title:b.title, day:b.day, month:b.month, year:b.year||inferEventYear(b.day,b.month), time:b.time||'', note:b.note||'', done:false, createdAt:new Date().toISOString() };
  DB.appointments.push(appt);
  save(DB); res.json({ok:true,id:appt.id});
});
app.put('/api/appointments/:id', (req,res)=>{
  if(!auth(req,res))return;
  const a=(DB.appointments||[]).find(x=>x.id===Number(req.params.id));
  if(!a) return res.status(404).json({error:'not found'});
  ['title','day','month','year','time','note','done'].forEach(k=>{ if(req.body[k]!==undefined) a[k]=req.body[k]; });
  save(DB); res.json({ok:true});
});
app.delete('/api/appointments/:id', (req,res)=>{
  if(!auth(req,res))return;
  const id=Number(req.params.id);
  DB.appointments=(DB.appointments||[]).filter(a=>a.id!==id);
  DB.library=DB.library.filter(e=>!(e.rubric==='event'&&e.apptId===id));
  save(DB); res.json({ok:true});
});

// ── ПРОИЗВЕДЕНИЯ (works) API для вкладки «Искусство» ──
app.get('/api/works', (req,res)=>{ if(!auth(req,res))return; res.json(DB.works||[]); });
app.post('/api/works', (req,res)=>{
  if(!auth(req,res))return;
  const b=req.body;
  if(!b.title) return res.status(400).json({error:'title required'});
  DB.works=DB.works||[];
  if(b.id){ const ex=DB.works.find(x=>x.id===b.id); if(ex){ Object.assign(ex,b); save(DB); return res.json({ok:true,id:ex.id}); } }
  const w={ id:Date.now(), title:b.title, type:b.type||'other', author:b.author||'', year:b.year||'', cover:b.cover||'', status:b.status||'', sheets:b.sheets||[], createdAt:new Date().toISOString() };
  DB.works.push(w);
  save(DB); res.json({ok:true,id:w.id});
});
app.delete('/api/works/:id', (req,res)=>{
  if(!auth(req,res))return;
  const id=Number(req.params.id);
  DB.works=(DB.works||[]).filter(w=>w.id!==id);
  (DB.library||[]).forEach(e=>{ if(e.workId===id) e.workId=null; });
  save(DB); res.json({ok:true});
});

// ── ФАЙЛЫ (ноты PDF/JPEG) — отдельная коллекция, чтобы не раздувать основной документ ──
app.post('/api/files', async (req,res)=>{
  if(!auth(req,res))return;
  const { mime, name, data, workId } = req.body;
  if(!data||!mime) return res.status(400).json({error:'mime and data required'});
  const id = Date.now() + Math.floor(Math.random()*1000);
  if(mongoFiles){
    try{ await mongoFiles.insertOne({ _id:id, mime, name:name||'', data, workId:workId||null, createdAt:new Date().toISOString() }); }
    catch(e){ return res.status(500).json({error:e.message}); }
  }
  res.json({ ok:true, id, mime, name:name||'' });
});
app.get('/api/files/:id', async (req,res)=>{
  if(!auth(req,res))return;
  if(!mongoFiles) return res.status(404).json({error:'no storage'});
  try{
    const f = await mongoFiles.findOne({ _id: Number(req.params.id) });
    if(!f) return res.status(404).json({error:'not found'});
    res.json({ id:f._id, mime:f.mime, name:f.name, data:f.data });
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/files/:id', async (req,res)=>{
  if(!auth(req,res))return;
  if(mongoFiles){ try{ await mongoFiles.deleteOne({ _id: Number(req.params.id) }); }catch(e){} }
  res.json({ ok:true });
});

// ── ЧАТ ПО НОТАМ (Claude vision: видит прикреплённые ноты) ──
app.post('/api/art-chat', async (req,res)=>{
  if(!auth(req,res))return;
  const { question, fileIds = [], workTitle = '', history = [] } = req.body;
  if(!question) return res.status(400).json({error:'no question'});
  const blocks = [];
  if(mongoFiles && fileIds.length){
    for(const fid of fileIds.slice(0,5)){
      try{
        const f = await mongoFiles.findOne({ _id: Number(fid) });
        if(!f || !f.data) continue;
        const b64 = f.data.includes(',') ? f.data.split(',')[1] : f.data; // срезаем data:...;base64,
        if(f.mime === 'application/pdf'){
          blocks.push({ type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } });
        } else {
          blocks.push({ type:'image', source:{ type:'base64', media_type:f.mime||'image/jpeg', data:b64 } });
        }
      }catch(e){ console.error('art-chat file load:', e.message); }
    }
  }
  blocks.push({ type:'text', text: question });
  const system = `Ты помогаешь Дмитрию разбирать музыку и ноты${workTitle?` (произведение: «${workTitle}»)`:''}. Тебе прикреплены ноты (PDF или изображение). Отвечай на вопросы о конкретных нотах, аккордах, тактах, тональности, аппликатуре, разборе для фортепиано. По-русски, конкретно и по делу.`;
  try{
    const messages = [
      ...history.slice(-6).map(m=>({ role:m.role, content:m.content })),
      { role:'user', content: blocks }
    ];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-opus-4-8', max_tokens:1200, system, messages })
    });
    const data = await r.json();
    if(data.error){ console.error('art-chat api:', JSON.stringify(data.error)); return res.status(500).json({ error: data.error.message || 'api error' }); }
    const answer = data.content?.map(c=>c.text||'').join('') || 'Не удалось ответить';
    res.json({ answer });
  }catch(e){ res.status(500).json({ error:e.message }); }
});

// ── CHAT ENDPOINT ──
app.post('/api/chat', async (req, res) => {
  if (!auth(req, res)) return;
  const { question, history = [] } = req.body;
  if (!question) return res.status(400).json({ error: 'no question' });

  // Умный поиск: находим релевантные записи по словам из вопроса
  const words = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const scored = DB.library.map(e => {
    const haystack = `${e.title} ${e.body} ${e.text} ${(e.tags||[]).join(' ')}`.toLowerCase();
    const hits = words.filter(w => haystack.includes(w)).length;
    return { entry: e, hits };
  }).filter(x => x.hits > 0).sort((a, b) => b.hits - a.hits);

  // Берём топ-30 релевантных + все идеи
  const relevant = scored.slice(0, 30).map(x => x.entry);
  const ideas = DB.cards.filter(c => c.rubric === 'idea');

  // Формируем контекст
  const ctxIdeas = ideas.map(c =>
    `[ИДЕЯ · ${c.type||''} · ${c.domain||''}] ${c.title}${c.body ? ': ' + c.body : ''}${c.was ? ` (было: ${c.was} → стало: ${c.now})` : ''}`
  ).join('\n');

  const ctxEntries = relevant.map(e =>
    `[${e.date} · ${e.rubric}${e.tags?.length ? ' · ' + e.tags.join(', ') : ''}] ${e.title}${e.body ? ': ' + e.body : ''}${e.text && e.text !== e.body ? '\nОригинал: ' + e.text.slice(0, 400) : ''}`
  ).join('\n\n');

  const system = `Ты — личный интеллектуальный помощник Дмитрия. Ты знаешь его записи, идеи и убеждения.
Отвечай на вопросы опираясь на его данные. Будь конкретным — цитируй его мысли, называй даты.
Если данных по теме нет — честно скажи. Отвечай по-русски, коротко и точно.

КАРТА ЛИЧНОСТИ (идеи и убеждения):
${ctxIdeas || 'нет данных'}

РЕЛЕВАНТНЫЕ ЗАПИСИ ИЗ БИБЛИОТЕКИ:
${ctxEntries || 'нет совпадений по запросу'}`;

  try {
    const messages = [
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: question }
    ];
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages })
    });
    const data = await r.json();
    const answer = data.content?.map(c => c.text || '').join('') || 'Ошибка ответа';
    res.json({ answer, sources: relevant.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ДНИ РОЖДЕНИЯ ──
function getDaysUntil(day, month) {
  // считаем от «логического сегодня» пользователя (Тель-Авив + ночной сдвиг), чистая арифметика дат через UTC
  // ролловер на следующий год — только для ежегодных дат (дни рождения)
  const t = userTodayParts();
  const today = Date.UTC(t.y, t.m - 1, t.d);
  let target = Date.UTC(t.y, month - 1, day);
  if (target < today) target = Date.UTC(t.y + 1, month - 1, day);
  return Math.round((target - today) / 86400000);
}

// Мероприятия ОДНОРАЗОВЫЕ: год фиксирован, прошедшее событие = отрицательные дни (не переносится на следующий год)
function apptDaysUntil(a) {
  const t = userTodayParts();
  const today = Date.UTC(t.y, t.m - 1, t.d);
  const target = Date.UTC(a.year || t.y, a.month - 1, a.day);
  return Math.round((target - today) / 86400000);
}
// при создании без явного года: если дата ещё впереди в этом году — этот год, иначе следующий
function inferEventYear(day, month) {
  const t = userTodayParts();
  return Date.UTC(t.y, month - 1, day) >= Date.UTC(t.y, t.m - 1, t.d) ? t.y : t.y + 1;
}

const MONTHS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

async function checkBirthdayReminders(chatId) {
  if (!DB.birthdays?.length) return;
  const todayKey = userDateKey();
  for (const b of DB.birthdays) {
    const days = getDaysUntil(b.day, b.month);
    if (![0,1,7].includes(days)) continue;
    const notifyKey = `${b.id}_${todayKey}_${days}`;
    if ((DB.notified||[]).includes(notifyKey)) continue;
    const age = b.year ? ` (${new Date().getFullYear() - b.year} лет)` : '';
    let msg;
    if (days===0) msg = `🎂 Сегодня день рождения у <b>${b.name}</b>!${age}`;
    else if (days===1) msg = `🎂 Завтра день рождения у <b>${b.name}</b>${age} — ${b.day} ${MONTHS_RU[b.month-1]}`;
    else msg = `🎂 Через неделю день рождения у <b>${b.name}</b>${age} — ${b.day} ${MONTHS_RU[b.month-1]}`;
    await tgSend(chatId, msg);
    if (!DB.notified) DB.notified = [];
    DB.notified.push(notifyKey);
    if (DB.notified.length > 200) DB.notified = DB.notified.slice(-100);
    save(DB);
  }
}

async function checkEventReminders(chatId) {
  if (!DB.appointments?.length) return;
  const todayKey = userDateKey();
  for (const a of DB.appointments) {
    if (a.done) continue;
    const days = apptDaysUntil(a);
    if (![0,1,3].includes(days)) continue;
    const notifyKey = `ev_${a.id}_${todayKey}_${days}`;
    if ((DB.notified||[]).includes(notifyKey)) continue;
    const when = `${a.day} ${MONTHS_RU[a.month-1]}${a.time?', '+a.time:''}`;
    let msg;
    if (days===0) msg = `📅 Сегодня: <b>${a.title}</b> (${when})`;
    else if (days===1) msg = `📅 Завтра: <b>${a.title}</b> — ${when}`;
    else msg = `📅 Через 3 дня: <b>${a.title}</b> — ${when}`;
    await tgSend(chatId, msg);
    if (!DB.notified) DB.notified = [];
    DB.notified.push(notifyKey);
    if (DB.notified.length > 200) DB.notified = DB.notified.slice(-100);
    save(DB);
  }
}

async function setupWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) { console.log('WEBHOOK_URL не задан'); return; }
  const webhookUrl = `${url}/webhook/${TELEGRAM_TOKEN}`;
  const r = await fetch(`${TG}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  const j = await r.json();
  console.log('Webhook:', j.ok ? `✓ ${webhookUrl}` : `✗ ${j.description}`);
  // Команды бота
  await fetch(`${TG}/setMyCommands`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ commands: [
      {command:'cat', description:'📂 Выбрать категорию для следующего сообщения'},
      {command:'start', description:'Привет и справка'},
      {command:'stats', description:'📊 Статистика записей'},
      {command:'last', description:'🗂 Последние записи'},
      {command:'tasks', description:'🎯 Активные задачи'},
      {command:'events', description:'📅 Ближайшие мероприятия'},
      {command:'dreams', description:'🌙 Последние сны'},
    ]})
  });
}

app.listen(PORT, async () => {
  console.log(`🚀 Порт ${PORT}`);
  await connectMongo();
  DB = await load();
  console.log(`📚 Загружено: library=${DB.library.length}, cards=${DB.cards.length}`);
  await setupWebhook();
});
