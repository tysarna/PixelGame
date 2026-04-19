// decorEngine.js — stub for B's furniture/decor module
// See docs/integration-guide-B-C.md for full spec

const { randomUUID } = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { broadcastToRoom, sendTo } = require('../broadcast');
const { getPlayerState } = require('../state');
// In Docker, manifest.json is at /app/manifest.json; in dev, fall back to client/
let manifest;
try {
  manifest = require('../../manifest.json');
} catch {
  manifest = require('../../../client/manifest.json');
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Room grid bounds (0–ROOM_MAX inclusive, matching default.json 12×12 grid)
const ROOM_MAX = 11;

/**
 * Returns true if the DynamoDB error is a transaction cancellation,
 * meaning at least one condition expression failed.
 */
function isTxCancelled(err) {
  return err.name === 'TransactionCanceledException';
}

/**
 * Returns true if the player is currently present in the given room.
 * Used to gate all furniture mutations — players can only modify rooms they are in.
 */
function isPlayerInRoom(conn, roomId) {
  const state = getPlayerState(conn.playerId);
  return state?.roomId === roomId;
}

/**
 * Returns true if the player owns the room.
 * Composite roomId format: "ownerId:templateId"
 */
function isRoomOwner(conn, roomId) {
  const idx = roomId.lastIndexOf(':');
  const ownerId = idx >= 0 ? roomId.slice(0, idx) : roomId;
  return conn.playerId === ownerId;
}

// In-memory blocked-tile cache: roomId → Set of "x_y" strings
const blockedTiles = new Map();

/**
 * Compute the set of tile keys blocked by a single furniture item,
 * accounting for rotation (90°/270° swap gridWidth and gridHeight).
 */
function getFootprint(item) {
  const meta = manifest.furniture[item.itemId];
  if (!meta) return new Set();

  const rotated = item.rotation === 90 || item.rotation === 270;
  const gw = rotated ? meta.gridHeight : meta.gridWidth;
  const gh = rotated ? meta.gridWidth  : meta.gridHeight;

  const tiles = new Set();
  for (let dx = 0; dx < gw; dx++) {
    for (let dy = 0; dy < gh; dy++) {
      tiles.add(`${item.x + dx}_${item.y + dy}`);
    }
  }
  return tiles;
}

/**
 * (Re)build the blocked-tile set for a room from DynamoDB.
 * Called lazily on first isWalkable check for a room.
 */
async function buildCache(roomId) {
  const items = await getRoomFurniture(roomId);
  const blocked = new Set();
  for (const item of items) {
    for (const tile of getFootprint(item)) blocked.add(tile);
  }
  blockedTiles.set(roomId, blocked);
  return blocked;
}

/**
 * Add an item's footprint to the room cache (call after placing/moving).
 */
function cacheAdd(roomId, item) {
  const blocked = blockedTiles.get(roomId);
  if (!blocked) return; // cache not yet built — will be built lazily
  for (const tile of getFootprint(item)) blocked.add(tile);
}

/**
 * Remove an item's footprint from the room cache (call before moving/removing).
 */
function cacheRemove(roomId, item) {
  const blocked = blockedTiles.get(roomId);
  if (!blocked) return;
  for (const tile of getFootprint(item)) blocked.delete(tile);
}

async function getRoomFurniture(roomId) {
  const result = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `ROOM#${roomId}`,
      ':prefix': 'FURNITURE#',
    },
  }));

  return (result.Items || [])
    .filter(item => item.itemId && item.x != null && item.y != null)
    .map(item => ({
      instanceId: item.SK.replace('FURNITURE#', ''),
      itemId: item.itemId,
      x: item.x,
      y: item.y,
      rotation: item.rotation ?? 0,
    }));
}

async function placeFurniture(conn, payload) {
  const { roomId, itemId, x, y, rotation = 0 } = payload;
  if (!roomId || !itemId || x == null || y == null) return;

  if (!isPlayerInRoom(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'You are not in this room.' } });
    return;
  }

  if (!isRoomOwner(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Only the room owner can place furniture.' } });
    return;
  }

  // Validate item exists in manifest
  const meta = manifest.furniture[itemId];
  if (!meta) {
    sendTo(conn, { type: 'error', payload: { code: 'UNKNOWN_ITEM', message: `Unknown furniture item: ${itemId}` } });
    return;
  }

  const item = { itemId, x, y, rotation };
  const footprint = getFootprint(item);

  // Bounds check — every tile must be within 0–11
  for (const tile of footprint) {
    const [tx, ty] = tile.split('_').map(Number);
    if (tx < 0 || tx > ROOM_MAX || ty < 0 || ty > ROOM_MAX) {
      sendTo(conn, { type: 'error', payload: { code: 'OUT_OF_BOUNDS', message: 'Furniture does not fit within the room.' } });
      return;
    }
  }

  // Collision check against cache (build it first if needed)
  const blocked = blockedTiles.get(roomId) ?? await buildCache(roomId);
  for (const tile of footprint) {
    if (blocked.has(tile)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
  }

  const instanceId = randomUUID();

  // Atomically write the furniture record and a TILE# lock for every tile it occupies.
  // attribute_not_exists on each tile lock ensures no two items can claim the same tile,
  // even across concurrent requests hitting different server instances.
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: process.env.TABLE_INTERACTIONS,
            Item: {
              PK: `ROOM#${roomId}`,
              SK: `FURNITURE#${instanceId}`,
              itemId, x, y, rotation,
              placedBy: conn.playerId,
              placedAt: new Date().toISOString(),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        ...[...footprint].map(tile => ({
          Put: {
            TableName: process.env.TABLE_INTERACTIONS,
            Item: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}`, instanceId },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
      ],
    }));
  } catch (err) {
    if (isTxCancelled(err)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
    throw err;
  }

  // Update cache and broadcast only after successful write
  cacheAdd(roomId, item);

  broadcastToRoom(roomId, {
    type: 'furniture_placed',
    instanceId,
    itemId,
    x,
    y,
    rotation,
    placedBy: conn.playerId,
  });
}

async function moveFurniture(conn, payload) {
  const { roomId, instanceId, x, y } = payload;
  if (!roomId || !instanceId || x == null || y == null) return;

  if (!isPlayerInRoom(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'You are not in this room.' } });
    return;
  }

  if (!isRoomOwner(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Only the room owner can move furniture.' } });
    return;
  }

  // Fetch existing record for current footprint
  const existing = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: {
      PK: `ROOM#${roomId}`,
      SK: `FURNITURE#${instanceId}`,
    },
  }));

  if (!existing.Item) {
    sendTo(conn, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Furniture item not found.' } });
    return;
  }

  const item = existing.Item;

  // No-op if position unchanged
  if (item.x === x && item.y === y) return;

  const rotation = item.rotation ?? 0;
  const oldFootprint = getFootprint({ itemId: item.itemId, x: item.x, y: item.y, rotation });
  const newFootprint = getFootprint({ itemId: item.itemId, x, y, rotation });

  // Bounds check
  for (const tile of newFootprint) {
    const [tx, ty] = tile.split('_').map(Number);
    if (tx < 0 || tx > ROOM_MAX || ty < 0 || ty > ROOM_MAX) {
      sendTo(conn, { type: 'error', payload: { code: 'OUT_OF_BOUNDS', message: 'Furniture does not fit within the room.' } });
      return;
    }
  }

  // Collision check — exclude tiles the item currently occupies
  const blocked = blockedTiles.get(roomId) ?? await buildCache(roomId);
  for (const tile of newFootprint) {
    if (blocked.has(tile) && !oldFootprint.has(tile)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
  }

  // Only tiles that are newly occupied need lock writes; tiles being freed need deletions.
  // Shared tiles (in both footprints) are left untouched.
  const tilesToAdd    = [...newFootprint].filter(t => !oldFootprint.has(t));
  const tilesToRemove = [...oldFootprint].filter(t => !newFootprint.has(t));

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: process.env.TABLE_INTERACTIONS,
            Key: { PK: `ROOM#${roomId}`, SK: `FURNITURE#${instanceId}` },
            UpdateExpression: 'SET x = :x, y = :y, updatedAt = :updatedAt',
            ExpressionAttributeValues: { ':x': x, ':y': y, ':updatedAt': new Date().toISOString() },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
        ...tilesToAdd.map(tile => ({
          Put: {
            TableName: process.env.TABLE_INTERACTIONS,
            Item: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}`, instanceId },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
        ...tilesToRemove.map(tile => ({
          Delete: {
            TableName: process.env.TABLE_INTERACTIONS,
            Key: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}` },
          },
        })),
      ],
    }));
  } catch (err) {
    if (isTxCancelled(err)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
    throw err;
  }

  // Update cache only after successful write
  cacheRemove(roomId, { itemId: item.itemId, x: item.x, y: item.y, rotation });
  cacheAdd(roomId, { itemId: item.itemId, x, y, rotation });

  broadcastToRoom(roomId, { type: 'furniture_moved', instanceId, x, y });
}

async function rotateFurniture(conn, payload) {
  const { roomId, instanceId, rotation } = payload;
  if (!roomId || !instanceId || rotation == null) return;

  if (!isPlayerInRoom(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'You are not in this room.' } });
    return;
  }

  if (!isRoomOwner(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Only the room owner can rotate furniture.' } });
    return;
  }

  if (![0, 90, 180, 270].includes(rotation)) {
    sendTo(conn, { type: 'error', payload: { code: 'INVALID_ROTATION', message: 'Rotation must be 0, 90, 180, or 270.' } });
    return;
  }

  // Fetch existing record for current footprint
  const existing = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: {
      PK: `ROOM#${roomId}`,
      SK: `FURNITURE#${instanceId}`,
    },
  }));

  if (!existing.Item) {
    sendTo(conn, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Furniture item not found.' } });
    return;
  }

  const item = existing.Item;

  // No-op if rotation unchanged
  if ((item.rotation ?? 0) === rotation) return;

  const oldFootprint = getFootprint({ itemId: item.itemId, x: item.x, y: item.y, rotation: item.rotation ?? 0 });
  const newFootprint = getFootprint({ itemId: item.itemId, x: item.x, y: item.y, rotation });

  // Bounds check
  for (const tile of newFootprint) {
    const [tx, ty] = tile.split('_').map(Number);
    if (tx < 0 || tx > ROOM_MAX || ty < 0 || ty > ROOM_MAX) {
      sendTo(conn, { type: 'error', payload: { code: 'OUT_OF_BOUNDS', message: 'Rotated furniture does not fit within the room.' } });
      return;
    }
  }

  // Collision check — exclude tiles the item currently occupies
  const blocked = blockedTiles.get(roomId) ?? await buildCache(roomId);
  for (const tile of newFootprint) {
    if (blocked.has(tile) && !oldFootprint.has(tile)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
  }

  const tilesToAdd    = [...newFootprint].filter(t => !oldFootprint.has(t));
  const tilesToRemove = [...oldFootprint].filter(t => !newFootprint.has(t));

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: process.env.TABLE_INTERACTIONS,
            Key: { PK: `ROOM#${roomId}`, SK: `FURNITURE#${instanceId}` },
            UpdateExpression: 'SET rotation = :rotation, updatedAt = :updatedAt',
            ExpressionAttributeValues: { ':rotation': rotation, ':updatedAt': new Date().toISOString() },
            ConditionExpression: 'attribute_exists(PK)',
          },
        },
        ...tilesToAdd.map(tile => ({
          Put: {
            TableName: process.env.TABLE_INTERACTIONS,
            Item: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}`, instanceId },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
        ...tilesToRemove.map(tile => ({
          Delete: {
            TableName: process.env.TABLE_INTERACTIONS,
            Key: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}` },
          },
        })),
      ],
    }));
  } catch (err) {
    if (isTxCancelled(err)) {
      sendTo(conn, { type: 'error', payload: { code: 'TILE_OCCUPIED', message: 'One or more tiles are already occupied.' } });
      return;
    }
    throw err;
  }

  // Update cache only after successful write
  cacheRemove(roomId, { itemId: item.itemId, x: item.x, y: item.y, rotation: item.rotation ?? 0 });
  cacheAdd(roomId, { itemId: item.itemId, x: item.x, y: item.y, rotation });

  broadcastToRoom(roomId, { type: 'furniture_rotated', instanceId, rotation });
}

async function removeFurniture(conn, payload) {
  const { roomId, instanceId } = payload;
  if (!roomId || !instanceId) return;

  if (!isPlayerInRoom(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'You are not in this room.' } });
    return;
  }

  if (!isRoomOwner(conn, roomId)) {
    sendTo(conn, { type: 'error', payload: { code: 'FORBIDDEN', message: 'Only the room owner can remove furniture.' } });
    return;
  }

  // Fetch existing record to get footprint info
  const existing = await ddb.send(new GetCommand({
    TableName: process.env.TABLE_INTERACTIONS,
    Key: {
      PK: `ROOM#${roomId}`,
      SK: `FURNITURE#${instanceId}`,
    },
  }));

  if (!existing.Item) {
    sendTo(conn, { type: 'error', payload: { code: 'NOT_FOUND', message: 'Furniture item not found.' } });
    return;
  }

  const item = existing.Item;

  const itemShape = { itemId: item.itemId, x: item.x, y: item.y, rotation: item.rotation ?? 0 };
  const footprint = getFootprint(itemShape);

  // Delete the furniture record and all its tile locks atomically
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Delete: {
          TableName: process.env.TABLE_INTERACTIONS,
          Key: { PK: `ROOM#${roomId}`, SK: `FURNITURE#${instanceId}` },
        },
      },
      ...[...footprint].map(tile => ({
        Delete: {
          TableName: process.env.TABLE_INTERACTIONS,
          Key: { PK: `ROOM#${roomId}`, SK: `TILE#${tile}` },
        },
      })),
    ],
  }));

  // Evict from cache only after successful write
  cacheRemove(roomId, itemShape);

  broadcastToRoom(roomId, { type: 'furniture_removed', instanceId });
}

async function isWalkable(roomId, x, y) {
  const blocked = blockedTiles.get(roomId) ?? await buildCache(roomId);
  return !blocked.has(`${x}_${y}`);
}

module.exports = {
  getRoomFurniture,
  placeFurniture, moveFurniture, rotateFurniture, removeFurniture,
  isWalkable,
  // Cache helpers — used internally by place/move/rotate/remove
  _cacheAdd: cacheAdd,
  _cacheRemove: cacheRemove,
};
