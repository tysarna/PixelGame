const http = require('http');
const { WebSocketServer } = require('ws');
const { validateToken } = require('./auth');
const { handleMessage } = require('./router');
const { addConnection, removeConnection, getPlayerState } = require('./state');
const { broadcastToAll, broadcastToRoom } = require('./broadcast');
const { handleDisconnect: socialDisconnect } = require('./modules/socialEngine');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  let user;
  try {
    user = await validateToken(token);
  } catch (err) {
    console.warn(`[ws] auth failed: ${err.message}`);
    ws.close(4001, 'Invalid token');
    return;
  }

  const conn = { ws, playerId: user.sub, displayName: user.preferred_username };
  console.log(`[ws] connected player=${conn.playerId} name=${conn.displayName}`);
  addConnection(conn);
  broadcastToAll({ type: 'player_online', playerId: conn.playerId, displayName: conn.displayName }, conn.playerId);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      console.log(`[ws] ← ${msg.type} player=${conn.playerId}`);
      handleMessage(conn, msg);
    } catch (err) {
      console.error(`[ws] parse error player=${conn.playerId}:`, err.message);
      ws.send(JSON.stringify({ type: 'error', payload: { code: 'PARSE_ERROR', message: 'Invalid JSON' } }));
    }
  });

  // Mark alive for ping/pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('close', (code, reason) => {
    console.log(`[ws] disconnected player=${conn.playerId} code=${code}`);
    socialDisconnect(conn.playerId).catch(err => {
      console.error(`[ws] socialDisconnect error player=${conn.playerId}:`, err.message);
    });
    const state = getPlayerState(conn.playerId);
    if (state?.roomId) {
      broadcastToRoom(state.roomId, { type: 'player_left', playerId: conn.playerId });
    }
    broadcastToAll({ type: 'player_offline', playerId: conn.playerId });
    removeConnection(conn);
  });
});

// Ping all clients every 30s to keep connections alive through ALB/CloudFront idle timeouts
const PING_INTERVAL = 30_000;
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, PING_INTERVAL);
wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game server on :${PORT}`));
