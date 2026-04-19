# Integration Guide — Person B (decorEngine) & Person C (socialEngine)

This guide is the single source of truth for what B and C need to implement,
exactly where their code plugs in, and what contracts they must satisfy.

Person A has wired all the infrastructure and game server skeleton. B and C
replace stubs with real implementations. Neither needs to touch infra, auth,
WebSocket handling, or the client renderer.

---

## How the server is structured (read this first)

```
game-server/src/
  index.js          — WS server, auth, connection lifecycle (A — don't touch)
  router.js         — message type → handler dispatch (A — don't touch)
  state.js          — in-memory: roomConnections, playerState, allConnections (A — don't touch)
  broadcast.js      — sendTo(conn, msg), broadcastToRoom(roomId, msg, excludeId) (A — don't touch)
  handlers/
    room.js         — join_room, leave_room, move (A)
    character.js    — create_character / avatar gen (A)
    furniture.js    — thin proxy → B's decorEngine (A — don't touch)
    social.js       — thin proxy → C's socialEngine (A — don't touch)
  modules/
    decorEngine.js  — ← B writes this
    socialEngine.js — ← C writes this
```

Each `conn` object passed to handlers has:
```javascript
conn.playerId      // Cognito sub (UUID string) — unique per user
conn.displayName   // preferred_username from Cognito JWT
conn.ws            // WebSocket — use broadcast.js helpers, not this directly
```

Each `playerState` entry (from `state.getPlayerState(playerId)`) has:
```javascript
{
  roomId: string,
  x: number,        // 0–11
  y: number,        // 0–11
  direction: 'down' | 'left' | 'up' | 'right',
  pose: 'standing' | 'sitting',
  seatPosition: string | null,   // e.g. "3_4" when sitting
  avatarUrl: string,             // CloudFront URL to sprite sheet PNG
}
```

DynamoDB tables available (names in env vars):
- `process.env.TABLE_ROOMS`        — room metadata
- `process.env.TABLE_PLAYERS`      — player profiles
- `process.env.TABLE_INTERACTIONS` — chair/seat state per room

AWS SDK is already installed (`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`).

---

## Person B — decorEngine (furniture & room decoration)

### File to implement
`game-server/src/modules/decorEngine.js`

### What B owns
- Dynamic furniture state per room (what's placed, where, by whom)
- Walkability: which tiles are blocked by furniture
- CRUD operations: place, move, rotate, remove
- Persisting furniture state to DynamoDB

### The room grid
- 12×12 tiles, each tile is a 32px cell
- Tiles 0,0 through 11,11 (origin top-left)
- Wall tiles are row 0, col 0, col 11 (see `client/rooms/default.json` for full tileMap)
- Players cannot walk onto wall tiles — A does a bounds check (0–11) and calls `decorEngine.isWalkable(roomId, x, y)` which B implements

### Furniture items (from `client/manifest.json`)

| itemId | gridWidth | gridHeight | zLayer |
|--------|-----------|------------|--------|
| `chair_wood_01` | 1 | 1 | 2 |
| `table_round_01` | 1 | 1 | 2 |
| `sofa_blue_01` | 2 | 1 | 2 |
| `lamp_tall_01` | 1 | 1 | 2 |
| `bookshelf_01` | 2 | 1 | 2 |

gridWidth/gridHeight are in tiles. A 2×1 item at position (3,4) occupies tiles (3,4) and (4,4).

### Function signatures B must implement

```javascript
// decorEngine.js

/**
 * Called by handleJoinRoom (A's code) when a player enters a room.
 * Returns the current furniture layout so the client can render it.
 *
 * @param {string} roomId
 * @returns {Promise<Array<{itemId: string, x: number, y: number, rotation?: number}>>}
 */
async function getRoomFurniture(roomId) { }

/**
 * Place a new furniture item in the room.
 * Validate: item fits within bounds, tiles not already occupied.
 * Persist to DynamoDB. Broadcast placement to room.
 *
 * @param {object} conn   — caller connection
 * @param {object} payload — { roomId, itemId, x, y, rotation? }
 */
async function placeFurniture(conn, payload) { }

/**
 * Move an existing furniture item to a new position.
 * Validate ownership or room-owner permission.
 *
 * @param {object} conn
 * @param {object} payload — { roomId, instanceId, x, y }
 */
async function moveFurniture(conn, payload) { }

/**
 * Rotate an existing furniture item.
 *
 * @param {object} conn
 * @param {object} payload — { roomId, instanceId, rotation }  (0, 90, 180, 270)
 */
async function rotateFurniture(conn, payload) { }

/**
 * Remove a furniture item from the room.
 *
 * @param {object} conn
 * @param {object} payload — { roomId, instanceId }
 */
async function removeFurniture(conn, payload) { }

/**
 * Check whether tile (x, y) in roomId is walkable.
 * Returns false if a furniture item occupies that tile.
 * A calls this from handleMove to block walking into furniture.
 *
 * @param {string} roomId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<boolean>}
 */
async function isWalkable(roomId, x, y) { }

module.exports = {
  getRoomFurniture,
  placeFurniture, moveFurniture, rotateFurniture, removeFurniture,
  isWalkable,
};
```

### Where A calls into B (all already wired — B just implements the module)

**`handlers/room.js` — `handleJoinRoom`:**
```javascript
furniture: await decorEngine.getRoomFurniture(roomId),
// Stub returns [] — B replaces with a DynamoDB query
```

**`handlers/room.js` — `handleMove`:**
```javascript
const walkable = await decorEngine.isWalkable(state.roomId, nx, ny);
if (!walkable) return; // silently drop — client is optimistic anyway
// Stub returns true — B replaces with furniture collision check
```

**`handlers/furniture.js`** — thin proxies, no changes needed:
```javascript
async function handlePlaceFurniture(conn, payload) {
  return decorEngine.placeFurniture(conn, payload);  // B's code runs here
}
// ...same for move, rotate, remove
```

### Outbound messages B should broadcast

All broadcasts use `broadcastToRoom(roomId, message)` from `../broadcast`.

```javascript
// furniture placed
broadcastToRoom(roomId, {
  type: 'furniture_placed',
  instanceId,   // unique ID B generates (e.g. uuid)
  itemId,
  x, y,
  rotation: rotation || 0,
  placedBy: conn.playerId,
});

// furniture moved
broadcastToRoom(roomId, {
  type: 'furniture_moved',
  instanceId, x, y,
});

// furniture rotated
broadcastToRoom(roomId, {
  type: 'furniture_rotated',
  instanceId, rotation,
});

// furniture removed
broadcastToRoom(roomId, {
  type: 'furniture_removed',
  instanceId,
});
```

### DynamoDB schema (Interactions table)

B owns the furniture records in `TABLE_INTERACTIONS`:

```
PK:  "ROOM#<roomId>"
SK:  "FURNITURE#<instanceId>"
Attributes:
  itemId:     string
  x:          number
  y:          number
  rotation:   number (0 | 90 | 180 | 270)
  placedBy:   string (playerId)
  placedAt:   string (ISO timestamp)
```

Query all furniture for a room:
```javascript
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const items = await ddb.send(new QueryCommand({
  TableName: process.env.TABLE_INTERACTIONS,
  KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
  ExpressionAttributeValues: {
    ':pk': `ROOM#${roomId}`,
    ':prefix': 'FURNITURE#',
  },
}));
```

---

## Person C — socialEngine (sitting, chat, player profiles, friends)

### File to implement
`game-server/src/modules/socialEngine.js`

### What C owns
- Player profiles (create/read from DynamoDB)
- Chair claiming and conflict resolution (two players can't sit in the same chair)
- Chat messages (filter, relay, history optional)
- Friend list (add/remove, persist to DynamoDB)

### Function signatures C must implement

```javascript
// socialEngine.js

/**
 * Called by character.js after avatar generation completes.
 * Creates or updates the player record in DynamoDB.
 *
 * @param {string} playerId    — Cognito sub
 * @param {string} displayName — preferred_username
 * @param {string} avatarUrl   — CloudFront URL to sprite sheet PNG
 * @returns {Promise<void>}
 */
async function createPlayer(playerId, displayName, avatarUrl) { }

/**
 * Called by social.js handleSit.
 * Claim a chair. If already taken, reject with an error sent to conn.
 * On success: update playerState pose → 'sitting', broadcast player_sat.
 *
 * @param {object} conn
 * @param {object} payload — { x: number, y: number, furnitureKey: string }
 *   x, y        — tile position of the chair
 *   furnitureKey — itemId (e.g. "chair_wood_01")
 */
async function sit(conn, payload) { }

/**
 * Called by social.js handleStand.
 * Release the chair. Update playerState pose → 'standing'. Broadcast player_stood.
 *
 * @param {object} conn
 * @param {object} payload — {} (empty — state is on the server)
 */
async function stand(conn, payload) { }

/**
 * Called by social.js handleChat.
 * Relay the message to the room. Optionally filter profanity.
 * Optionally persist to DynamoDB for history.
 *
 * @param {object} conn
 * @param {object} payload — { text: string }
 */
async function chat(conn, payload) { }

/**
 * Add targetPlayerId to conn.playerId's friend list.
 * Persist to DynamoDB.
 *
 * @param {object} conn
 * @param {object} payload — { targetPlayerId: string }
 */
async function addFriend(conn, payload) { }

/**
 * Remove targetPlayerId from conn.playerId's friend list.
 *
 * @param {object} conn
 * @param {object} payload — { targetPlayerId: string }
 */
async function removeFriend(conn, payload) { }

module.exports = { createPlayer, sit, stand, chat, addFriend, removeFriend };
```

### Where A calls into C (all already wired — C just implements the module)

**`handlers/character.js` — after avatar generation:**
```javascript
await socialEngine.createPlayer(conn.playerId, conn.displayName, avatarUrl);
```

**`handlers/social.js`** — thin proxies, no changes needed:
```javascript
async function handleSit(conn, payload) {
  return socialEngine.sit(conn, payload);   // C's code runs here
}
// ...same for stand, chat, addFriend, removeFriend
```

### Inbound payload shapes (from client)

```javascript
// Client sends when player clicks a chair:
{ type: 'sit', payload: { x: 3, y: 4, furnitureKey: 'chair_wood_01' } }

// Client sends when player presses Esc or stands up:
{ type: 'stand', payload: {} }

// Client sends when player submits chat:
{ type: 'chat', payload: { text: 'hello world' } }

// Client sends friend actions:
{ type: 'add_friend',    payload: { targetPlayerId: 'uuid...' } }
{ type: 'remove_friend', payload: { targetPlayerId: 'uuid...' } }
```

### Outbound messages C should broadcast/send

Use `broadcastToRoom` and `sendTo` from `require('../broadcast')`.
Use `getPlayerState`, `updatePlayerState` from `require('../state')`.

```javascript
// Successful sit — broadcast to whole room
broadcastToRoom(roomId, {
  type: 'player_sat',
  playerId: conn.playerId,
  x, y,
  furnitureKey,
});

// Chair already taken — send error only to requester
sendTo(conn, {
  type: 'error',
  payload: { code: 'CHAIR_TAKEN', message: 'That seat is taken.' }
});

// Stand up — broadcast to whole room
broadcastToRoom(roomId, {
  type: 'player_stood',
  playerId: conn.playerId,
});

// Chat message — broadcast to whole room
// NOTE: client listens for 'chat_message' (not 'player_chat')
broadcastToRoom(roomId, {
  type: 'chat_message',
  playerId: conn.playerId,
  displayName: conn.displayName,
  text: payload.text,
});

// Friend added/removed — send confirmation only to requester
sendTo(conn, {
  type: 'friend_added',   // or 'friend_removed'
  targetPlayerId,
});
```

### Chair conflict resolution

Chairs are claimed per-room. C owns the Interactions table records for seats:

```
PK:  "ROOM#<roomId>"
SK:  "SEAT#<x>_<y>"
Attributes:
  occupiedBy: string (playerId) | null
  furnitureKey: string
```

Flow for `sit`:
1. Read `SEAT#<x>_<y>` from TABLE_INTERACTIONS
2. If `occupiedBy` is set and not null → `sendTo(conn, { type: 'error', ... })`
3. Else → write `occupiedBy: conn.playerId`, call `updatePlayerState(conn.playerId, { pose: 'sitting', seatPosition: \`${x}_${y}\` })`, broadcast `player_sat`

Flow for `stand`:
1. Read current playerState to find `seatPosition`
2. Write `occupiedBy: null` to that seat record
3. Call `updatePlayerState(conn.playerId, { pose: 'standing', seatPosition: null })`
4. Broadcast `player_stood`

Also call `stand` logic from your module when a player disconnects mid-sit (A calls `removeConnection` on disconnect — C should hook into this or A will call a `handleDisconnect` hook).

### DynamoDB schemas C owns

**Players table (`TABLE_PLAYERS`)**:
```
PK:         "PLAYER#<playerId>"
Attributes:
  displayName:  string
  avatarUrl:    string
  friends:      string[] (list of playerIds)
  createdAt:    string (ISO)
```

**Interactions table — seat records (`TABLE_INTERACTIONS`)**:
```
PK:           "ROOM#<roomId>"
SK:           "SEAT#<x>_<y>"
Attributes:
  occupiedBy:   string | null
  furnitureKey: string
```

---

## Coordination between B and C

B and C share `TABLE_INTERACTIONS` with non-overlapping SK prefixes:
- B uses `FURNITURE#<instanceId>`
- C uses `SEAT#<x>_<y>`

They don't need to call each other, but C's `sit` needs to know if a tile has a chair — that's implicit in the client sending `furnitureKey`. C trusts the client payload here (the client only shows sit as an option when a chair is clicked).

If B later wants to validate that a chair exists before C claims it, B can expose:
```javascript
// Optional — decorEngine.js
async function isSittable(roomId, x, y) { }
```
And C calls it before claiming the seat.

---

## Testing your module in isolation

Both B and C can test without a browser. Use the existing test framework:

```bash
# Start game server locally (connects to real DynamoDB via AWS creds)
cd game-server && npm start

# In another terminal, connect with wscat (npm install -g wscat)
# Get a JWT first: sign in via the client or AWS CLI
wscat -c "ws://localhost:3000/ws?token=<JWT>"

# Test B — place furniture
> {"type":"join_room","payload":{"roomId":"test","avatarUrl":""}}
> {"type":"place_furniture","payload":{"roomId":"test","itemId":"chair_wood_01","x":5,"y":5}}

# Test C — sit
> {"type":"sit","payload":{"x":5,"y":5,"furnitureKey":"chair_wood_01"}}
> {"type":"chat","payload":{"text":"hello"}}
> {"type":"stand","payload":{}}
```

Expected responses follow the outbound message shapes defined above.
