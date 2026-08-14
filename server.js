// ─────────────────────────────────────────────
//  MC Difficulty Proxy  –  server.js
//  npm install express node-fetch
//  node server.js
// ─────────────────────────────────────────────

const express  = require('express');
const fetch    = (...a) => import('node-fetch').then(({default: f}) => f(...a));
const path     = require('path');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────
const PANEL_URL  = 'http://192.168.1.10:8080';   // ← internal Pterodactyl address
const API_KEY    = 'ptlc_XXXXXXXXXXXXXXXXXXXX';   // ← your client API key
const SERVER_ID  = '1a2b3c4d';                    // ← your server identifier
const PORT       = 3000;                           // ← port this proxy listens on
// ─────────────────────────────────────────────

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint – browser calls this
app.post('/send-command', async (req, res) => {
  const { command } = req.body;

  const allowed = ['difficulty peaceful', 'difficulty easy', 'difficulty normal', 'difficulty hard'];
  if (!allowed.includes(command)) {
    return res.status(400).json({ error: 'Command not permitted.' });
  }

  try {
    const ptero = await fetch(
      `${PANEL_URL}/api/client/servers/${SERVER_ID}/command`,
      {
        method:  'POST',
        headers: {
          'Accept':        'application/json',
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ command }),
      }
    );

    if (ptero.status === 204 || ptero.ok) {
      return res.json({ ok: true });
    }

    const body = await ptero.text().catch(() => '');
    let msg = `Pterodactyl error ${ptero.status}`;
    try { msg = JSON.parse(body)?.errors?.[0]?.detail || msg; } catch {}
    return res.status(ptero.status).json({ error: msg });

  } catch (err) {
    return res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`MC Difficulty proxy running on http://localhost:${PORT}`);
});
