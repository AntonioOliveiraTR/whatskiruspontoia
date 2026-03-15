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

const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_info");

let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectedPhone = null;
let webhookUrl = process.env.WEBHOOK_URL || null;
let reconnectAttempts = 0;

const logger = pino({ level: "silent" });

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 QR Code gerado");
      qrCodeData = await QRCode.toDataURL(qr);
      isConnected = false;
      reconnectAttempts = 0;
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode =
        lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      reconnectAttempts++;
      const delay = Math.min(5000 * reconnectAttempts, 60000);

      console.log(
        `❌ Conexão fechada. Status: ${statusCode}. Reconectando em ${delay / 1000}s (tentativa ${reconnectAttempts})`
      );

      if (shouldReconnect) {
        setTimeout(startSock, delay);
      } else {
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true });
        }
        qrCodeData = null;
        reconnectAttempts = 0;
        setTimeout(startSock, 5000);
      }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp conectado!");
      isConnected = true;
      qrCodeData = null;
      reconnectAttempts = 0;
      connectedPhone = sock.user?.id?.split(":")[0] || null;
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;

      const from = msg.key.remoteJid?.replace("@s.whatsapp.net", "") || "";
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text || !from) continue;

      console.log(`📩 Mensagem de ${from}: ${text}`);

      if (webhookUrl) {
        try {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, message: text }),
          });
          const data = await resp.json();
          console.log(`📤 Webhook respondeu:`, data);
        } catch (err) {
          console.error("❌ Erro ao enviar para webhook:", err.message);
        }
      } else {
        console.log("⚠️ Webhook não configurado. Mensagem ignorada.");
      }
    }
  });
}

// ==================== ROTAS ====================

app.get("/", (req, res) => {
  res.json({
    service: "WhatsApp Baileys Server",
    connected: isConnected,
    phone: connectedPhone,
    webhookConfigured: !!webhookUrl,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, phone: connectedPhone });
  }
  if (qrCodeData) {
    return res.json({ qr: qrCodeData });
  }
  res.json({ connected: false, qr: null, message: "Aguardando QR Code..." });
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    status: isConnected ? "connected" : "disconnected",
    phone: connectedPhone,
    webhookUrl: webhookUrl,
  });
});

app.post("/set-webhook", (req, res) => {
  const { webhookUrl: url } = req.body;
  if (!url) return res.status(400).json({ error: "webhookUrl is required" });
  webhookUrl = url;
  console.log(`🔗 Webhook configurado: ${webhookUrl}`);
  res.json({ success: true, webhookUrl });
});

app.post("/send", async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ error: "Missing 'to' or 'message'" });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📤 Mensagem enviada para ${jid}`);
    res.json({ success: true, to: jid });
  } catch (err) {
    console.error("❌ Erro ao enviar mensagem:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/disconnect", async (req, res) => {
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    isConnected = false;
    connectedPhone = null;
    qrCodeData = null;
  }
  res.json({ success: true, message: "Disconnected" });
});

app.post("/reconnect", async (req, res) => {
  if (sock) {
    try { sock.end(); } catch (e) {}
  }
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true });
  }
  isConnected = false;
  connectedPhone = null;
  qrCodeData = null;
  reconnectAttempts = 0;
  startSock();
  res.json({ success: true, message: "Reconnecting... Check /qr for QR code" });
});

// ==================== START ====================

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  startSock();
});
