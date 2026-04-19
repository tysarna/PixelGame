# Multiplayer Bugs & Fragile Areas

Audit of `client/index.html`, `game-server/src/` as of 2026-03-27.

---

## Confirmed Bugs

### 1. Chat message type mismatch (server vs client)

**Server** `social.js:handleChat` reads `payload.message` and broadcasts `type: 'player_chat'`.
**Client** sends `{ type: 'chat', payload: { text } }` and listens for `type: 'chat_message'`.

Result: chat messages are silently dropped — server reads wrong field, broadcasts wrong type.

**Fix**: `social.js` should read `payload.text` and broadcast `type: 'chat_message'` (as the integration guide specifies on line 386-392).

### 2. Sit payload field mismatch

**Server** `social.js:handleSit` reads `payload.chairId`.
**Client** sends `{ type: 'sit', payload: { x, y, furnitureKey } }`.

Result: sitting never works — server gets `undefined` for chairId.

**Fix**: `handleSit` should destructure `{ x, y, furnitureKey }` from payload, not `{ chairId }`.

### 3. Canvas click handler accumulates on re-entry

`connectWS` override adds `cvs.addEventListener('click', handleCanvasClickGame)` inside a setTimeout every time the player enters the game screen. If the player leaves and re-enters, multiple listeners stack up.

**Fix**: Either use `{ once: false }` and remove on exit, or guard with a flag / use `removeEventListener` before adding.

### 4. Bounds hardcoded to 12x12 in two places

- **Client** `tryMove()` line 1540: `Math.min(12 - 1, ...)` — ignores `ROOM.width/height`.
- **Server** `room.js` line 5: `ROOM_BOUNDS = { w: 12, h: 12 }` — all rooms clamped to 12x12 regardless of actual template size.

Result: rooms larger than 12x12 are artificially bounded; rooms smaller than 12x12 allow walking off the map.

**Fix**:
- Client: use `ROOM.width - 1` / `ROOM.height - 1` in `tryMove()`.
- Server: store room dimensions per room (future: from DynamoDB). For now, accept client-reported position and validate against stored template bounds.

### 5. `handleGameKeyDown` defined but never called

Function at line 1556 is a dead copy of the anonymous keydown listener at line 1583. No impact, just dead code.

---

## Fragile Patterns (work today, break tomorrow)

### 6. Async room load + synchronous render race

In `room_state` handler, `loadTemplate(msg.template)` is async but `renderGame()` is called synchronously at the end of `handleWSMessage()`. First frame after visiting renders the OLD room's tiles. New tiles appear only after the fetch + `buildTileCanvas()` resolves.

**Mitigation**: Set a `roomLoading` flag, skip tile rendering while true, clear on resolve. Or queue a full re-render after `buildTileCanvas()`.

### 7. `computeTileScale()` ignores sidebar width

`computeTileScale()` uses `innerWidth - 40` but the game screen has a 220px sidebar (`#online-panel`). Result: tile scale is slightly too large for the game screen, canvas may overflow.

**Mitigation**: Pass available width as a parameter, or subtract sidebar width when on game-screen.

### 8. Self position diverges from server

`tryMove()` optimistically updates `gameState.self.x/y` but the server may clamp differently (bounds check, walkability). If the server rejects a move, the client never gets a correction — self position drifts.

**Mitigation**: On `player_moved` for self (currently filtered out at line 1106), reconcile position if it differs from optimistic.

### 9. No WS reconnect logic

If the WebSocket drops (network blip, ECS deploy), the client logs "WebSocket closed" and does nothing. Player is stranded on the game screen with no connection.

**Mitigation**: Exponential backoff reconnect, re-send `join_room` on reconnect, re-request `room_state` and `get_online_players`.

### 10. `player_left` on disconnect broadcasts to self

In `index.js` on `ws.close`, `broadcastToRoom` is called while the closing player's conn is still in the room set. The `ws.readyState === 1` check in `broadcastToRoom` prevents sending to the closed socket, so this works — but it's fragile. If the close event fires while the socket is still in CLOSING state (readyState 2), the message would be sent and fail silently.

**Mitigation**: Remove conn from room BEFORE broadcasting `player_left`, or explicitly exclude the disconnecting player.

### 11. Token expiry during long sessions

Cognito ID tokens expire after 1 hour. The WS connection stays alive (no token re-check), but if the player disconnects after 1h and tries to reconnect, the expired token in `authState.jwt` fails validation.

**Mitigation**: Refresh token before reconnect. Or implement server-side periodic token validation and send a `token_expired` message.

### 12. `displayName` can be undefined

`index.js:32` sets `conn.displayName = user.preferred_username`. If the Cognito user doesn't have `preferred_username` set (e.g., pre-existing users), this is `undefined`. Downstream code like `handleJoinRoom` broadcasts `displayName: conn.displayName` as `undefined`, and the client's `escapeHtml(msg.displayName || msg.playerId)` falls back to playerId — but only sometimes.

**Mitigation**: Server should fallback: `user.preferred_username || user.name || user.email || user.sub`.

---

## Best Practices in Current Code

- **Room-scoped broadcast**: All movement/chat only goes to room peers via `broadcastToRoom()`. Global events (online/offline) use `broadcastToAll()`. Clean separation.
- **Optimistic client movement**: Client moves self immediately, sends to server, server broadcasts to peers. Standard pattern for responsive feel.
- **Y-sorted painter's algorithm**: Both room preview and game renderer use `drawList.sort(sortY)` for correct depth ordering of furniture + players.
- **Sprite caching**: `spriteCache` avoids re-creating Image objects per frame. `tileCanvasCache` pre-renders the tile layer once.
- **Auto-leave on room switch**: `handleJoinRoom` checks for previous room and broadcasts `player_left` before joining new room. Prevents ghost-in-two-rooms.
- **Server-authoritative state**: Movement is validated server-side (bounds check). Client is optimistic but server has final say.
