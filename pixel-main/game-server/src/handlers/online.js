const { allConnections, getPlayerState } = require('../state');
const { sendTo } = require('../broadcast');

async function handleGetOnlinePlayers(conn, payload) {
  const players = [];
  for (const [playerId, c] of allConnections.entries()) {
    const state = getPlayerState(playerId);
    players.push({
      playerId,
      displayName: c.displayName,
      roomId: state?.roomId || null,
    });
  }
  sendTo(conn, { type: 'online_players', players });
}

module.exports = { handleGetOnlinePlayers };
