import {
  ROOM, MANIFEST, TILE_SIZE, CELL, SCALE, DIR_ROW, POSE_COL,
  ROOM_TEMPLATES,
  gameState, authState, liveFurniture, furnEditMode, furnitureMode, furnPreview,
  onlineState, currentRoomId, ws, spriteCache, tileCanvasCache,
  furnitureImages, _dragJustEnded, lastMoveTime, MOVE_COOLDOWN,
  gameLoop, selectedFurnInstance,
  setCurrentRoomId, setDragJustEnded, setLastMoveTime, setGameLoop,
  setFurnitureMode, setFurnPreview, setSelectedFurnInstance, selectedChar
} from './state.js';
import { escapeHtml, log, showScreen } from './utils.js';
import { disconnectWS } from './network.js';
import { fetchCharacters } from './characters.js';

// Parse composite roomId "ownerId:templateId" into friendly display
function formatRoomDisplay(roomId, isSelf) {
  if (!roomId) return '…';
  const idx = roomId.lastIndexOf(':');
  if (idx < 0) return roomId;
  const ownerId = roomId.slice(0, idx);
  const tplId = roomId.slice(idx + 1);
  const tplName = ROOM_TEMPLATES.find(t => t.id === tplId)?.name || tplId;
  if (isSelf) return `★ ${tplName}`;
  // Find the owner's display name from onlineState
  const ownerInfo = onlineState.get(ownerId);
  const ownerName = ownerInfo?.displayName || ownerId.slice(0, 8);
  return `${ownerName}'s ${tplName}`;
}

export class PlayerSprite {
  constructor(avatarUrl) {
    this.image = new Image();
    this.loaded = false;
    this.image.onload = () => { this.loaded = true; };
    if (avatarUrl) this.image.src = avatarUrl;
    this.walkCycle = ['idle', 'stepA', 'idle', 'stepB'];
    this.walkIndex = 0;
    this.currentPose = 'idle';
    this.walkTimer = null;
  }
  onMove() {
    this.walkIndex = (this.walkIndex + 1) % this.walkCycle.length;
    this.currentPose = this.walkCycle[this.walkIndex];
    clearTimeout(this.walkTimer);
    this.walkTimer = setTimeout(() => { this.currentPose = 'idle'; this.walkIndex = 0; }, 300);
  }
  getCol(serverPose) {
    if (serverPose === 'sitting') return POSE_COL.sit;
    if (POSE_COL[serverPose] !== undefined && serverPose !== 'idle' && serverPose !== 'standing') return POSE_COL[serverPose];
    return POSE_COL[this.currentPose] ?? POSE_COL.idle;
  }
}

export function getOrCreateSprite(playerId, avatarUrl) {
  const existing = spriteCache.get(playerId);
  if (!existing || (avatarUrl && existing.image.src !== avatarUrl)) {
    spriteCache.set(playerId, new PlayerSprite(avatarUrl));
  }
  return spriteCache.get(playerId);
}

export function renderOnlinePanel() {
  const list = document.getElementById('online-list');
  const countEl = document.getElementById('online-count');
  if (!list) return;
  countEl.textContent = onlineState.size;
  list.innerHTML = '';
  for (const [playerId, info] of onlineState.entries()) {
    const isSelf = playerId === authState.playerId;
    const div = document.createElement('div');
    div.className = 'online-player' + (isSelf ? ' online-self' : '');
    const nameRow = document.createElement('div');
    nameRow.className = 'online-player-name';
    nameRow.innerHTML = `<span class="online-dot"></span><span>${escapeHtml(info.displayName || playerId)}</span>`;
    div.appendChild(nameRow);
    const roomRow = document.createElement('div');
    roomRow.className = 'online-room';
    roomRow.textContent = formatRoomDisplay(info.roomId, isSelf);
    div.appendChild(roomRow);
    if (!isSelf && info.roomId && info.roomId !== currentRoomId) {
      const btn = document.createElement('button');
      btn.className = 'btn-visit';
      btn.textContent = '→ Visit';
      btn.onclick = () => visitPlayer(info.roomId);
      div.appendChild(btn);
    }
    list.appendChild(div);
  }
}

function visitPlayer(roomId) {
  if (!roomId || roomId === currentRoomId) return;
  setCurrentRoomId(roomId);
  renderOnlinePanel();
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'join_room', payload: { roomId, avatarUrl: gameState.avatarUrl || selectedChar?.url || '' } }));
    // Update room label to show whose room we're visiting
    const label = document.getElementById('room-label');
    if (label) {
      const isOwn = roomId.startsWith(authState.playerId + ':');
      label.textContent = isOwn ? 'LIVE' : formatRoomDisplay(roomId, false);
      label.className = isOwn ? 'room-label live' : 'room-label visiting';
    }
    log(`Visiting room: ${roomId}`, 'ok');
  }
}

export function exitGame() {
  if (ws) { disconnectWS(); ws.close(); }
  import('./state.js').then(s => { s.setWs(null); });
  if (gameLoop) { cancelAnimationFrame(gameLoop); setGameLoop(null); }
  import('./state.js').then(s => { s.setIsLive(false); });
  showScreen('select-screen');
  fetchCharacters();
}

export function renderGame() {
  const cvs = document.getElementById('game-canvas');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  const tileSize = TILE_SIZE;
  const rw = (ROOM.width || 12) * tileSize;
  const rh = (ROOM.height || 12) * tileSize;

  if (cvs.width !== rw || cvs.height !== rh) { cvs.width = rw; cvs.height = rh; }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  if (tileCanvasCache) ctx.drawImage(tileCanvasCache, 0, 0);

  const drawList = [];
  const allFurn = [...(ROOM.furniture || []), ...liveFurniture];

  for (const f of allFurn) {
    const def = MANIFEST.furniture?.[f.itemId];
    const img = furnitureImages[f.itemId];
    const gw = def?.gridWidth || 1;
    const gh = def?.gridHeight || 1;
    const fw = gw * tileSize * 2;
    const fh = gh * tileSize * 2;
    const footCX = f.x * tileSize + gw * tileSize / 2;
    const footBY = f.y * tileSize + gh * tileSize;
    const fx = footCX - fw / 2;
    const fy = footBY - fh;
    const isLiveItem = !!f.instanceId;
    drawList.push({ sortY: footBY, draw() {
      if (img) {
        const rot = f.rotation || 0;
        if (rot !== 0) {
          ctx.save();
          ctx.translate(footCX, footBY - gh * tileSize);
          ctx.rotate(rot * Math.PI / 180);
          const origW = (def?.gridWidth || 1) * tileSize * 2;
          const origH = (def?.gridHeight || 1) * tileSize * 2;
          ctx.drawImage(img, -origW / 2, -origH / 2, origW, origH);
          ctx.restore();
        } else {
          ctx.drawImage(img, fx, fy, fw, fh);
        }
      } else if (def) {
        ctx.fillStyle = '#2a3040'; ctx.fillRect(fx, fy, fw, fh);
        ctx.fillStyle = '#555d73'; ctx.font = '8px monospace';
        ctx.fillText(f.itemId.split('_')[0], fx + 2, fy + 10);
      }
      if (furnEditMode && isLiveItem) {
        const isSelected = f.instanceId === selectedFurnInstance;
        ctx.save();
        ctx.strokeStyle = isSelected ? 'rgba(255,200,60,0.9)' : 'rgba(100,180,255,0.6)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.setLineDash(isSelected ? [] : [3, 3]);
        ctx.strokeRect(f.x * tileSize, f.y * tileSize, gw * tileSize, gh * tileSize);
        ctx.restore();
      }
    }});
  }

  // Draw furniture placement ghost preview
  if (furnitureMode && furnPreview) {
    const ghostDef = MANIFEST.furniture?.[furnitureMode.itemId];
    const ghostImg = furnitureImages[furnitureMode.itemId];
    if (ghostDef) {
      const rot = furnitureMode.rotation || 0;
      const rotated = rot === 90 || rot === 270;
      const gw = rotated ? (ghostDef.gridHeight || 1) : (ghostDef.gridWidth || 1);
      const gh = rotated ? (ghostDef.gridWidth || 1) : (ghostDef.gridHeight || 1);
      const fw = gw * tileSize * 2;
      const fh = gh * tileSize * 2;
      const footCX = furnPreview.tileX * tileSize + gw * tileSize / 2;
      const footBY = furnPreview.tileY * tileSize + gh * tileSize;
      const fx = footCX - fw / 2;
      const fy = footBY - fh;

      // Check if placement is valid (in bounds + no collision)
      let valid = true;
      for (let dx = 0; dx < gw; dx++) {
        for (let dy = 0; dy < gh; dy++) {
          const cx = furnPreview.tileX + dx;
          const cy = furnPreview.tileY + dy;
          if (cx < 0 || cx >= (ROOM.width || 12) || cy < 0 || cy >= (ROOM.height || 12)) { valid = false; break; }
          for (const f of liveFurniture) {
            const fd = MANIFEST.furniture?.[f.itemId];
            if (!fd) continue;
            const fgw = fd.gridWidth || 1, fgh = fd.gridHeight || 1;
            if (cx >= f.x && cx < f.x + fgw && cy >= f.y && cy < f.y + fgh) { valid = false; break; }
          }
          if (!valid) break;
        }
        if (!valid) break;
      }

      ctx.save();
      ctx.globalAlpha = 0.5;
      if (ghostImg) {
        if (rot !== 0) {
          ctx.translate(footCX, footBY - gh * tileSize);
          ctx.rotate(rot * Math.PI / 180);
          const origW = (ghostDef.gridWidth || 1) * tileSize * 2;
          const origH = (ghostDef.gridHeight || 1) * tileSize * 2;
          ctx.drawImage(ghostImg, -origW / 2, -origH / 2, origW, origH);
        } else {
          ctx.drawImage(ghostImg, fx, fy, fw, fh);
        }
      } else {
        ctx.fillStyle = '#2a3040';
        ctx.fillRect(fx, fy, fw, fh);
      }
      ctx.restore();

      // Draw grid overlay (green = valid, red = invalid)
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = valid ? '#00ff88' : '#ff4444';
      ctx.fillRect(furnPreview.tileX * tileSize, furnPreview.tileY * tileSize, gw * tileSize, gh * tileSize);
      ctx.restore();
    }
  }

  function addPlayerDraw(px, py, direction, pose, avatarUrl, playerId, label) {
    const sprite = getOrCreateSprite(playerId, avatarUrl);
    const dw = CELL * SCALE;
    const dh = CELL * SCALE;
    const cx = px * tileSize + tileSize / 2;
    const cy = py * tileSize + tileSize / 2;
    drawList.push({ sortY: cy + dh / 2, draw() {
      const row = DIR_ROW[direction] ?? 0;
      const col = sprite.getCol(pose);
      const dx = cx - dw / 2;
      const dy = cy - dh / 2;
      ctx.save(); ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(cx, cy + dh / 2 - 6, 16, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      if (!sprite.loaded) {
        ctx.save(); ctx.globalAlpha = 0.5; ctx.fillStyle = '#8899bb';
        ctx.fillRect(dx + dw * 0.2, dy, dw * 0.6, dh * 0.55);
        ctx.beginPath(); ctx.arc(cx, dy - dh * 0.05, dw * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      } else {
        ctx.drawImage(sprite.image, col * CELL, row * CELL, CELL, CELL, dx, dy, dw, dh);
      }
      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      const metrics = ctx.measureText(label);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(cx - metrics.width / 2 - 2, dy - 14, metrics.width + 4, 14);
      ctx.fillStyle = '#000';
      ctx.fillText(label, cx, dy - 3);
    }});
  }

  Object.values(gameState.players).forEach(p => {
    if (p.playerId !== authState.playerId) {
      addPlayerDraw(p.x, p.y, p.direction, p.pose, p.avatarUrl, p.playerId, p.displayName || p.playerId);
    }
  });

  if (gameState.self) {
    addPlayerDraw(gameState.self.x, gameState.self.y, gameState.direction, gameState.pose,
      gameState.self.avatarUrl || gameState.avatarUrl, authState.playerId, authState.displayName || authState.playerId);
  }

  drawList.sort((a, b) => a.sortY - b.sortY);
  for (const item of drawList) item.draw();
}

export function initGameLoop() {
  if (gameLoop) cancelAnimationFrame(gameLoop);
  function loop() {
    renderGame();
    setGameLoop(requestAnimationFrame(loop));
  }
  loop();
}

function isTileBlocked(x, y) {
  if (x < 0 || x >= (ROOM.width || 12) || y < 0 || y >= (ROOM.height || 12)) return true;
  const allFurn = [...(ROOM.furniture || []), ...liveFurniture];
  for (const f of allFurn) {
    const def = MANIFEST.furniture?.[f.itemId];
    if (!def) continue;
    if (def.sittable) continue;
    const gw = def.gridWidth || 1;
    const gh = def.gridHeight || 1;
    if (x >= f.x && x < f.x + gw && y >= f.y && y < f.y + gh) return true;
  }
  return false;
}

export function tryMove(dir) {
  const now = Date.now();
  if (now - lastMoveTime < MOVE_COOLDOWN) return;
  setLastMoveTime(now);

  const self = gameState.self;
  if (!self) return;
  if (gameState.pose === 'sitting') return;

  const dirDelta = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] };
  const [dx, dy] = dirDelta[dir];
  const newX = self.x + dx;
  const newY = self.y + dy;

  gameState.direction = dir;

  if (isTileBlocked(newX, newY)) return;

  const sprite = getOrCreateSprite(authState.playerId, gameState.avatarUrl);
  if (sprite) sprite.onMove();

  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'move', payload: { x: newX, y: newY, direction: dir } }));
  }

  gameState.self.x = newX;
  gameState.self.y = newY;
  gameState.self.direction = dir;
}

export function applyLocalEmote(emoteName) {
  if (gameState.pose === 'sitting') return;
  gameState.pose = emoteName;
  clearTimeout(gameState._emoteTimer);
  gameState._emoteTimer = setTimeout(() => { gameState.pose = 'idle'; }, 1200);
}

export function handleCanvasClickGame(e) {
  if (_dragJustEnded) { setDragJustEnded(false); return; }
  const cvs = document.getElementById('game-canvas');
  const rect = cvs.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / TILE_SIZE);
  const y = Math.floor((e.clientY - rect.top) / TILE_SIZE);

  if (furnitureMode && ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'place_furniture', payload: { roomId: currentRoomId, itemId: furnitureMode.itemId, x, y, rotation: furnitureMode.rotation || 0 } }));
    setFurnitureMode(null);
    setFurnPreview(null);
    return;
  }

  if (furnEditMode && !furnitureMode) {
    setSelectedFurnInstance(null);
    return;
  }

  const allFurn = [...(ROOM.furniture||[]), ...liveFurniture];
  for (const f of allFurn) {
    const def = MANIFEST.furniture?.[f.itemId];
    if (def?.sittable) {
      const gw = def.gridWidth || 1;
      const gh = def.gridHeight || 1;
      if (x >= f.x && x < f.x + gw && y >= f.y && y < f.y + gh) {
        if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'sit', payload: { x, y, furnitureKey: f.itemId } }));
        return;
      }
    }
  }
}
