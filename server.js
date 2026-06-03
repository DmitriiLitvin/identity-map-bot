import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const { TELEGRAM_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY, API_SECRET, PORT = 3000 } = process.env;
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const DATA_FILE = path.join(__dirname, 'data.json');

function load() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('Load error:', e); }
  return { library: [], cards: [], events: [], beliefs: [], intro: null };
}
function save(d) {
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
let DB = load();

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
  "rubric": "idea|dream|task|thought|resentment|admiration|quote|media|context",
  "items": [{
    "title": "название до 70 символов",
    "body": "суть 2-4 предложения",
    "type": "belief|question|shifting|tension|abandoned",
    "domain": "love|mind|society|self|work|other",
    "was": "",
    "now": "",
    "source": "",
    "emotion": "",
    "priority": "",
    "tags": ["тег1", "тег2"]
  }]
}

РУБРИКИ:
- idea: убеждение, философская мысль, идея о жизни → в карту личности
- dream: сон — сохрани образы, сюжет, эмоцию
- task: конкретное действие, задача, план сделать что-то
- thought: незавершённая мысль, рассуждение вслух, не оформилось ещё
- resentment: обида, раздражение, что задело или злит
- admiration: восхищение, что впечатлило, резонирует
- quote: чужой контент + комментарий автора (смотри на контекст "переслано из")
- media: книга, фильм, подкаст, статья — впечатления или цитата
- context: что происходит в жизни, бытовое, дела, заботы

Для task — в priority напиши: high/medium/low если понятно из контекста.
Для dream — в emotion напиши эмоцию во сне и после пробуждения.
Для idea — type и domain обязательны.
В tags — 2-4 ключевых слова-темы одним словом (например: "математика", "язык", "самодостаточность").
Если несколько тем в одном сообщении — несколько items с разными rubric (возьми наиболее частую как основную).
Если непонятно — rubric = thought.`;

async function analyze(text, context = '') {
  const msg = context ? `${context}\n\nТекст:\n${text}` : text;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: msg }] })
  });
  const data = await r.json();
  const raw = data.content?.map(c => c.text || '').join('') || '{}';
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch(e) { return { rubric: 'thought', items: [{ title: text.slice(0, 60), body: text }] }; }
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

  if (msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
    const from = msg.forward_from_chat?.title || msg.forward_from?.first_name || msg.forward_sender_name || 'неизвестно';
    sourceType = 'forward';
    context = `Человек переслал контент из: "${from}"`;
    if (msg.caption) context += `\nЕго комментарий к пересланному: "${msg.caption}"`;
    text = msg.text || msg.caption || '';
  } else if (msg.voice || msg.audio) {
    await tgSend(chatId, '🎙 Транскрибирую...');
    const fileId = (msg.voice || msg.audio).file_id;
    const { buffer, filePath } = await downloadFile(fileId);
    text = await transcribe(buffer, filePath);
    sourceType = 'voice';
    context = 'Голосовая заметка, мысли вслух.';
  } else if (msg.photo) {
    text = msg.caption || '';
    sourceType = 'photo';
    if (!text) { await tgSend(chatId, 'Фото без подписи — добавь текст 🙂'); return; }
  } else if (msg.text) {
    text = msg.text;
  } else return;

  if (!text.trim()) return;

  await tgSend(chatId, '⏳ Анализирую...');

  try {
    const result = await analyze(text, context);
    const rubric = result.rubric || 'thought';
    const items = result.items || [];

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
      context: context || null,
      items,
      analyzedAt: new Date().toISOString()
    };
    DB.library.unshift(libEntry);

    const dateShort = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });
    items.forEach(item => {
      DB.cards.unshift({ ...item, rubric: result.rubric, date: dateShort, libId: libEntry.id, addedAt: new Date().toISOString() });
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
app.get('/api/data', (req, res) => { if (!auth(req,res)) return; DB = load(); res.json(DB); });
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
  const pending = DB.library.filter(e => !e.analyzedAt).slice(0, batchSize);
  if (!pending.length) return res.json({ ok: true, processed: 0, remaining: 0 });

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
        body: JSON.stringify({ model: 'claude-haiku-4-20250514', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] })
      });
      const data = await r.json();
      const raw = data.content?.map(c => c.text || '').join('') || '[]';
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
    }
  }

  save(DB);
  const remaining = DB.library.filter(e => !e.analyzedAt).length;
  res.json({ ok: true, processed, remaining });
});

// ── MANUAL RECLASSIFY ──
app.put('/api/library/:idx/rubric', (req, res) => {
  if (!auth(req, res)) return;
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= DB.library.length) return res.status(404).json({ error: 'not found' });
  const { rubric } = req.body;
  DB.library[idx].rubric = rubric;
  DB.library[idx].analyzedAt = new Date().toISOString();
  save(DB);
  res.json({ ok: true });
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

async function setupWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) { console.log('WEBHOOK_URL не задан'); return; }
  const webhookUrl = `${url}/webhook/${TELEGRAM_TOKEN}`;
  const r = await fetch(`${TG}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  const j = await r.json();
  console.log('Webhook:', j.ok ? `✓ ${webhookUrl}` : `✗ ${j.description}`);
}

app.listen(PORT, async () => {
  console.log(`🚀 Порт ${PORT}`);
  await setupWebhook();
});
