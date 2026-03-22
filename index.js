const express = require("express");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let blocked405 = false;
let retryCount = 0;
let lastError = null;
let lastIncomingMessage = null;
let lastWebhookResult = null;
let webhookUrl = process.env.WEBHOOK_URL || process.env.SUPABASE_WEBHOOK_URL || null;

const logger = pino({ level: "silent" });

// ── Extrair texto de qualquer tipo de mensagem Baileys ──
function extractMessageText(message) {
  if (!message) return null;

  // Unwrap ephemeral / viewOnce
  const containers = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2"];
  for (const key of containers) {
    if (message[key]?.message) return extractMessageText(message[key].message);
  }

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    message.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("[WhatsApp] QR code generated - scan at /qr");
      qrCodeData = await QRCode.toDataURL(qr);
      isConnected = false;
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      lastError = `Status ${statusCode}`;
      console.log(`[WhatsApp] Connection closed. Status: ${statusCode}`);

      if (statusCode === 405) {
        retryCount++;
        if (retryCount >= 3) {
          blocked405 = true;
          console.log("[WhatsApp] Blocked after 3x 405. Manual /reset-json required.");
          return;
        }
        console.log(`[WhatsApp] 405 — retry ${retryCount}/3 in 60s`);
        setTimeout(connectToWhatsApp, 60000);
      } else if (statusCode !== DisconnectReason.loggedOut) {
        retryCount = 0;
        setTimeout(connectToWhatsApp, 5000);
      } else {
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
        retryCount = 0;
        setTimeout(connectToWhatsApp, 5000);
      }
    }

    if (connection === "open") {
      console.log("[WhatsApp] Connected!");
      isConnected = true;
      blocked405 = false;
      retryCount = 0;
      lastError = null;
      qrCodeData = null;
      connectedPhone = sock.user?.id?.split(":")[0] || null;
    }
  });

  // ── LISTENER DE MENSAGENS RECEBIDAS ──
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const from = msg.key.remoteJid || "";
      const text = extractMessageText(msg.message);

      console.log(`[Incoming] From: ${from} | Text: ${text || "(no text)"}`);

      if (!text) continue; // Ignora mensagens sem texto (stickers, áudio sem caption, etc.)

      lastIncomingMessage = { from, text, at: new Date().toISOString() };

      if (!webhookUrl) {
        console.log("[Webhook] Not configured. Message ignored.");
        continue;
      }

      // Enviar para o webhook com o payload completo
      const payload = {
        from,
        message: text,
        phone: from.replace(/@s\.whatsapp\.net$/, "").replace(/\D/g, ""),
        messages: [{ key: msg.key, message: msg.message }],
      };

      try {
        const resp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await resp.text();
        lastWebhookResult = { status: resp.status, body: data, at: new Date().toISOString() };
        console.log(`[Webhook] Sent OK (${resp.status})`);
      } catch (err) {
        lastWebhookResult = { error: err.message, at: new Date().toISOString() };
        console.error("[Webhook] Error:", err.message);
      }
    }
  });
}

// ── ROTAS ──

app.get("/", (req, res) => res.json({ service: "WhatsApp Baileys Bridge", connected: isConnected }));

app.get("/health", (req, res) => res.send("OK"));

app.get("/health-json", (req, res) => {
  res.json({
    connected: isConnected,
    phone: connectedPhone,
    blocked405,
    retryCount,
    lastError,
    webhookConfigured: !!webhookUrl,
    webhookUrl,
    lastIncomingMessage,
    lastWebhookResult,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) return res.send(`<h2>Connected: ${connectedPhone}</h2>`);
  if (qrCodeData) return res.send(`<img src="${qrCodeData}" />`);
  res.send("<h2>Waiting for QR...</h2>");
});

app.get("/qr-json", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (isConnected) return res.json({ connected: true, phone: connectedPhone });
  if (qrCodeData) return res.json({ qr: qrCodeData });
  res.json({ connected: false, qr: null });
});

app.get("/status", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({ connected: isConnected, phone: connectedPhone, blocked405, retryCount, lastError });
});

app.get("/reset-json", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (sock) try { sock.end(); } catch (_) {}
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  blocked405 = false;
  retryCount = 0;
  lastError = null;
  connectToWhatsApp();
  res.json({ success: true, message: "Session reset. Check /qr-json" });
});

app.post("/set-webhook", (req, res) => {
  const { webhookUrl: url } = req.body;
  if (!url) return res.status(400).json({ error: "webhookUrl required" });
  webhookUrl = url;
  console.log(`[Config] Webhook set: ${webhookUrl}`);
  res.json({ success: true, webhookUrl });
});

app.post("/send-whatsapp", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "Missing phone or message" });
  if (!isConnected || !sock) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = phone.includes("@") ? phone : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: "Missing to or message" });
  if (!isConnected || !sock) return res.status(503).json({ error: "Not connected" });
  try {
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START ──
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] Webhook URL: ${webhookUrl || "NOT SET"}`);
  connectToWhatsApp();
});
