/* Node bridge server (renamed bridge.js)
 * - Connects to C TCP server at localhost:8080
 * - Exposes WebSocket server on port 3001 for frontend
 * - Forwards server events to connected browser clients and accepts actions
 */

// single import and config
const net = require('net');
const tls = require('tls');
const WebSocket = require('ws');

const TARGET_HOST = process.env.C_SERVER_HOST || '127.0.0.1';
const TARGET_PORT = process.env.C_SERVER_PORT ? parseInt(process.env.C_SERVER_PORT) : 8080;
const WS_PORT = process.env.BRIDGE_WS_PORT ? parseInt(process.env.BRIDGE_WS_PORT) : 3001;
const C_SERVER_TLS = (process.env.C_SERVER_TLS === '1' || process.env.C_SERVER_TLS === 'true') || TARGET_PORT === 8443;
const C_SERVER_TLS_INSECURE = (process.env.C_SERVER_TLS_INSECURE === '1' || process.env.C_SERVER_TLS_INSECURE === 'true');

console.log('[bridge] Starting Node bridge - will connect to', TARGET_HOST + ':' + TARGET_PORT);

// Map of simulated clients: clientId -> socket
const simulatedClients = {};

// Setup SQLite persistence for polls/votes
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'polls.db');
const db = new sqlite3.Database(DB_PATH);

function ensureSchema() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, question TEXT, createdAt TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS choices (pollId TEXT, id TEXT, label TEXT, PRIMARY KEY(pollId,id))`);
    db.run(`CREATE TABLE IF NOT EXISTS votes (pollId TEXT, userId TEXT, choiceId TEXT, createdAt TEXT, PRIMARY KEY(pollId,userId))`);
  });
}

function seedIfEmpty() {
  db.get(`SELECT COUNT(1) AS c FROM polls`, (err, row) => {
    if (err) return console.error('db count error', err.message);
    if (row && row.c === 0) {
      const pollId = 'poll-1';
      const createdAt = new Date().toISOString();
      db.run(`INSERT INTO polls (id,question,createdAt) VALUES (?,?,?)`, [pollId, 'Which programming language do you prefer?', createdAt]);
      const choices = [ ['c','C'], ['rust','Rust'], ['go','Go'], ['python','Python'] ];
      const stmt = db.prepare(`INSERT INTO choices (pollId,id,label) VALUES (?,?,?)`);
      choices.forEach(c => stmt.run(pollId, c[0], c[1]));
      stmt.finalize();
    }
  });
}

function getAllPolls(cb) {
  db.all(`SELECT id,question,createdAt FROM polls`, (err, rows) => {
    if (err) return cb(err);
    if (!rows || rows.length === 0) return cb(null, []);
    const polls = [];
    let remaining = rows.length;
    rows.forEach(r => {
      db.all(`SELECT id,label FROM choices WHERE pollId = ?`, [r.id], (err2, choices) => {
        if (err2) return cb(err2);
        db.all(`SELECT choiceId,COUNT(1) AS cnt FROM votes WHERE pollId = ? GROUP BY choiceId`, [r.id], (err3, countsRows) => {
          if (err3) return cb(err3);
          const counts = {};
          (countsRows || []).forEach(cr => counts[cr.choiceId] = cr.cnt);
          polls.push({ id: r.id, question: r.question, choices: choices || [], counts, createdAt: r.createdAt });
          remaining -= 1;
          if (remaining === 0) cb(null, polls);
        });
      });
    });
  });
}

function getUserVotes(userId, cb) {
  db.all(`SELECT pollId,choiceId FROM votes WHERE userId = ?`, [userId], (err, rows) => {
    if (err) return cb(err);
    const m = {};
    (rows || []).forEach(r => m[r.pollId] = r.choiceId);
    cb(null, m);
  });
}

function getPollCounts(pollId, cb) {
  db.all(`SELECT choiceId,COUNT(1) AS cnt FROM votes WHERE pollId = ? GROUP BY choiceId`, [pollId], (err, rows) => {
    if (err) return cb(err);
    const counts = {};
    (rows || []).forEach(r => counts[r.choiceId] = r.cnt);
    cb(null, counts);
  });
}

ensureSchema();
seedIfEmpty();

// WebSocket server for frontend
const wss = new WebSocket.Server({ port: WS_PORT }, () => {
  console.log('[bridge] WebSocket bridge listening on port', WS_PORT);
});

function broadcast(obj) {
  const json = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  });
}

function createSimulatedClient(clientId) {
  if (simulatedClients[clientId]) return;
  let s;
  if (C_SERVER_TLS) {
    const opts = { host: TARGET_HOST, port: TARGET_PORT, rejectUnauthorized: !C_SERVER_TLS_INSECURE };
    s = tls.connect(opts, () => {
      broadcast({ type: 'CLIENT_CONNECTED', clientId, tls: true, timestamp: new Date().toISOString() });
      console.log('[bridge] simulated TLS client connected', clientId);
    });
  } else {
    s = new net.Socket();
    s.connect(TARGET_PORT, TARGET_HOST, () => {
      broadcast({ type: 'CLIENT_CONNECTED', clientId, timestamp: new Date().toISOString() });
      console.log('[bridge] simulated client connected', clientId);
    });
  }
  simulatedClients[clientId] = s;

  s.on('data', (data) => {
    const msg = data.toString('utf8');
    broadcast({ type: 'DATA_RECEIVED', clientId, data: msg, bytes: data.length, timestamp: new Date().toISOString() });
  });

  s.on('end', () => {
    broadcast({ type: 'CLIENT_DISCONNECTED', clientId, timestamp: new Date().toISOString() });
    delete simulatedClients[clientId];
    console.log('[bridge] simulated client ended', clientId);
  });

  s.on('error', (err) => {
    broadcast({ type: 'CLIENT_ERROR', clientId, message: err.message, timestamp: new Date().toISOString() });
    try { s.destroy(); } catch (e) {}
    delete simulatedClients[clientId];
    console.error('[bridge] simulated client error', clientId, err.message);
  });
}

function destroySimulatedClient(clientId) {
  const s = simulatedClients[clientId];
  if (!s) return;
  try { s.end(); s.destroy(); } catch (e) {}
  delete simulatedClients[clientId];
  broadcast({ type: 'CLIENT_DISCONNECTED', clientId, timestamp: new Date().toISOString() });
}

// Lightweight HTTP API server so the frontend (or external tools) can manage clients
const http = require('http');
const API_PORT = process.env.BRIDGE_API_PORT ? parseInt(process.env.BRIDGE_API_PORT) : 3002;

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  // Allow cross-origin requests from the dev frontend (Vite) and any other origin.
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const apiServer = http.createServer((req, res) => {
  // basic CORS preflight handling so browser dev server can call the bridge API
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '600'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  // always expose CORS header on responses
  try { res.setHeader('Access-Control-Allow-Origin', '*') } catch (e) {}
  // POST /client -> { clientId? }
  if (req.method === 'POST' && url.pathname === '/client') {
    let buf = '';
    req.on('data', (c) => buf += c.toString());
    req.on('end', () => {
      try {
        const data = buf ? JSON.parse(buf) : {};
        const clientId = data.clientId || `client-${Date.now()}`;
        createSimulatedClient(clientId);
        sendJson(res, 201, { ok: true, clientId });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
    });
    return;
  }

  // DELETE /client/:id
  if (req.method === 'DELETE' && url.pathname.startsWith('/client/')) {
    const clientId = url.pathname.split('/').pop();
    destroySimulatedClient(clientId);
    sendJson(res, 200, { ok: true, clientId });
    return;
  }

  // GET /clients -> list known simulated clients
  if (req.method === 'GET' && url.pathname === '/clients') {
    sendJson(res, 200, { clients: Object.keys(simulatedClients) });
    return;
  }

  // Polls API (in-memory prototype)
  // GET /polls -> list polls
  if (req.method === 'GET' && url.pathname === '/polls') {
    const userId = url.searchParams.get('userId') || null;
    getAllPolls((err, p) => {
      if (err) return sendJson(res, 500, { ok: false, error: err.message });
      if (!userId) return sendJson(res, 200, { polls: p });
      getUserVotes(userId, (err2, votesMap) => {
        if (err2) return sendJson(res, 500, { ok: false, error: err2.message });
        const annotated = p.map(pl => ({ ...pl, userVote: votesMap[pl.id] || null }));
        return sendJson(res, 200, { polls: annotated });
      });
    });
    return;
  }

  // POST /polls -> create a new poll with choices: { question, choices: [{id,label}] or choices: ['A','B'] }
  if (req.method === 'POST' && url.pathname === '/polls') {
    let buf = '';
    req.on('data', (c) => (buf += c.toString()));
    req.on('end', () => {
      try {
        const data = JSON.parse(buf || '{}');
        const question = data.question;
        let choices = data.choices || [];
        if (!question) return sendJson(res, 400, { ok: false, error: 'missing question' });
        if (!Array.isArray(choices)) return sendJson(res, 400, { ok: false, error: 'choices must be array' });
        const pollId = data.id || `poll-${Date.now()}`;
        const createdAt = new Date().toISOString();
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          db.run(`INSERT INTO polls (id,question,createdAt) VALUES (?,?,?)`, [pollId, question, createdAt], function (err) {
            if (err) { db.run('ROLLBACK'); return sendJson(res, 500, { ok: false, error: err.message }); }
            const stmt = db.prepare(`INSERT INTO choices (pollId,id,label) VALUES (?,?,?)`);
            // accept simple array of strings
            const normalized = choices.map((c, idx) => {
              if (typeof c === 'string') return { id: `opt-${idx}`, label: c };
              return { id: c.id || `opt-${idx}`, label: c.label || String(c.id || idx) };
            });
            normalized.forEach(c => stmt.run(pollId, c.id, c.label));
            stmt.finalize(() => {
              db.run('COMMIT');
              const poll = { id: pollId, question, choices: normalized, counts: {}, createdAt };
              // broadcast new poll to frontends
              broadcast({ type: 'NEW_POLL', poll, timestamp: new Date().toISOString() });
              return sendJson(res, 201, { ok: true, poll });
            });
          });
        });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
    });
    return;
  }

  // POST /polls/:id/vote -> { userId, choiceId }
  if (req.method === 'POST' && url.pathname.startsWith('/polls/') && url.pathname.endsWith('/vote')) {
    const parts = url.pathname.split('/');
    const pollId = parts[2];
    let buf = '';
    req.on('data', (c) => (buf += c.toString()));
    req.on('end', () => {
      try {
        const data = JSON.parse(buf || '{}');
        const userId = data.userId || data.token || 'anon';
        const choiceId = data.choiceId;
        if (!choiceId) return sendJson(res, 400, { ok: false, error: 'missing choiceId' });
        // insert vote transactionally
        const createdAt = new Date().toISOString();
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          db.get(`SELECT 1 FROM polls WHERE id = ?`, [pollId], (err0, r0) => {
            if (err0) { db.run('ROLLBACK'); return sendJson(res, 500, { ok: false, error: err0.message }); }
            if (!r0) { db.run('ROLLBACK'); return sendJson(res, 404, { ok: false, error: 'no poll' }); }
            db.get(`SELECT 1 FROM votes WHERE pollId = ? AND userId = ?`, [pollId, userId], (err1, r1) => {
              if (err1) { db.run('ROLLBACK'); return sendJson(res, 500, { ok: false, error: err1.message }); }
              if (r1) { db.run('ROLLBACK'); return sendJson(res, 403, { ok: false, error: 'already voted' }); }
              db.run(`INSERT INTO votes (pollId,userId,choiceId,createdAt) VALUES (?,?,?,?)`, [pollId, userId, choiceId, createdAt], function (err2) {
                if (err2) { db.run('ROLLBACK'); return sendJson(res, 500, { ok: false, error: err2.message }); }
                db.run('COMMIT');
                // compute counts and broadcast
                getPollCounts(pollId, (errc, counts) => {
                  if (errc) return sendJson(res, 500, { ok: false, error: errc.message });
                  const payload = { type: 'POLL_UPDATE', pollId, counts, change: { choiceId, delta: 1 }, timestamp: new Date().toISOString() };
                  // also emit a log-like event so server UI and clients can show the command
                  const logPayload = { type: 'LOG', level: 'INFO', subtype: 'VOTE', clientId: userId, message: `VOTE ${pollId} ${choiceId}`, timestamp: new Date().toISOString() };
                  broadcast(payload);
                  broadcast(logPayload);
                  // return updated poll
                  db.all(`SELECT id,label FROM choices WHERE pollId = ?`, [pollId], (err3, choices) => {
                    if (err3) return sendJson(res, 500, { ok: false, error: err3.message });
                    const poll = { id: pollId, choices: choices || [], counts, createdAt };
                    return sendJson(res, 200, { ok: true, poll });
                  });
                });
              });
            });
          });
        });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: 'invalid json' });
      }
    });
    return;
  }

  // GET /server/status -> bridge/server info
  if (req.method === 'GET' && url.pathname === '/server/status') {
    sendJson(res, 200, { target: `${TARGET_HOST}:${TARGET_PORT}`, simulatedClients: Object.keys(simulatedClients).length });
    return;
  }

  // GET /polls/:id/votes -> list votes (userId, choiceId)
  if (req.method === 'GET' && url.pathname.startsWith('/polls/') && url.pathname.endsWith('/votes')) {
    const parts = url.pathname.split('/');
    const pollId = parts[2];
    db.all(`SELECT userId,choiceId,createdAt FROM votes WHERE pollId = ?`, [pollId], (err, rows) => {
      if (err) return sendJson(res, 500, { ok: false, error: err.message });
      return sendJson(res, 200, { ok: true, votes: rows || [] });
    });
    return;
  }

  // Not found
  sendJson(res, 404, { ok: false, error: 'not found' });
});

apiServer.listen(API_PORT, () => console.log('[bridge] HTTP API listening on port', API_PORT));

wss.on('connection', (ws) => {
  console.log('[bridge] Frontend connected via WebSocket');
  ws.send(JSON.stringify({ type: 'INFO', message: 'bridge connected', timestamp: new Date().toISOString() }));

  ws.on('message', (msg) => {
    try {
      const obj = JSON.parse(msg.toString());

      if (obj.action === 'SIM_CONNECT') {
        const clientId = obj.clientId || `sim-${Date.now()}`;
        createSimulatedClient(clientId);
      } else if (obj.action === 'SIM_DISCONNECT') {
        if (obj.clientId) destroySimulatedClient(obj.clientId);
      } else if (obj.action === 'SEND') {
        const clientId = obj.clientId;
        if (!clientId) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'SEND requires clientId' }));
          return;
        }
        const s = simulatedClients[clientId];
        if (!s) {
          ws.send(JSON.stringify({ type: 'ERROR', message: `client ${clientId} not connected` }));
          return;
        }
        s.write(obj.data);
        broadcast({ type: 'SEND', clientId, data: obj.data, timestamp: new Date().toISOString() });
      } else if (obj.action === 'RAW') {
        // broadcast raw to all simulated clients
        Object.keys(simulatedClients).forEach((cid) => {
          try { simulatedClients[cid].write(obj.data); } catch (e) {}
        });
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
    }
  });
});

// Periodically emit select/poll-like heartbeat for UI demo
setInterval(() => {
  broadcast({ type: 'SELECT_POLL', activeFds: Math.floor(Math.random() * 10), timestamp: new Date().toISOString() });
}, 5000);

module.exports = { broadcast };
