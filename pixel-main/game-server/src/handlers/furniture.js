async function handlePlaceFurniture(conn, payload) {
  // Proxy to B's decorEngine module
  const decorEngine = require('../modules/decorEngine');
  return decorEngine.placeFurniture(conn, payload);
}

async function handleMoveFurniture(conn, payload) {
  const decorEngine = require('../modules/decorEngine');
  return decorEngine.moveFurniture(conn, payload);
}

async function handleRotateFurniture(conn, payload) {
  const decorEngine = require('../modules/decorEngine');
  return decorEngine.rotateFurniture(conn, payload);
}

async function handleRemoveFurniture(conn, payload) {
  const decorEngine = require('../modules/decorEngine');
  return decorEngine.removeFurniture(conn, payload);
}

module.exports = { handlePlaceFurniture, handleMoveFurniture, handleRotateFurniture, handleRemoveFurniture };
