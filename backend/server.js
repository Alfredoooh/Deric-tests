// (o mesmo server.js do exemplo anterior — proxy simples)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(cookieParser());

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, path: '/client-proxy' });

const sessionTokenStore = {}; // in-memory for demo
const clientMap = new Map();

app.post('/store-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok:false, error: 'token missing' });
  const sessionId = uuidv4();
  sessionTokenStore[sessionId] = token;
  res.cookie('SESSION_ID', sessionId, { httpOnly:true, sameSite:'lax' });
  return res.json({ ok:true, sessionId });
});

server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (!url.startsWith('/client-proxy')) { socket.destroy(); return; }
  const cookies = request.headers.cookie;
  let sessionId = null;
  if (cookies) {
    const match = cookies.match(/SESSION_ID=([^;]+)/);
    if (match) sessionId = match[1];
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.sessionId = sessionId;
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  console.log('cliente conectado ao proxy, sessionId=', ws.sessionId);
  const sessionId = ws.sessionId;
  const token = sessionId ? sessionTokenStore[sessionId] : null;

  const appId = process.env.DERIV_APP_ID || '1089';
  const derivUrl = `wss://ws.derivws.com/websockets/v3?app_id=${appId}`;
  const derivWs = new WebSocket(derivUrl);

  clientMap.set(ws, { sessionId, derivWs, subscribed: new Set() });

  derivWs.on('open', () => {
    console.log('conectado ao deriv (proxy)');
    if (token) {
      derivWs.send(JSON.stringify({ authorize: token }));
      ws.send(JSON.stringify({ type:'authorized' }));
    }
  });

  derivWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.tick) {
        ws.send(JSON.stringify({ type:'tick', symbol: msg.tick.symbol, quote: msg.tick.quote, epoch: msg.tick.epoch }));
      }
    } catch (e) { console.warn('parse err', e); }
  });

  derivWs.on('close', () => console.log('deriv ws close'));
  derivWs.on('error', (e) => console.error('deriv ws err', e));

  ws.on('message', (msgRaw) => {
    try {
      const msg = JSON.parse(msgRaw);
      if (msg.type === 'config') {
        console.log('config from client', msg);
      } else if (msg.type === 'subscribe' && msg.symbol) {
        const req = { ticks: msg.symbol, subscribe: 1 };
        derivWs.send(JSON.stringify(req));
        clientMap.get(ws).subscribed.add(msg.symbol);
        ws.send(JSON.stringify({ type:'subscribed', symbol: msg.symbol }));
      } else if (msg.type === 'unsubscribe' && msg.symbol) {
        derivWs.send(JSON.stringify({ forget: 'ticks' }));
        clientMap.get(ws).subscribed.delete(msg.symbol);
        ws.send(JSON.stringify({ type:'unsubscribed', symbol: msg.symbol }));
      }
    } catch (e) { console.warn('client msg parse err', e); }
  });

  ws.on('close', () => {
    console.log('cliente desconectou; fechando deriv ws');
    const meta = clientMap.get(ws);
    if (meta && meta.derivWs) try { meta.derivWs.close(); } catch(e){}
    clientMap.delete(ws);
  });

  ws.on('error', (e) => console.error('ws client err', e));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('proxy server rodando na porta', PORT));
