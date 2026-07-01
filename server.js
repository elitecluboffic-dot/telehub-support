// ===========================================
// TeleCard Report Backend — deploy ke Railway
// ===========================================
const express = require('express');
const multer  = require('multer');

const app = express();

const ALLOWED_ORIGIN = 'https://telehub.nfy.fyi';
const TG_BOT_TOKEN    = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID      = process.env.TG_CHAT_ID;

const MAX_FILE_SIZE   = 5 * 1024 * 1024; // 5MB, samain dengan batas di PHP
const ALLOWED_MIME    = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TG_CAPTION_LIMIT = 1024; // batas caption Telegram sendPhoto

// ── multer: simpan file di memory, gak ditulis ke disk ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('INVALID_MIME'));
    }
    cb(null, true);
  },
});

// ── Body parser JSON hanya untuk request tanpa file ──
app.use(express.json({ limit: '100kb' }));

// ── CORS: hanya izinkan dari domain TeleHub ──
app.use((req, res, next) => {
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

// ── Endpoint utama: terima pesan (+ gambar opsional), forward ke Telegram ──
app.post('/report', (req, res) => {
  // multer sebagai middleware manual, biar error-nya bisa kita tangani custom
  upload.single('photo')(req, res, async (err) => {
    try {
      const origin = req.headers.origin || '';
      if (origin !== ALLOWED_ORIGIN) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ ok: false, error: 'Ukuran gambar maksimal 5MB' });
        }
        if (err.message === 'INVALID_MIME') {
          return res.status(400).json({ ok: false, error: 'Format gambar tidak didukung' });
        }
        console.error('Upload error:', err);
        return res.status(400).json({ ok: false, error: 'Gagal memproses gambar' });
      }

      if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        console.error('TG_BOT_TOKEN atau TG_CHAT_ID belum diset di environment variable');
        return res.status(500).json({ ok: false, error: 'Server misconfigured' });
      }

      const message = req.body?.message;
      if (!message || typeof message !== 'string' || message.length < 5) {
        return res.status(400).json({ ok: false, error: 'Invalid payload' });
      }

      const file = req.file; // ada isinya kalau PHP kirim multipart dengan field 'photo'

      let tgResult;
      if (file) {
        tgResult = await sendTelegramPhoto(file, message);
      } else {
        tgResult = await sendTelegramMessage(message);
      }

      if (!tgResult.ok) {
        console.error('Telegram API error:', tgResult.error);
        return res.status(502).json({ ok: false, error: tgResult.error });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('Unexpected error:', e);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });
});

// ── Kirim pesan teks biasa ──
async function sendTelegramMessage(text) {
  const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    return { ok: false, error: tgJson.description };
  }
  return { ok: true };
}

// ── Kirim foto + caption. Kalau teks lebih panjang dari limit caption Telegram,
//    kirim foto dengan caption terpotong, lalu kirim sisanya sebagai pesan terpisah ──
async function sendTelegramPhoto(file, text) {
  const tgUrl = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;

  let caption = text;
  let overflow = null;

  if (text.length > TG_CAPTION_LIMIT) {
    caption  = text.slice(0, TG_CAPTION_LIMIT - 40) + '\n\n_(bersambung di pesan berikutnya)_';
    overflow = text;
  }

  const form = new FormData();
  form.append('chat_id', TG_CHAT_ID);
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  form.append('photo', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'report.jpg');

  const tgRes = await fetch(tgUrl, {
    method: 'POST',
    body: form,
  });
  const tgJson = await tgRes.json();

  if (!tgJson.ok) {
    return { ok: false, error: tgJson.description };
  }

  // Kirim teks lengkap sebagai pesan susulan kalau tadi kepotong
  if (overflow) {
    await sendTelegramMessage('📄 *Detail lengkap laporan (lanjutan):*\n\n' + overflow);
  }

  return { ok: true };
}

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
});
