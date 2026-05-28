import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// ── CORS для карты ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── ENV ──
const {
  TELEGRAM_TOKEN,
  ANTHROPIC_API_KEY,
  OPENAI_API_KEY,       // для Whisper транскрипции
  API_SECRET,           // секрет для защиты API карты
  PORT = 3000
} = process.env;

// ── ХРАНИЛИЩЕ ──
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {}
  return { ideas: [], notes: [], events: [] };
}

function saveData(data) {
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let DB = loadData();

// ── TELEGRAM HELPERS ──
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
  const filePath = j.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, filePath };
}

// ── WHISPER ТРАНСКРИПЦИЯ ──
async function transcribeAudio(buffer, filePath) {
  if (!OPENAI_API_KEY) {
    return '[голосовое сообщение — нет OpenAI ключа для транскрипции]';
  }
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

// ── CLAUDE АНАЛИЗ ──
const SYSTEM_PROMPT = `Ты анализируешь личные заметки, голосовые мысли и пересланный контент человека.
Твоя задача — извлечь из них идеи для карты личности.

Важные правила:
- Если человек пересылает чужой контент (статью, цитату, пост) — это НЕ его убеждение автоматически. Смотри на его комментарий.
- Если есть комментарий "согласен", "именно так", "это про меня" — тип может быть belief.
- Если комментарий "интересно", "надо подумать" — тип question.
- Если человек противоречит сам себе — тип tension.
- Если говорит "раньше думал иначе" — тип shifting, заполни was/now.
- Если "больше в это не верю" — тип abandoned.

Отвечай ТОЛЬКО валидным JSON-массивом без markdown, без пояснений.

Каждый элемент:
{
  "name": "краткое название идеи (1 строка, до 60 символов)",
  "type": "belief|question|shifting|tension|abandoned",
  "domain": "love|mind|society|self|work|other",
  "body": "суть идеи и как она влияет на человека (2-4 предложения)",
  "was": "если shifting/abandoned — как было раньше, иначе пустая строка",
  "now": "если shifting — как стало, иначе пустая строка",
  "source": "источник если упомянут (книга, человек, канал)",
  "rawNote": "дословная цитата ключевой фразы из заметки (до 100 символов)"
}

Типы:
- belief: твёрдое убеждение, моральный ориентир
- question: открытый вопрос, тема которая тревожит, нет ответа
- shifting: позиция меняется, есть динамика было→стало
- tension: противоречие, двойственность, сам с собой не согласен
- abandoned: от этого отказались, было важным — перестало быть

Домены:
- love: любовь, отношения, семья
- mind: мышление, знание, психология, философия
- society: политика, общество, культура
- self: я сам, личность, характер, тело
- work: работа, бизнес, деньги
- other: всё остальное

Если несколько идей — несколько объектов. Если идея одна — один объект.
Если в тексте нет значимых идей — верни пустой массив [].`;

async function analyzeWithClaude(text, context = '') {
  const userMsg = context
    ? `${context}\n\nСодержание:\n${text}`
    : text;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }]
    })
  });

  const data = await r.json();
  const raw = data.content?.map(c => c.text || '').join('') || '[]';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── ОБРАБОТКА СООБЩЕНИЙ ──
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const date = new Date(msg.date * 1000).toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric'
  });

  let text = '';
  let context = '';
  let noteType = 'text';

  // Пересланное сообщение
  if (msg.forward_from || msg.forward_from_chat || msg.forward_sender_name) {
    const forwardFrom = msg.forward_from_chat?.title
      || msg.forward_from?.first_name
      || msg.forward_sender_name
      || 'неизвестный источник';
    context = `Человек переслал контент из: ${forwardFrom}`;
    if (msg.caption) context += `\nЕго комментарий: ${msg.caption}`;
    text = msg.text || msg.caption || '';
    noteType = 'forward';
  }
  // Голосовое сообщение
  else if (msg.voice || msg.audio) {
    await tgSend(chatId, '🎙 Транскрибирую...');
    const fileId = (msg.voice || msg.audio).file_id;
    const { buffer, filePath } = await downloadFile(fileId);
    text = await transcribeAudio(buffer, filePath);
    context = 'Это голосовая заметка человека, его мысли вслух.';
    noteType = 'voice';
  }
  // Фото с подписью
  else if (msg.photo) {
    text = msg.caption || '';
    context = 'Человек прислал фото с подписью.';
    noteType = 'photo';
    if (!text) {
      await tgSend(chatId, 'Фото без текста — добавь подпись с мыслью 🙂');
      return;
    }
  }
  // Обычный текст
  else if (msg.text) {
    // Команды
    if (msg.text.startsWith('/start')) {
      await tgSend(chatId, `👋 Привет! Я твой дневник идей.\n\nПросто пиши или диктуй — я разберу и добавлю в карту личности.\n\n<b>Что я понимаю:</b>\n• Текстовые заметки и мысли\n• Голосовые сообщения 🎙\n• Пересланные посты с твоим комментарием\n• Фото с подписью\n\n<b>Команды:</b>\n/stats — статистика\n/last — последние идеи`);
      return;
    }
    if (msg.text.startsWith('/stats')) {
      const db = loadData();
      const byType = {};
      db.ideas.forEach(i => byType[i.type] = (byType[i.type] || 0) + 1);
      const lines = Object.entries(byType).map(([t, n]) => `  ${t}: ${n}`).join('\n');
      await tgSend(chatId, `📊 Карта личности:\nВсего идей: ${db.ideas.length}\nЗаметок: ${db.notes.length}\n\nПо типам:\n${lines}`);
      return;
    }
    if (msg.text.startsWith('/last')) {
      const db = loadData();
      const last5 = db.ideas.slice(0, 5);
      if (!last5.length) { await tgSend(chatId, 'Пока нет идей.'); return; }
      const lines = last5.map(i => `• <b>${i.name}</b> [${i.type}]`).join('\n');
      await tgSend(chatId, `🗂 Последние идеи:\n${lines}`);
      return;
    }
    text = msg.text;
    noteType = 'text';
  } else {
    return; // неподдерживаемый тип
  }

  if (!text.trim()) return;

  // Сохраняем сырую заметку
  const note = { id: Date.now(), text, noteType, date, context, processed: false };
  DB.notes.unshift(note);

  await tgSend(chatId, '⏳ Анализирую...');

  try {
    const ideas = await analyzeWithClaude(text, context);

    if (!ideas.length) {
      await tgSend(chatId, '🤔 Значимых идей не нашёл. Заметка сохранена — можешь переформулировать.');
      note.processed = true;
      saveData(DB);
      return;
    }

    const dateStr = new Date().toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
    ideas.forEach(idea => {
      DB.ideas.unshift({
        ...idea,
        date: idea.date || dateStr,
        addedAt: new Date().toISOString(),
        fromNote: note.id
      });
    });

    note.processed = true;
    saveData(DB);

    const TYPE_EMOJI = { belief: '🔥', question: '❓', shifting: '🔄', tension: '⚡', abandoned: '💀' };
    const lines = ideas.map(i => `${TYPE_EMOJI[i.type] || '•'} <b>${i.name}</b>\n   <i>${i.domain}</i> · ${i.body?.slice(0, 80)}...`).join('\n\n');
    await tgSend(chatId, `✅ Добавлено в карту (${ideas.length}):\n\n${lines}`);

  } catch (e) {
    console.error('Analysis error:', e);
    await tgSend(chatId, '❌ Ошибка анализа. Заметка сохранена.');
    saveData(DB);
  }
}

// ── WEBHOOK ──
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  res.sendStatus(200); // сразу отвечаем Telegram
  const { message } = req.body;
  if (message) {
    try { await handleMessage(message); }
    catch (e) { console.error('Handler error:', e); }
  }
});

// ── REST API ДЛЯ КАРТЫ ──
function checkAuth(req, res) {
  if (!API_SECRET) return true; // если секрет не задан — открыто
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Получить все данные
app.get('/api/data', (req, res) => {
  if (!checkAuth(req, res)) return;
  DB = loadData();
  res.json(DB);
});

// Добавить идею вручную
app.post('/api/ideas', (req, res) => {
  if (!checkAuth(req, res)) return;
  const idea = { ...req.body, addedAt: new Date().toISOString() };
  DB.ideas.unshift(idea);
  saveData(DB);
  res.json({ ok: true, idea });
});

// Обновить идею
app.put('/api/ideas/:idx', (req, res) => {
  if (!checkAuth(req, res)) return;
  const idx = parseInt(req.params.idx);
  if (idx < 0 || idx >= DB.ideas.length) return res.status(404).json({ error: 'not found' });
  DB.ideas[idx] = { ...DB.ideas[idx], ...req.body };
  saveData(DB);
  res.json({ ok: true });
});

// Удалить идею
app.delete('/api/ideas/:idx', (req, res) => {
  if (!checkAuth(req, res)) return;
  DB.ideas.splice(parseInt(req.params.idx), 1);
  saveData(DB);
  res.json({ ok: true });
});

// Синхронизация всей базы с карты
app.post('/api/sync', (req, res) => {
  if (!checkAuth(req, res)) return;
  const { ideas, events, beliefs, intro } = req.body;
  if (ideas) DB.ideas = ideas;
  if (events) DB.events = events;
  if (beliefs) DB.beliefs = beliefs;
  if (intro !== undefined) DB.intro = intro;
  saveData(DB);
  res.json({ ok: true, updatedAt: DB.updatedAt });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ideas: DB.ideas.length, notes: DB.notes.length }));

// ── РЕГИСТРАЦИЯ WEBHOOK ──
async function setupWebhook() {
  const WEBHOOK_URL = process.env.WEBHOOK_URL;
  if (!WEBHOOK_URL) {
    console.log('WEBHOOK_URL не задан — webhook не зарегистрирован');
    return;
  }
  const url = `${WEBHOOK_URL}/webhook/${TELEGRAM_TOKEN}`;
  const r = await fetch(`${TG}/setWebhook?url=${encodeURIComponent(url)}`);
  const j = await r.json();
  console.log('Webhook:', j.ok ? `✓ ${url}` : `✗ ${j.description}`);
}

app.listen(PORT, async () => {
  console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
  await setupWebhook();
});
