const { getConnectionsByRoom, allConnections } = require('./state');

function broadcastToRoom(roomId, message, excludePlayerId = null) {
  const data = JSON.stringify(message);
  for (const conn of getConnectionsByRoom(roomId)) {
    if (conn.playerId !== excludePlayerId && conn.ws.readyState === 1) {
      conn.ws.send(data);
    }
  }
}

function broadcastToAll(message, excludePlayerId = null) {
  const data = JSON.stringify(message);
  for (const conn of allConnections.values()) {
    if (conn.playerId !== excludePlayerId && conn.ws.readyState === 1) {
      conn.ws.send(data);
    }
  }
}

function sendTo(conn, message) {
  if (conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify(message));
  }
}

module.exports = { broadcastToRoom, broadcastToAll, sendTo };
