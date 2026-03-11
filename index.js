const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const AUTH_DIR = path.join(__dirname, 'auth_info');
let sock = null;
let qrCode = null;
let isConnected = false;
let retryCount = 0;
const MAX_RETRIES = 5;

function clearAuthInfo() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('Auth info cleared');
    }
  } catch (e) {
    console.error('Error clearing auth info:', e.message);
  }
}

async function startSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      browser: ['Chrome (Linux)', 'Chrome', '120.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrCode = qr;
        isConnected = false;
        console.log('New QR code generated');
      }
      if (connection === 'close') {
        isConnected = false;
        qrCode = null;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log('Connection closed. Status:', statusCode);
        if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
          console.log('Logged out or 405. Clearing session...');
          clearAuthInfo();
          retryCount = 0;
          setTimeout(startSocket, 10000);
        } else if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = retryCount * 10000;
          console.log('Reconnecting in ' + (delay/1000) + 's (attempt ' + retryCount + ')');
          setTimeout(startSocket, delay);
        } else {
          console.log('Max retries reached. Use /reset to restart.');
        }
      }
      if (connection === 'open') {
        isConnected = true;
        qrCode = null;
        retryCount = 0;
        console.log('WhatsApp connected!');
      }
    });
  } catch (err) {
    console.error('Error starting socket:', err.message);
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      setTimeout(startSocket, retryCount * 10000);
    }
  }
}

app.get('/qr', async (req, res) => {
  if (isConnected) {
    res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#0f0;margin:0"><h1 style="font-family:sans-serif">WhatsApp Conectado!</h1></body></html>');
  } else if (qrCode) {
    try {
      const qrImage = await QRCode.toDataURL(qrCode);
      res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;margin:0;flex-direction:column"><h2 style="font-family:sans-serif">Escaneie o QR Code</h2><img src="' + qrImage + '" style="width:300px;height:300px"/><script>setTimeout(function(){location.reload()},15000)</script></body></html>');
    } catch (e) {
      res.status(500).send('Erro ao gerar QR: ' + e.message);
    }
  } else {
    res.send('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#111;color:#fff;margin:0;flex-direction:column"><h2 style="font-family:sans-serif">Aguardando QR code...</h2><script>setTimeout(function(){location.reload()},5000)</script></body></html>');
  }
});

app.get('/reset', async (req, res) => {
  clearAuthInfo();
  retryCount = 0;
  if (sock) { try { sock.end(); } catch(e) {} }
  setTimeout(startSocket, 3000);
  res.json({ status: 'reset', message: 'Session cleared. Restarting...' });
});

app.get('/health', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCode, retries: retryCount });
});

app.post('/send', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message required' });
    }
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  startSocket();
});
