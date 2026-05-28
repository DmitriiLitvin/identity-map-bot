import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

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

// ── STORAGE ──
function load() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) {}
  return { library: [], cards: [], events: [], beliefs: [], intro: null };
}
function save(d) {
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
let DB = load();

// ── TELEGRAM ──
async function tgSend(chatId, text, extra = {}) {
  await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
  });
}

async function downloadFile(fileId) {
  const r = await fetch(`${TG}/getFile?file_id=${fileId}`);
  const j = await r.json();
  const fp = j.result.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fp}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), filePath: fp };
}

// ── WHISPER ──
async function transcribe(buffer, filePath) {
  if (!OPENAI_API_KEY) return { text: '[голосовое — нет OpenAI ключа]', ok: false };
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
  return { text: j.text || '[не удалось расшифровать]', ok: !!j.text };
}

// ── CLAUDE ANALYSIS ──
const SYSTEM = `Ты анализируешь личные сообщения человека — его мысли, сны, планы, обиды, восхищения.

Определи рубрику и извлеки структурированные данные.

Отвечай ТОЛЬКО валидным JSON-объектом без markdown:
{
  "rubric": "idea|dream|plan|resentment|admiration|quote|current",
  "items": [
    {
      "title": "краткое название (до 60 символов)",
      "body": "суть (2-4 предложения)",
      "type": "belief|question|shifting|tension|abandoned",
      "domain": "love|mind|society|self|work|other",
      "was": "",
      "now": "",
      "source": "",
      "emotion": ""
    }
  ]
}

Рубрики:
- idea: идея, убеждение, мысль о жизни, философия → попадает в карту личности
- dream: сон, образ приснившийся → важно сохранить образы и эмоцию
- plan: планы, намерения, что хочет сделать
- resentment: обида, раздражение, что задело
- admiration: восхищение, что впечатлило, чужая мысль которая резонирует
- quote: чужой контент (статья, пост, цитата) + комментарий автора
- current: текущие дела, заботы, контекст жизни, бытовое

Для рубрики dream:
- title: главный образ или событие сна
- body: описание сна
- emotion: эмоция во сне и после пробуждения
- type и domain можно оставить пустыми

Для idea — заполни type и domain обязательно:
Типы: belief (убеждение), question (открытый вопрос), shifting (меняется), tension (противоречие), abandoned (отказался)
Домены: love, mind, society, self, work, other

Если несколько разных вещей в одном сообщении — несколько items.
Если непонятно что это — рубрика current.`;

async function analyze(text, context = '') {
  const msg = context ? `${context}\n\n${text}` : text;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: msg }] })
  });
  const data = await r.json();
  const raw = data.content?.map(c => c.text || '').join('') || '{}';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

const RUBRIC_EMOJI = { idea:'🔥', dream:'🌙', plan:'📋', resentment:'😤', admiration:'✨', quote:'💬', current:'🌀' };
const RUBRIC_LABEL = { idea:'Идея', dream:'Сон', plan:'План', resentment:'Обида', admiration:'Восхищение', quote:'Цитата', current:'Текущее' };

// ── MESSAGE HANDLER ──
async function handle(msg) {
  const chatId = msg.chat.id;
  const ts = new Date(msg.date * 1000);
  const dateStr = ts.toLocaleDateString('ru-RU', { day:'numeric', month:'short', year:'numeric' });
  const timeStr = ts.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });

  let text = '', sourceType = 'text', context = '';

  // Commands
  if (msg.text?.startsWith('/')) {
    const cmd = msg.text.split(' ')[0];
    if (cmd === '/start') {
      await tgSend(chatId, `👋 <b>Привет! Я твой личный дневник.</b>\n\nПросто пиши, диктуй или пересылай — я разберу и сохраню.\n\n<b>Что я понимаю:</b>\n🔥 Идеи и убеждения\n🌙 Сны\n📋 Планы\n😤 Обиды\n✨ Восхищения\n💬 Чужое + твой комментарий\n🌀 Текущие дела\n\n<b>Форматы:</b>\n• Текст\n• Голосовое 🎙\n• Пересланный пост с комментарием\n• Фото с подписью\n\n/stats /last /dreams /plans`);
      return;
    }
    if (cmd === '/stats') {
      const counts = {};
      DB.library.forEach(e => counts[e.rubric] = (counts[e.rubric]||0)+1);
      const lines = Object.entries(RUBRIC_EMOJI).map(([k,e]) => `${e} ${RUBRIC_LABEL[k]}: ${counts[k]||0}`).join('\n');
      await tgSend(chatId, `📊 <b>Библиотека:</b>\n${lines}\n\n<b>Всего записей:</b> ${DB.library.length}\n<b>Идей в карте:</b> ${DB.cards.filter(c=>c.rubric==='idea').length}`);
      return;
    }
    if (cmd === '/last') {
      const last = DB.library.slice(0,5);
      if (!last.length) { await tgSend(chatId, 'Пока пусто.'); return; }
      const lines = last.map(e => `${RUBRIC_EMOJI[e.rubric]||'•'} <b>${e.title||e.text?.slice(0,40)}</b>\n<i>${e.date}</i>`).join('\n\n');
      await tgSend(chatId, `🗂 <b>Последние записи:</b>\n\n${lines}`);
      return;
    }
    if (cmd === '/dreams') {
      const dreams = DB.library.filter(e=>e.rubric==='dream').slice(0,5);
      if (!dreams.length) { await tgSend(chatId, 'Снов пока нет.'); return; }
      const lines = dreams.map(e=>`🌙 <b>${e.title}</b>\n${e.date}\n<i>${e.body?.slice(0,80)}...</i>`).join('\n\n');
      await tgSend(chatId, lines);
      return;
    }
    if (cmd === '/plans') {
      const plans = DB.library.filter(e=>e.rubric==='plan').slice(0,8);
      if (!plans.length) { await tgSend(chatId, 'Планов пока нет.'); return; }
      const lines = plans.map(e=>`📋 ${e.title}`).join('\n');
      await tgSend(chatId, `<b>Планы:</b>\n${lines}`);
      return;
    }
    return;
  }

  // Forward
  if (msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
    const from = msg.forward_from_chat?.title || msg.forward_from?.first_name || msg.forward_sender_name || 'неизвестно';
    sourceType = 'forward';
    context = `Переслано из: ${from}${msg.caption ? `\nКомментарий автора: ${msg.caption}` : ''}`;
    text = msg.text || msg.caption || '';
  }
  // Voice
  else if (msg.voice || msg.audio) {
    await tgSend(chatId, '🎙 Транскрибирую...');
    const fileId = (msg.voice || msg.audio).file_id;
    const { buffer, filePath } = await downloadFile(fileId);
    const result = await transcribe(buffer, filePath);
    text = result.text;
    sourceType = 'voice';
    context = 'Голосовая заметка человека, мысли вслух.';
  }
  // Photo
  else if (msg.photo) {
    text = msg.caption || '';
    sourceType = 'photo';
    if (!text) { await tgSend(chatId, 'Фото без подписи — добавь текст 🙂'); return; }
  }
  // Text
  else if (msg.text) {
    text = msg.text;
  } else return;

  if (!text.trim()) return;

  await tgSend(chatId, '⏳ Анализирую...');

  try {
    const result = await analyze(text, context);
    const rubric = result.rubric || 'current';
    const items = result.items || [];
    const dateNow = new Date().toLocaleDateString('ru-RU', { month:'short', year:'numeric' });

    // Сохраняем в библиотеку
    const libEntry = {
      id: Date.now(),
      date: dateStr,
      time: timeStr,
      sourceType,
      rubric,
      text,
      title: items[0]?.title || text.slice(0,50),
      body: items[0]?.body || '',
      emotion: items[0]?.emotion || '',
      context: context || null,
      analyzedAt: new Date().toISOString()
    };
    DB.library.unshift(libEntry);

    // Сохраняем в карточки
    items.forEach(item => {
      DB.cards.unshift({
        ...item,
        rubric,
        date: dateNow,
        libId: libEntry.id,
        addedAt: new Date().toISOString()
      });
    });

    save(DB);

    // Ответ боту
    const emoji = RUBRIC_EMOJI[rubric] || '•';
    const label = RUBRIC_LABEL[rubric] || rubric;
    let reply = `${emoji} <b>${label}</b> сохранено\n`;
    if (sourceType === 'voice') reply += `🎙 <i>транскрибировано из аудио</i>\n`;
    reply += '\n';
    items.forEach(item => {
      reply += `<b>${item.title}</b>\n<i>${item.body?.slice(0,100)}${item.body?.length>100?'…':''}</i>\n\n`;
    });
    if (!items.length) reply += '<i>сохранено в библиотеку</i>';

    await tgSend(chatId, reply.trim());
  } catch(e) {
    console.error('Error:', e);
    // Сохраняем даже при ошибке анализа
    DB.library.unshift({ id: Date.now(), date: dateStr, time: timeStr, sourceType, rubric: 'current', text, title: text.slice(0,50), analyzedAt: null });
    save(DB);
    await tgSend(chatId, '⚠️ Ошибка анализа, но текст сохранён в библиотеку.');
  }
}

// ── WEBHOOK ──
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const { message } = req.body;
  if (message) { try { await handle(message); } catch(e) { console.error(e); } }
});

// ── API ──
function auth(req, res) {
  if (!API_SECRET) return true;
  if (req.headers.authorization !== `Bearer ${API_SECRET}`) { res.status(401).json({ error: 'unauthorized' }); return false; }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, library: DB.library.length, cards: DB.cards.length }));

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

app.delete('/api/cards/:idx', (req, res) => {
  if (!auth(req,res)) return;
  DB.cards.splice(parseInt(req.params.idx), 1); save(DB); res.json({ ok: true });
});

app.put('/api/cards/:idx', (req, res) => {
  if (!auth(req,res)) return;
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= DB.cards.length) return res.status(404).json({ error: 'not found' });
  DB.cards[idx] = { ...DB.cards[idx], ...req.body }; save(DB); res.json({ ok: true });
});

app.delete('/api/library/:idx', (req, res) => {
  if (!auth(req,res)) return;
  DB.library.splice(parseInt(req.params.idx), 1); save(DB); res.json({ ok: true });
});

// ── WEBHOOK SETUP ──
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
