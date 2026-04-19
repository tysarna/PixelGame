const socialEngine = require('../modules/socialEngine');

async function handleSit(conn, payload) {
  return socialEngine.sit(conn, payload);
}

async function handleStand(conn, payload) {
  return socialEngine.stand(conn, payload);
}

async function handleEmote(conn, payload) {
  return socialEngine.emote(conn, payload);
}

async function handleChat(conn, payload) {
  return socialEngine.chat(conn, payload);
}

async function handleAddFriend(conn, payload) {
  return socialEngine.addFriend(conn, payload);
}

async function handleRemoveFriend(conn, payload) {
  return socialEngine.removeFriend(conn, payload);
}

module.exports = { handleSit, handleStand, handleEmote, handleChat, handleAddFriend, handleRemoveFriend };
