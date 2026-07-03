// ===========================================
// TeleCard Report Backend — Cloudflare Worker
// Rewrite dari server.js (Express + Multer di Railway)
// ===========================================

const ALLOWED_ORIGIN = 'https://telehub.nfy.fyi';

const MAX_FILE_SIZE    = 5 * 1024 * 1024; // 5MB, samain dengan batas di PHP
const ALLOWED_MIME     = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TG_CAPTION_LIMIT = 1024; // batas caption Telegram sendPhoto

// ── Helper: bikin headers CORS, dipakai di semua response ──
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Helper: response JSON + CORS headers sekaligus ──
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

// ── Kirim pesan teks biasa ke Telegram ──
async function sendTelegramMessage(env, text) {
  const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;
  const tgRes = await fetch(tgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TG_CHAT_ID,
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
async function sendTelegramPhoto(env, file, text) {
  const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`;

  let caption  = text;
  let overflow = null;

  if (text.length > TG_CAPTION_LIMIT) {
    caption  = text.slice(0, TG_CAPTION_LIMIT - 40) + '\n\n_(bersambung di pesan berikutnya)_';
    overflow = text;
  }

  const form = new FormData();
  form.append('chat_id', env.TG_CHAT_ID);
  form.append('caption', caption);
  form.append('parse_mode', 'Markdown');
  // 'file' di sini adalah objek File/Blob langsung dari request.formData(),
  // Workers native support File/Blob jadi tidak perlu Buffer/multer sama sekali.
  form.append('photo', file, file.name || 'report.jpg');

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
    await sendTelegramMessage(env, '📄 *Detail lengkap laporan (lanjutan):*\n\n' + overflow);
  }

  return { ok: true };
}

// ── Handler utama endpoint /report ──
async function handleReport(request, env) {
  const origin = request.headers.get('origin') || '';
  if (origin !== ALLOWED_ORIGIN) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) {
    console.error('TG_BOT_TOKEN atau TG_CHAT_ID belum diset di environment variable / secret');
    return json({ ok: false, error: 'Server misconfigured' }, 500);
  }

  const contentType = request.headers.get('content-type') || '';

  let message = null;
  let file    = null;

  try {
    if (contentType.includes('multipart/form-data')) {
      // ── Ada kemungkinan file: parse pakai FormData native Workers ──
      const formData = await request.formData();
      message = formData.get('message');

      const photo = formData.get('photo');
      // formData.get() balikin File kalau field-nya berupa file upload,
      // dan balikin string kalau field text biasa / kosong.
      if (photo && typeof photo !== 'string') {
        file = photo;
      }
    } else if (contentType.includes('application/json')) {
      // ── Tanpa file: body JSON biasa ──
      const body = await request.json();
      message = body?.message;
    } else {
      return json({ ok: false, error: 'Unsupported content type' }, 400);
    }
  } catch (e) {
    console.error('Parse error:', e);
    return json({ ok: false, error: 'Gagal memproses request' }, 400);
  }

  // ── Validasi message ──
  if (!message || typeof message !== 'string' || message.length < 5) {
    return json({ ok: false, error: 'Invalid payload' }, 400);
  }

  // ── Validasi file kalau ada ──
  if (file) {
    if (!ALLOWED_MIME.includes(file.type)) {
      return json({ ok: false, error: 'Format gambar tidak didukung' }, 400);
    }
    if (file.size > MAX_FILE_SIZE) {
      return json({ ok: false, error: 'Ukuran gambar maksimal 5MB' }, 400);
    }
  }

  let tgResult;
  try {
    tgResult = file
      ? await sendTelegramPhoto(env, file, message)
      : await sendTelegramMessage(env, message);
  } catch (e) {
    console.error('Unexpected error saat kirim ke Telegram:', e);
    return json({ ok: false, error: 'Internal server error' }, 500);
  }

  if (!tgResult.ok) {
    console.error('Telegram API error:', tgResult.error);
    return json({ ok: false, error: tgResult.error }, 502);
  }

  return json({ ok: true }, 200);
}

// ── Entry point Worker ──
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    // ── Preflight CORS ──
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Health check (buat cek Worker sudah nyala) ──
    if (method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'telecard-report-backend' });
    }

    // ── Endpoint utama ──
    if (method === 'POST' && url.pathname === '/report') {
      return handleReport(request, env);
    }

    // ── 404 handler ──
    return json({ ok: false, error: 'Not found' }, 404);
  },
};
