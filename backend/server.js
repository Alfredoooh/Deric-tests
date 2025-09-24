// backend/server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());

// serve frontend (opcional) - se colocares frontend/ no repo
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// In-memory stores (exemplo)
const sessionTokenStore = {}; // sessionId => token
const clientMeta = new Map(); // ws client => { sessionId, derivWs, subscribed, accountInfo, pendingRequests }

// create http server + ws upgrade
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: '/client-proxy' });

// POST /store-token -> creates session id cookie and store token server-side
app.post('/store-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok:false, error:'token missing' });
  const sid = uuidv4();
  sessionTokenStore[sid] = token;
  res.cookie('SESSION_ID', sid, { httpOnly: true, sameSite: 'lax' /*, secure: true in prod */ });
  return res.json({ ok:true, sessionId: sid });
});

// GET /me -> returns basic account info if backend has authorized with Deriv for this session
app.get('/me', (req, res) => {
  const sid = req.cookies['SESSION_ID'];
  if (!sid || !sessionTokenStore[sid]) return res.status(401).json({ authorized:false });
  // find clientMeta that has this session authorized
  for (const [ws, meta] of clientMeta.entries()) {
    if (meta.sessionId === sid && meta.accountInfo) {
      return res.json({ authorized:true, account: meta.accountInfo });
    }
  }
  // Not yet connected/authorized
  return res.json({ authorized:true, account: null });
});

// POST /logout -> clears cookie and removes stored token (demo)
app.post('/logout', (req, res) => {
  const sid = req.cookies['SESSION_ID'];
  if (sid) {
    delete sessionTokenStore[sid];
    res.clearCookie('SESSION_ID');
  }
  res.json({ ok:true });
});

// POST /api/buy -> create a buy request via Deriv WebSocket for this user's WS connection
app.post('/api/buy', (req, res) => {
  const sid = req.cookies['SESSION_ID'];
  if (!sid || !sessionTokenStore[sid]) return res.status(401).json({ ok:false, error:'not logged' });
  const { symbol, stake } = req.body;
  if (!symbol || !stake) return res.status(400).json({ ok:false, error:'missing params' });

  // find the client's derivWs connection
  let found = null;
  for (const meta of clientMeta.values()) {
    if (meta.sessionId === sid && meta.derivWs && meta.authorized) {
      found = meta;
      break;
    }
  }
  if (!found) return res.status(500).json({ ok:false, error:'deriv connection not ready' });

  // Build a proposal and buy flow — for simplicity we'll request a simple "buy" example.
  // NOTE: For real trading, you usually request a 'proposal' (price) then 'buy' with parameters: amount, contract_type etc.
  // Here is a minimal example for a 'BUY' contract (adjust according to Deriv docs).
  const reqId = Date.now();
  const buyRequest = {
    buy: 1,
    price: stake, // minimal approach; many markets require proposal/buy sequence
    subscribe: 0,
    symbol
  };

  // store callback
  found.pendingRequests = found.pendingRequests || {};
  found.pendingRequests[reqId] = (resp) => {
    res.json({ ok:true, result: resp });
  };

  try {
    // send the buy request to derivWs
    found.derivWs.send(JSON.stringify(buyRequest));
  } catch (err) {
    delete found.pendingRequests[reqId];
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// Upgrade handler for /client-proxy
server.on('upgrade', (request, socket, head) => {
  const url = request.url || '';
  if (!url.startsWith('/client-proxy')) { socket.destroy(); return; }
  const cookies = request.headers.cookie || '';
  let sessionId = null;
  const m = cookies.match(/SESSION_ID=([^;]+)/);
  if (m) sessionId = m[1];
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = sessionId;
    wss.emit('connection', ws, request);
  });
});

// On new client connected to proxy
wss.on('connection', (ws, req) => {
  const sid = ws.sessionId;
  console.log('client connected, session=', sid);
  const token = sid ? sessionTokenStore[sid] : null;

  // prepare meta
  const meta = { sessionId: sid, derivWs: null, subscribed: new Set(), accountInfo: null, authorized:false, pendingRequests:{} };
  clientMeta.set(ws, meta);

  // open Deriv WebSocket per client (could be pooled per account for scaling)
  const appId = process.env.DERIV_APP_ID || '71954';
  const derivUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;

  const derivWs = new WebSocket(derivUrl);
  meta.derivWs = derivWs;

  derivWs.on('open', () => {
    console.log('deriv ws open for session', sid);
    if (token) {
      derivWs.send(JSON.stringify({ authorize: token }));
    }
  });

  derivWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch(e){ return; }
    // handle authorize response -> extract account info & send to client
    if (msg.authorize) {
      if (msg.authorize.error) {
        ws.send(JSON.stringify({ type:'error', message: msg.authorize.error.message }));
      } else {
        meta.authorized = true;
        meta.accountInfo = {
          loginid: msg.authorize.loginid,
          currency: msg.authorize.currency,
          balance: msg.authorize.balance
        };
        ws.send(JSON.stringify({ type:'authorized', account: meta.accountInfo }));
        // optionally push balance
        ws.send(JSON.stringify({ type:'balance', balance: msg.authorize.balance }));
      }
      return;
    }
    // handle ticks
    if (msg.tick) {
      ws.send(JSON.stringify({ type:'tick', symbol:msg.tick.symbol, quote: msg.tick.quote, epoch: msg.tick.epoch }));
      return;
    }
    // handle buy responses / other responses
    if (msg.buy || msg.error) {
      // pass to client and also resolve pending if any
      ws.send(JSON.stringify({ type:'buy_result', result: msg }));
      // also try to resolve any pendingRequests (simple heuristic)
      for (const [k,cb] of Object.entries(meta.pendingRequests)) {
        try { cb(msg); } catch(e) {}
        delete meta.pendingRequests[k];
      }
      return;
    }
  });

  derivWs.on('close', () => console.log('deriv ws closed for session', sid));
  derivWs.on('error', (e) => console.error('deriv ws err', e));

  // messages from client
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe' && msg.symbol && meta.derivWs && meta.derivWs.readyState === WebSocket.OPEN) {
        const req = { ticks: msg.symbol, subscribe: 1 };
        meta.subscribed.add(msg.symbol);
        meta.derivWs.send(JSON.stringify(req));
        ws.send(JSON.stringify({ type:'subscribed', symbol: msg.symbol }));
      }
      // add more client commands if needed
    } catch(e) { console.warn('client msg err', e); }
  });

  ws.on('close', () => {
    console.log('client disconnected, session=', sid);
    // close deriv ws
    if (meta.derivWs) try { meta.derivWs.close(); } catch(e){}
    clientMeta.delete(ws);
  });
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Proxy server running on', PORT));
