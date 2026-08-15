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

function parsePlayersFromConsole(lines) {
  const online = new Map();
  const spawnedRe = /^\[([^\]]+) INFO\]\s+Player Spawned:\s+([^,]+),/;
  const disconnectedRe = /^\[([^\]]+) INFO\]\s+Player disconnected:\s+([^,]+),/;

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    const spawn = line.match(spawnedRe);
    if (spawn) {
      const connectedAt = parseBedrockTimestamp(spawn[1]);
      if (connectedAt && !Number.isNaN(connectedAt.getTime())) {
        online.set(spawn[2].trim(), connectedAt);
      }
      continue;
    }

    const disconnect = line.match(disconnectedRe);
    if (disconnect) {
      online.delete(disconnect[2].trim());
    }
  }

  const now = Date.now();
  return Array.from(online.entries())
    .map(([name, connectedAt]) => {
      const seconds = Math.max(0, Math.floor((now - connectedAt.getTime()) / 1000));
      return {
        name,
        connectedAt: connectedAt.toISOString(),
        onlineForSeconds: seconds,
      };
    })
    .sort((a, b) => b.onlineForSeconds - a.onlineForSeconds);
}

async function fetchRecentConsoleLines(timeoutMs = 4500) {
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
    const lines = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err);
      else resolve(lines);
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
        if (line.trim()) lines.push(line.trim());
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish());
  });
}

app.get('/players-online', async (_req, res) => {
  try {
    const lines = await fetchRecentConsoleLines();
    const players = parsePlayersFromConsole(lines);
    return res.json({
      ok: true,
      fetchedLines: lines.length,
      players,
    });
  } catch (err) {
    return res.status(502).json({ error: `Unable to fetch player list: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`MC control panel running on http://localhost:${PORT}`);
});
