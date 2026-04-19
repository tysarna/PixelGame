const { handleJoinRoom, handleLeaveRoom, handleMove } = require('./handlers/room');
const { handlePlaceFurniture, handleMoveFurniture, handleRotateFurniture, handleRemoveFurniture } = require('./handlers/furniture');
const { handleSit, handleStand, handleEmote, handleChat, handleAddFriend, handleRemoveFriend } = require('./handlers/social');
const { handleCreateCharacter } = require('./handlers/character');
const { handleGetOnlinePlayers } = require('./handlers/online');
const { sendTo } = require('./broadcast');

const handlers = {
  create_character: handleCreateCharacter,
  get_online_players: handleGetOnlinePlayers,
  join_room: handleJoinRoom,
  leave_room: handleLeaveRoom,
  move: handleMove,
  // B — furniture CRUD: plug handlePlaceFurniture etc. into decorEngine
  place_furniture: handlePlaceFurniture,
  move_furniture: handleMoveFurniture,
  rotate_furniture: handleRotateFurniture,
  remove_furniture: handleRemoveFurniture,
  // C — social: plug handleSit/handleStand/handleChat etc. into socialEngine
  sit: handleSit,
  stand: handleStand,
  emote: handleEmote,
  chat: handleChat,
  add_friend: handleAddFriend,
  remove_friend: handleRemoveFriend,
};

function handleMessage(conn, msg) {
  const handler = handlers[msg.type];
  if (!handler) {
    sendTo(conn, { type: 'error', payload: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg.type}` } });
    return;
  }
  handler(conn, msg.payload).catch(err => {
    console.error(`Handler error [${msg.type}]:`, err);
    sendTo(conn, { type: 'error', payload: { code: 'INTERNAL', message: 'Server error' } });
  });
}

module.exports = { handleMessage };
