const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { broadcastToRoom, sendTo } = require('../broadcast');
const { getPlayerState, updatePlayerState } = require('../state');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// ── Player Profiles ──────────────────────────────────────────────

async function createPlayer(playerId, displayName, avatarUrl) {
  await ddb.send(new PutCommand({
    TableName: process.env.TABLE_PLAYERS,
    Item: {
      PK: `PLAYER#${playerId}`,
      displayName,
      avatarUrl,
      friends: [],
      createdAt: new Date().toISOString(),
    },
  }));
}

// ── Sitting / Standing ───────────────────────────────────────────

async function sit(conn, payload) {
  const { x, y, furnitureKey } = payload;
  const ps = getPlayerState(conn.playerId);
  if (!ps) return;

  const seatKey = `${x}_${y}`;

  // Check if seat is already taken
  const existing = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: { PK: `ROOM#${ps.roomId}`, SK: `SEAT#${seatKey}` },
  }));

  if (existing.Item && existing.Item.occupiedBy) {
    return sendTo(conn, {
      type: 'error',
      payload: { code: 'CHAIR_TAKEN', message: 'That seat is taken.' },
    });
  }

  // Claim the seat in DynamoDB
  await ddb.send(new PutCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Item: {
      PK: `ROOM#${ps.roomId}`,
      SK: `SEAT#${seatKey}`,
      occupiedBy: conn.playerId,
      furnitureKey,
    },
  }));

  // Update in-memory player state
  updatePlayerState(conn.playerId, {
    pose: 'sitting',
    seatPosition: seatKey,
  });

  broadcastToRoom(ps.roomId, {
    type: 'player_sat',
    playerId: conn.playerId,
    x,
    y,
    furnitureKey,
  });
}

async function stand(conn, _payload) {
  const ps = getPlayerState(conn.playerId);
  if (!ps || ps.pose !== 'sitting' || !ps.seatPosition) return;

  const seatKey = ps.seatPosition;

  // Release the seat in DynamoDB
  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: { PK: `ROOM#${ps.roomId}`, SK: `SEAT#${seatKey}` },
    UpdateExpression: 'SET occupiedBy = :none',
    ExpressionAttributeValues: { ':none': null },
  }));

  updatePlayerState(conn.playerId, {
    pose: 'standing',
    seatPosition: null,
  });

  broadcastToRoom(ps.roomId, {
    type: 'player_stood',
    playerId: conn.playerId,
  });
}

// ── Emotes ───────────────────────────────────────────────────────

const VALID_EMOTES = ['wave', 'eat', 'laugh', 'sleep'];

async function emote(conn, payload) {
  const ps = getPlayerState(conn.playerId);
  if (!ps) return;
  const { emote: emoteName } = payload;
  if (!VALID_EMOTES.includes(emoteName)) return;
  // Transient — broadcast so others see it, don't persist as pose
  broadcastToRoom(ps.roomId, {
    type: 'player_moved',
    playerId: conn.playerId,
    x: ps.x,
    y: ps.y,
    direction: ps.direction,
    pose: emoteName,
  });
}

// ── Chat ─────────────────────────────────────────────────────────

const PROFANITY_LIST = ['badword1', 'badword2']; // extend as needed

function filterText(text) {
  let filtered = text;
  for (const word of PROFANITY_LIST) {
    const re = new RegExp(`\\b${word}\\b`, 'gi');
    filtered = filtered.replace(re, '*'.repeat(word.length));
  }
  return filtered;
}

async function chat(conn, payload) {
  const ps = getPlayerState(conn.playerId);
  if (!ps) return;

  const text = filterText((payload.text || '').slice(0, 500)); // cap length
  if (!text.trim()) return;

  broadcastToRoom(ps.roomId, {
    type: 'chat_message',
    playerId: conn.playerId,
    displayName: conn.displayName,
    text,
  });
}

// ── Friends ──────────────────────────────────────────────────────

async function addFriend(conn, payload) {
  const { targetPlayerId } = payload;
  if (targetPlayerId === conn.playerId) {
    return sendTo(conn, {
      type: 'error',
      payload: { code: 'INVALID', message: 'Cannot friend yourself.' },
    });
  }

  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_PLAYERS,
    Key: { PK: `PLAYER#${conn.playerId}` },
    UpdateExpression: 'SET friends = list_append(if_not_exists(friends, :empty), :f)',
    ConditionExpression: 'NOT contains(friends, :target)',
    ExpressionAttributeValues: {
      ':f': [targetPlayerId],
      ':empty': [],
      ':target': targetPlayerId,
    },
  })).catch(err => {
    // ConditionalCheckFailedException means already friends — ignore
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  });

  sendTo(conn, {
    type: 'friend_added',
    targetPlayerId,
  });
}

async function removeFriend(conn, payload) {
  const { targetPlayerId } = payload;

  // Read current friend list, find index, remove it
  const res = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_PLAYERS,
    Key: { PK: `PLAYER#${conn.playerId}` },
  }));

  const friends = res.Item?.friends || [];
  const idx = friends.indexOf(targetPlayerId);
  if (idx === -1) {
    return sendTo(conn, {
      type: 'friend_removed',
      targetPlayerId,
    });
  }

  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_PLAYERS,
    Key: { PK: `PLAYER#${conn.playerId}` },
    UpdateExpression: `REMOVE friends[${idx}]`,
  }));

  sendTo(conn, {
    type: 'friend_removed',
    targetPlayerId,
  });
}

// ── Disconnect hook ──────────────────────────────────────────────

/**
 * Call this when a player disconnects so their seat is released.
 */
async function handleDisconnect(playerId) {
  const ps = getPlayerState(playerId);
  if (!ps || ps.pose !== 'sitting' || !ps.seatPosition) return;

  const seatKey = ps.seatPosition;

  await ddb.send(new UpdateCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: { PK: `ROOM#${ps.roomId}`, SK: `SEAT#${seatKey}` },
    UpdateExpression: 'SET occupiedBy = :none',
    ExpressionAttributeValues: { ':none': null },
  }));

  updatePlayerState(playerId, {
    pose: 'standing',
    seatPosition: null,
  });

  broadcastToRoom(ps.roomId, {
    type: 'player_stood',
    playerId,
  });
}

module.exports = {
  createPlayer,
  sit,
  stand,
  emote,
  chat,
  addFriend,
  removeFriend,
  handleDisconnect,
};
