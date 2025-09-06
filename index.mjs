// index.mjs
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';
import * as baileys from '@whiskeysockets/baileys';

const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = baileys;

// ====== Setup dasar ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = process.env.AUTH_ROOT || path.join(__dirname, 'auth_info');

fs.mkdirSync(AUTH_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Opsional: serve file statis (taruh index.html di ./public)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// ====== Registry Sesi ======
/**
 * sessions: Map<string, {
 *   sock: WASocket,
 *   isConnected: boolean,
 *   saveCreds: Function,
 *   lastQR: string | null,
 * }>
 */
const sessions = new Map();

// Helper: buat JID dari nomor
const toJid = (number) => {
  const n = String(number).trim();
  return n.includes('@s.whatsapp.net') ? n : `${n.replace(/[^\d+]/g, '')}@s.whatsapp.net`;
};

// Helper: generate PNG base64 dari string QR
async function qrPngBase64(qrString) {
  if (!qrString) return null;
  const dataUrl = await QRCode.toDataURL(qrString, { width: 512, margin: 1 });
  // dataUrl format: data:image/png;base64,XXXX...
  return dataUrl.split(',')[1] || null;
}

// ====== Lifecycle Sesi ======
async function startSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const authPath = path.join(AUTH_ROOT, sessionId);
  fs.mkdirSync(authPath, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // QR juga muncul di terminal (opsional)
    browser: Browsers.ubuntu('Baileys-MD'),
    // markOnlineOnConnect: false, // opsional: hemat presence
  });

  const session = { sock, isConnected: false, saveCreds, lastQR: null };
  sessions.set(sessionId, session);

  // Events
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.lastQR = qr; // simpan string QR; UI minta PNG base64 via endpoint
      updateSessionStatus(sessionId, { hasQR: true });
    }

    if (connection === 'close') {
      session.isConnected = false;
      // cek apakah perlu reconnect
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      updateSessionStatus(sessionId, { isConnected: false, hasQR: false });
      console.log(`[${sessionId}] connection closed. code=${statusCode} reconnect=${shouldReconnect}`);

      if (shouldReconnect) {
        // Re-start session (hati2: async dan replace reference)
        setTimeout(async () => {
          try {
            await startSession(sessionId);
          } catch (e) {
            console.error(`[${sessionId}] failed to restart:`, e);
          }
        }, 1000);
      } else {
        // loggedOut → perlu scan ulang; biarkan sesi tetap ada dengan lastQR null
        session.lastQR = null;
      }
    } else if (connection === 'open') {
      session.isConnected = true;
      session.lastQR = null;
      updateSessionStatus(sessionId, { isConnected: true, hasQR: false });
      console.log(`[${sessionId}] ✅ connected`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  return session;
}

async function stopAndDeleteSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return false;

  try {
    await s.sock.logout().catch(() => {});
    if (s.sock?.end) s.sock.end();
  } catch (e) {
    console.warn(`[${sessionId}] logout/end error:`, e?.message || e);
  }

  sessions.delete(sessionId);
  // Opsional: hapus folder auth (hati-hati, biasanya dibiarkan agar bisa relogin cepat)
  // fs.rmSync(path.join(AUTH_ROOT, sessionId), { recursive: true, force: true });

  console.log(`[${sessionId}] deleted`);
  return true;
}

// ====== Endpoint API ======

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// List sessions
app.get('/sessions', (req, res) => {
  const list = [...sessions.entries()].map(([id, s]) => ({
    sessionId: id,
    isConnected: s.isConnected,
    hasQR: !!s.lastQR,
  }));
  res.json(list);
});

// Create/start a session
app.post('/sessions', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || !String(sessionId).trim()) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  try {
    const s = await startSession(String(sessionId).trim());
    res.json({ status: sessions.has(sessionId) ? 'ok' : 'created', sessionId });
  } catch (e) {
    console.error('create session error:', e);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Get QR (PNG base64) for a session
app.get('/sessions/:id/qr', async (req, res) => {
  const sessionId = req.params.id;
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  if (s.isConnected) {
    return res.json({ qr: null, message: 'connected' });
  }

  // jika ada QR string → render jadi PNG base64
  const png = await qrPngBase64(s.lastQR);
  if (png) {
    return res.json({ qr: png, message: 'scan' });
  } else {
    return res.json({ qr: null, message: 'no-qr' });
  }
});

// Delete (logout) a session
app.delete('/sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  const ok = await stopAndDeleteSession(sessionId);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: 'deleted', sessionId });
});

// Send message via a session
app.post('/send-message', async (req, res) => {
  const { sessionId, number, message } = req.body || {};

  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!number || !message) return res.status(400).json({ error: 'Missing number or message' });

  const s = sessions.get(sessionId);
  if (!s || !s.isConnected) {
    return res.status(503).json({ error: 'Session not connected' });
  }

  const jid = toJid(number);

  try {
    await s.sock.sendMessage(jid, { text: String(message) });
    res.json({ status: 'sent', sessionId, to: number });
  } catch (err) {
    console.error(`[${sessionId}] send error:`, err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// ====== SSE clients store ======
const sseClients = new Set();

app.get('/events', (req, res) => {
  // set header SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // tambahkan client ke set
  sseClients.add(res);

  // kirim snapshot awal
  pushSessions();

  // bersihkan saat koneksi putus
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// helper untuk broadcast state
function pushSessions() {
  const list = [...sessions.entries()].map(([sessionId, s]) => ({
    sessionId,
    isConnected: s.isConnected,
    hasQR: s.hasQR,
  }));

  const data = `event: sessions\ndata: ${JSON.stringify(list)}\n\n`;

  for (const client of sseClients) {
    client.write(data);
  }
}

// contoh: panggil pushSessions tiap kali ada perubahan
function updateSessionStatus(sessionId, { isConnected, hasQR }) {
  const s = sessions.get(sessionId) || {};
  s.isConnected = isConnected ?? s.isConnected;
  s.hasQR = hasQR ?? s.hasQR;
  sessions.set(sessionId, s);

  pushSessions(); // broadcast ke semua klien SSE
}

// ====== Start server ======
app.listen(PORT, () => {
  console.log(`🚀 API ready on http://localhost:${PORT}`);
  console.log(`   Static (optional): ${fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : '(none)'}`);
});

// ====== Graceful shutdown ======
const shutdown = async () => {
  console.log('\nShutting down...');
  for (const id of [...sessions.keys()]) {
    try { await stopAndDeleteSession(id); } catch {}
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
