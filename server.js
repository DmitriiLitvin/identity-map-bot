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

// ── MONGODB ──
let mongoCol = null;

async function connectMongo() {
  if (!MONGODB_URI) { console.warn('⚠️  MONGODB_URI не задан — данные не сохранятся'); return; }
  try {
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    mongoCol = client.db('identity-map').collection('data');
    console.log('✓ MongoDB подключён');
  } catch(e) {
    console.error('MongoDB ошибка подключения:', e.message);
  }
}

const EMPTY_DB = () => ({ library: [], cards: [], events: [], beliefs: [], intro: null, birthdays: [], notified: [] });

async function load() {
  if (!mongoCol) return EMPTY_DB();
  try {
    const doc = await mongoCol.findOne({ _id: 'main' });
    if (!doc) return EMPTY_DB();
    const { _id, ...data } = doc;
    return { library:[], cards:[], events:[], beliefs:[], intro:null, ...data };
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
  "rubric": "idea|dream|task|thought|notebook|birthday|media|quote",
  "split": false,
  "birthdayName": "",
  "birthdayDay": null,
  "birthdayMonth": null,
  "birthdayYear": null,
  "toastFor": "",
  "giftFor": "",
  "items": [{
    "title": "название до 70 символов",
    "body": "суть 2-4 предложения",
    "type": "belief|question|shifting|tension|abandoned",
    "domain": "love|mind|society|self|work|other",
    "was": "",
    "now": "",
    "emotion": "",
    "priority": "",
    "tags": ["тег1", "тег2"]
  }]
}

ПОЛЕ split: поставь true ТОЛЬКО если в сообщении есть явная цифра или числительное указывающее количество задач — например "3 задачи", "две вещи", "4 дела", "пять штук". Если конкретного числа нет — split всегда false. "Несколько", "пара" без цифры — НЕ считается, split=false.

РУБРИКИ:

TASK (задача) — нужно, надо, сделать, купить, позвонить, планирую. priority: high=срочно, medium=обычное, low=когда-нибудь.

IDEA — философская мысль, убеждение о жизни, наблюдение о мире. Требует type и domain.

THOUGHT — рассуждение вслух, незавершённая мысль, вопрос к себе. НЕ задача и НЕ идея.

NOTEBOOK (не забыть) — факт, пароль, адрес, число, информация которую надо помнить: "ключи лежат...", "пароль от...", "код от...", "адрес...", "не забыть что...". Конкретная информация без действия.

BIRTHDAY (день рождения) — если упоминается дата ДР человека → заполни birthdayName, birthdayDay, birthdayMonth, birthdayYear (если есть). Если это тост/поздравление → заполни toastFor + текст в items[0].body. Если идея подарка → заполни giftFor + текст в items[0].body.

DREAM — сон, что приснилось.
MEDIA — книга/фильм/подкаст/статья/ссылка.
QUOTE — пересланный чужой контент + комментарий.

Если непонятно — thought.`;

async function analyze(text, context = '') {
  const msg = context ? `${context}\n\nТекст:\n${text}` : text;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: msg }] })
  });
  const data = await r.json();
  if (data.error) { console.error('Claude API error:', JSON.stringify(data.error)); }
  const raw = data.content?.map(c => c.text || '').join('') || '{}';
  console.log('Claude response rubric preview:', raw.slice(0, 150));
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch(e) { console.error('JSON parse error:', e.message, 'raw:', raw.slice(0, 200)); return { rubric: 'thought', items: [{ title: text.slice(0, 60), body: text }] }; }
}

const R_EMOJI = { idea:'🔥', dream:'🌙', task:'🎯', thought:'💭', resentment:'😤', admiration:'✨', quote:'💬', media:'📖', context:'🌀' };
const R_LABEL = { idea:'Идея', dream:'Сон', task:'Задача', thought:'Мысль', resentment:'Обида', admiration:'Восхищение', quote:'Цитата', media:'Медиа', context:'Контекст' };

async function handle(msg) {
  const chatId = msg.chat.id;
  const ts = new Date(msg.date * 1000);
  const dateStr = ts.toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' });
  const timeStr = ts.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });

  let text = '', sourceType = 'text', context = '';

  if (msg.text?.startsWith('/')) {
    const cmd = msg.text.split(' ')[0];
    if (cmd === '/start') {
      await tgSend(chatId, `👋 <b>Привет! Я твой личный дневник.</b>\n\nПросто пиши или диктуй — разберу и сохраню в нужную рубрику.\n\n🔥 Идеи & убеждения\n🌙 Сны\n🎯 Задачи\n💭 Мысли вслух\n😤 Обиды\n✨ Восхищения\n💬 Чужое + комментарий\n📖 Книги & фильмы\n🌀 Контекст\n\n<b>Форматы:</b> текст, голосовое 🎙, пересланное с комментарием\n\n/stats /last /tasks /dreams`);
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
    if (!text) { await tgSend(chatId, 'Фото без подписи — добавь текст 🙂'); return; }
  } else if (msg.text) {
    text = msg.text;
  } else return;

  if (!text.trim()) return;

  // Проверяем напоминания о ДР при каждом сообщении
  checkBirthdayReminders(chatId).catch(()=>{});

  await tgSend(chatId, '⏳ Анализирую...');

  try {
    const result = await analyze(text, context);
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

    // Извлекаем URL из текста (медиа-ссылки сохраняем вместе с записью)
    const urlMatch = text.match(/https?:\/\/\S+/g);
    const mediaUrls = urlMatch || [];

    const dateShort = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });

    // Claude сам решает разбивать или нет, на основе контекста
    const splitRequested = result.split === true && items.length > 1;

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
        analyzedAt: new Date().toISOString()
      };
      DB.library.unshift(libEntry);

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
  const { message } = req.body;
  if (message) { try { await handle(message); } catch(e) { console.error(e); } }
});

function auth(req, res) {
  if (!API_SECRET) return true;
  if (req.headers.authorization !== `Bearer ${API_SECRET}`) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, library: DB.library.length, cards: DB.cards.length, updatedAt: DB.updatedAt }));
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
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
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
  const { rubric, type } = req.body;
  DB.library[idx].rubric = rubric;
  if (type) DB.library[idx].type = type;
  DB.library[idx].analyzedAt = new Date().toISOString();
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
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system, messages })
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
  const now = new Date();
  const year = now.getFullYear();
  let target = new Date(year, month - 1, day);
  if (target.setHours(0,0,0,0) < now.setHours(0,0,0,0)) target = new Date(year + 1, month - 1, day);
  return Math.round((target - new Date().setHours(0,0,0,0)) / (1000*60*60*24));
}

const MONTHS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

async function checkBirthdayReminders(chatId) {
  if (!DB.birthdays?.length) return;
  const todayKey = new Date().toISOString().slice(0,10);
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
      {command:'start', description:'Привет и справка'},
      {command:'stats', description:'📊 Статистика записей'},
      {command:'last', description:'🗂 Последние записи'},
      {command:'tasks', description:'🎯 Активные задачи'},
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
