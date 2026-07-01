// ===========================================
// TeleCard Report Backend — deploy ke Railway
// ===========================================
const express = require('express');
const app = express();

app.use(express.json({ limit: '100kb' }));

const ALLOWED_ORIGIN = 'https://telehub.nfy.fyi';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// ── CORS: hanya izinkan dari domain TeleHub ──
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// ── Health check (buat cek Railway sudah nyala) ──
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'telecard-report-backend' });
});

// ── Endpoint utama: terima pesan, forward ke Telegram ──
app.post('/report', async (req, res) => {
  try {
    const origin = req.headers.origin || '';
    if (origin !== ALLOWED_ORIGIN) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || message.length < 5) {
      return res.status(400).json({ ok: false, error: 'Invalid payload' });
    }

    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      console.error('TG_BOT_TOKEN atau TG_CHAT_ID belum diset di environment variable');
      return res.status(500).json({ ok: false, error: 'Server misconfigured' });
    }

    const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;

    const tgRes = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    const tgJson = await tgRes.json();

    if (!tgJson.ok) {
      console.error('Telegram API error:', tgJson.description);
      return res.status(502).json({ ok: false, error: tgJson.description });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
});
