const express = require('express');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
const path = require('path');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────
const PANEL_URL = 'http://192.168.1.10:8080';
const API_KEY = 'ptlc_XXXXXXXXXXXXXXXXXXXX';
const SERVER_ID = '1a2b3c4d';
const PORT = 3000;
// ─────────────────────────────────────────────

const AUTH_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: 'Bearer ' + API_KEY,
};

app.use(express.static(path.join(__dirname, 'public')));

app.post('/send-command', async (req, res) => {
  const { command } = req.body;

  const allowed = ['difficulty peaceful', 'difficulty easy', 'difficulty normal', 'difficulty hard'];
  if (!allowed.includes(command)) {
    return res.status(400).json({ error: 'Command not permitted.' });
  }

  try {
    const ptero = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/command`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ command }),
    });

    if (ptero.status === 204 || ptero.ok) {
      return res.json({ ok: true });
    }

    const body = await ptero.text().catch(() => '');
    let msg = `Pterodactyl error ${ptero.status}`;
    try {
      msg = JSON.parse(body)?.errors?.[0]?.detail || msg;
    } catch {}
    return res.status(ptero.status).json({ error: msg });
  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
});

function parseBedrockTimestamp(raw) {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):(\d{3})$/);
  if (!match) return null;
  return new Date(`${match[1].replace(' ', 'T')}.${match[2]}`);
}

function parsePlayerEventFromLine(rawLine) {
  const line = String(rawLine || '').trim();
  if (!line) return null;

  const spawnedRe = /^\[([^\]]+) INFO\]\s+Player Spawned:\s+([^,]+),/;
  const disconnectedRe = /^\[([^\]]+) INFO\]\s+Player disconnected:\s+([^,]+),/;

  const spawned = line.match(spawnedRe);
  if (spawned) {
    const at = parseBedrockTimestamp(spawned[1]);
    if (!at || Number.isNaN(at.getTime())) return null;
    return {
      name: spawned[2].trim(),
      type: 'connected',
      at: at.toISOString(),
    };
  }

  const disconnected = line.match(disconnectedRe);
  if (disconnected) {
    const at = parseBedrockTimestamp(disconnected[1]);
    if (!at || Number.isNaN(at.getTime())) return null;
    return {
      name: disconnected[2].trim(),
      type: 'disconnected',
      at: at.toISOString(),
    };
  }

  return null;
}

function summarizeOnlinePlayers(events) {
  const online = new Map();

  for (const event of events) {
    if (event.type === 'connected') {
      online.set(event.name, event.at);
      continue;
    }
    if (event.type === 'disconnected') {
      online.delete(event.name);
    }
  }

  const now = Date.now();
  return Array.from(online.entries())
    .map(([name, connectedAt]) => {
      const connectedMs = new Date(connectedAt).getTime();
      const onlineForSeconds = Number.isNaN(connectedMs)
        ? 0
        : Math.max(0, Math.floor((now - connectedMs) / 1000));

      return {
        name,
        connectedAt,
        onlineForSeconds,
      };
    })
    .sort((a, b) => b.onlineForSeconds - a.onlineForSeconds);
}

async function fetchPlayerEvents(timeoutMs = 4500) {
  const wsMetaResp = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/websocket`, {
    method: 'GET',
    headers: AUTH_HEADERS,
  });

  if (!wsMetaResp.ok) {
    const body = await wsMetaResp.text().catch(() => '');
    throw new Error(`Websocket bootstrap failed (${wsMetaResp.status}): ${body || 'no response body'}`);
  }

  const wsMeta = await wsMetaResp.json();
  const socket = wsMeta?.data?.socket;
  const token = wsMeta?.data?.token;

  if (!socket || !token) {
    throw new Error('Invalid websocket metadata from Pterodactyl API.');
  }

  return await new Promise((resolve, reject) => {
    const events = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(events);
    };

    const ws = new WebSocket(socket);
    const timer = setTimeout(() => finish(), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', args: [token] }));
      ws.send(JSON.stringify({ event: 'send logs', args: [] }));
    });

    ws.on('message', (payload) => {
      let msg;
      try {
        msg = JSON.parse(payload.toString());
      } catch {
        return;
      }

      if (msg?.event !== 'console output') return;
      const chunk = Array.isArray(msg.args) ? msg.args.join('\n') : '';
      if (!chunk) return;
      for (const line of chunk.split(/\r?\n/)) {
        const event = parsePlayerEventFromLine(line);
        if (event) events.push(event);
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish());
  });
}

app.get('/players-online', async (_req, res) => {
  try {
    const events = await fetchPlayerEvents();
    const players = summarizeOnlinePlayers(events);
    return res.json({
      ok: true,
      players,
    });
  } catch (err) {
    return res.status(502).json({ error: `Unable to fetch player list: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`MC control panel running on http://localhost:${PORT}`);
});
