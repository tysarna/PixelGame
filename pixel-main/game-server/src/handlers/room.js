const { joinRoom, leaveRoom, updatePlayerState, getPlayerState, getConnectionsByRoom } = require('../state');
const { broadcastToRoom, broadcastToAll, sendTo } = require('../broadcast');
const decorEngine = require('../modules/decorEngine');

const SPAWN = { x: 6, y: 6 }; // matches client/rooms/default.json spawnPoint
const ROOM_BOUNDS = { w: 12, h: 12 }; // matches default.json width/height

// Composite roomId format: "ownerId:templateId" (e.g. "abc123:cafe")
function parseRoomId(roomId) {
  const idx = roomId.lastIndexOf(':');
  if (idx < 0) return { ownerId: roomId, template: 'default' };
  return { ownerId: roomId.slice(0, idx), template: roomId.slice(idx + 1) };
}

async function handleJoinRoom(conn, payload) {
  const { roomId, avatarUrl } = payload;
  const { template } = parseRoomId(roomId);

  // Auto-leave previous room so the player isn't in two rooms at once
  const prevState = getPlayerState(conn.playerId);
  if (prevState?.roomId && prevState.roomId !== roomId) {
    const oldRoomId = prevState.roomId;
    leaveRoom(conn);
    broadcastToRoom(oldRoomId, { type: 'player_left', playerId: conn.playerId });
  }

  joinRoom(conn, roomId, SPAWN.x, SPAWN.y, avatarUrl);
  broadcastToAll({ type: 'player_room_changed', playerId: conn.playerId, displayName: conn.displayName, roomId }, conn.playerId);

  // Build snapshot of everyone now in the room (including the joiner)
  const players = [];
  for (const c of getConnectionsByRoom(roomId)) {
    const ps = getPlayerState(c.playerId);
    if (ps) {
      players.push({
        playerId: c.playerId,
        displayName: c.displayName,
        x: ps.x,
        y: ps.y,
        direction: ps.direction,
        pose: ps.pose,
        avatarUrl: ps.avatarUrl,
      });
    }
  }

  sendTo(conn, {
    type: 'room_state',
    players,
    furniture: await decorEngine.getRoomFurniture(roomId),
    template,
  });

  // Notify other players in the room
  broadcastToRoom(roomId, {
    type: 'player_joined',
    playerId: conn.playerId,
    displayName: conn.displayName,
    x: SPAWN.x,
    y: SPAWN.y,
    direction: 'down',
    pose: 'standing',
    avatarUrl,
  }, conn.playerId);
}

async function handleLeaveRoom(conn, payload) {
  const state = getPlayerState(conn.playerId);
  if (!state) return;
  const { roomId } = state;
  leaveRoom(conn);
  broadcastToRoom(roomId, {
    type: 'player_left',
    playerId: conn.playerId,
  });
}

async function handleMove(conn, payload) {
  const { x, y, direction } = payload;
  const state = getPlayerState(conn.playerId);
  if (!state) return;

  // Basic bounds check
  const nx = Math.max(0, Math.min(ROOM_BOUNDS.w - 1, x));
  const ny = Math.max(0, Math.min(ROOM_BOUNDS.h - 1, y));

  // B's walkability check — blocked by furniture
  const walkable = await decorEngine.isWalkable(state.roomId, nx, ny);
  if (!walkable) return;

  updatePlayerState(conn.playerId, { x: nx, y: ny, direction });

  // Broadcast to room peers (client moves self optimistically)
  broadcastToRoom(state.roomId, {
    type: 'player_moved',
    playerId: conn.playerId,
    x: nx,
    y: ny,
    direction,
  }, conn.playerId);
}

module.exports = { handleJoinRoom, handleLeaveRoom, handleMove };
