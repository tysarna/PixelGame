import {
  authState, ws, gameState, liveFurniture, onlineState, currentRoomId,
  ROOM_TEMPLATES, templateIdx, MANIFEST, furnitureImages, genTimer, spriteCache,
  setWs, setGameState, setLiveFurniture, setCurrentRoomId, setTemplateIdx
} from './state.js';
import { log, showScreen, loadImage, escapeHtml } from './utils.js';
import { computeTileScale, buildTileCanvas } from './utils.js';
import { loadTemplate } from './room.js';
import { rebuildGrid } from './characters.js';
import { enterRoom } from './room.js';
import { renderOnlinePanel } from './game.js';
import { renderGame } from './game.js';

let _reconnectTimer = null;
let _lastOnOpen = null;
let _intentionalClose = false;

export function disconnectWS() {
  _intentionalClose = true;
}

export function connectWS(onOpen) {
  if (onOpen) _lastOnOpen = onOpen;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  try {
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${WS_PROTOCOL}//${window.location.host}/ws?token=${encodeURIComponent(authState.jwt)}`;
    const socket = new WebSocket(wsUrl);
    setWs(socket);
    socket.onopen = () => { log('WebSocket connected', 'ok'); if (onOpen) onOpen(socket); };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWSMessage(msg);
        log('WS ← ' + msg.type);
      } catch { log('WS ← ' + e.data); }
    };
    socket.onerror = () => log('WebSocket error', 'error');
    socket.onclose = (e) => {
      log(`WebSocket closed: ${e.code}`);
      if (e.code === 4001) {
        alert('Authentication failed. Please sign in again.');
        showScreen('auth-screen');
        return;
      }
      // Auto-reconnect after unexpected close (not auth failure, not intentional)
      if (_intentionalClose) { _intentionalClose = false; return; }
      if (authState.jwt && !_reconnectTimer) {
        log('Reconnecting in 3s…');
        _reconnectTimer = setTimeout(() => {
          _reconnectTimer = null;
          connectWS((sock) => {
            // Re-join the room we were in
            if (currentRoomId) {
              sock.send(JSON.stringify({ type: 'join_room', payload: { roomId: currentRoomId, avatarUrl: gameState.avatarUrl || '' } }));
              sock.send(JSON.stringify({ type: 'get_online_players', payload: {} }));
            }
          });
        }, 3000);
      }
    };
  } catch (err) { log(`WS failed: ${err.message}`, 'error'); }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'room_state':
      gameState.players = {};
      setLiveFurniture((msg.furniture || []).map(f => ({ instanceId: f.instanceId, itemId: f.itemId, x: f.x, y: f.y, rotation: f.rotation || 0 })));
      liveFurniture.forEach(f => ensureFurnitureSprite(f.itemId));
      if (msg.players) msg.players.forEach(p => { gameState.players[p.playerId] = p; });
      gameState.self = gameState.players[authState.playerId] || null;
      // Remember which templates this user has decorated
      {
        const tpl = msg.template || ROOM_TEMPLATES[templateIdx]?.id;
        const myRooms = JSON.parse(localStorage.getItem('pixelMyRooms') || '{}');
        if ((msg.furniture || []).length > 0) {
          myRooms[tpl] = msg.furniture.length;
        } else {
          delete myRooms[tpl];
        }
        localStorage.setItem('pixelMyRooms', JSON.stringify(myRooms));
      }
      if (msg.template && msg.template !== ROOM_TEMPLATES[templateIdx]?.id) {
        const idx = ROOM_TEMPLATES.findIndex(t => t.id === msg.template);
        if (idx >= 0) setTemplateIdx(idx);
        loadTemplate(msg.template).then(() => { computeTileScale(); buildTileCanvas(); }).catch(e => log(`Room load failed: ${e.message}`, 'error'));
      }
      break;
    case 'player_joined':
      gameState.players[msg.playerId] = {
        playerId: msg.playerId,
        displayName: msg.displayName,
        x: msg.x,
        y: msg.y,
        direction: msg.direction || 'down',
        pose: msg.pose || 'standing',
        avatarUrl: msg.avatarUrl,
      };
      break;
    case 'player_left':
      delete gameState.players[msg.playerId];
      spriteCache.delete(msg.playerId);
      break;
    case 'player_moved': {
      const p = gameState.players[msg.playerId];
      if (p) {
        p.x = msg.x; p.y = msg.y;
        p.direction = msg.direction || p.direction;
        p.pose = msg.pose || p.pose;
        if (msg.playerId !== authState.playerId) onPlayerMoved(msg.playerId);
      }
      break;
    }
    case 'character_generating':
      document.getElementById('gen-status').textContent = msg.payload?.message || 'Generating…';
      log(`Gen: ${msg.payload?.message}`, 'ok');
      break;
    case 'character_error':
      clearInterval(genTimer);
      document.getElementById('gen-overlay').classList.remove('active');
      document.getElementById('gen-btn').disabled = false;
      if (msg.payload?.code === 'AVATAR_LIMIT_REACHED') {
        log('Generation limit reached (2/2)', 'error');
        alert('You\'ve reached the limit of 2 character generations for this account.\nPick one from the grid below, or use the character you already generated.');
        break;
      }
      log(`Gen failed: ${msg.payload?.message}`, 'error');
      alert(`Character generation failed:\n${msg.payload?.message || 'Unknown error'}\n\nPlease try again.`);
      break;
    case 'character_created':
      clearInterval(genTimer);
      document.getElementById('gen-overlay').classList.remove('active');
      document.getElementById('gen-btn').disabled = false;
      gameState.avatarUrl = msg.payload.avatarUrl;
      authState.playerId = msg.payload.playerId || authState.playerId;
      log(`Generated: ${msg.payload.avatarUrl}`, 'ok');
      (async () => {
        document.getElementById('gen-status').textContent = 'Loading sprite…';
        const img = await loadImage(msg.payload.avatarUrl);
        const { characters, setCharacters, setSelectedChar } = await import('./state.js');
        const newChar = { id: msg.payload.avatarUrl.split('/').pop().replace('.png',''), url: msg.payload.avatarUrl, _img: img, _isNew: true };
        characters.unshift(newChar);
        setSelectedChar(newChar);
        rebuildGrid();
        enterRoom(img);
      })();
      break;
    case 'furniture_placed':
      liveFurniture.push({ instanceId: msg.instanceId, itemId: msg.itemId, x: msg.x, y: msg.y, rotation: msg.rotation || 0 });
      ensureFurnitureSprite(msg.itemId);
      break;
    case 'furniture_moved': {
      const fi = liveFurniture.find(f => f.instanceId === msg.instanceId);
      if (fi) { fi.x = msg.x; fi.y = msg.y; }
      break;
    }
    case 'furniture_rotated': {
      const fi = liveFurniture.find(f => f.instanceId === msg.instanceId);
      if (fi) fi.rotation = msg.rotation;
      break;
    }
    case 'furniture_removed':
      setLiveFurniture(liveFurniture.filter(f => f.instanceId !== msg.instanceId));
      break;
    case 'player_sat': {
      const p = gameState.players[msg.playerId];
      if (p) {
        p.x = msg.x; p.y = msg.y;
        p.pose = 'sitting';
      }
      if (msg.playerId === authState.playerId && gameState.self) {
        gameState.self.x = msg.x;
        gameState.self.y = msg.y;
        gameState.self.pose = 'sitting';
        gameState.pose = 'sitting';
      }
      break;
    }
    case 'player_stood': {
      const p = gameState.players[msg.playerId];
      if (p) p.pose = 'standing';
      if (msg.playerId === authState.playerId && gameState.self) {
        gameState.self.pose = 'standing';
        gameState.pose = 'idle';
      }
      break;
    }
    case 'chat_message':
      handleChatMessage(msg);
      break;
    case 'online_players':
      onlineState.clear();
      msg.players.forEach(p => onlineState.set(p.playerId, { displayName: p.displayName, roomId: p.roomId }));
      renderOnlinePanel();
      break;
    case 'player_online':
      onlineState.set(msg.playerId, { displayName: msg.displayName, roomId: null });
      renderOnlinePanel();
      break;
    case 'player_offline':
      onlineState.delete(msg.playerId);
      renderOnlinePanel();
      break;
    case 'player_room_changed':
      if (onlineState.has(msg.playerId)) {
        onlineState.get(msg.playerId).roomId = msg.roomId;
      } else {
        onlineState.set(msg.playerId, { displayName: msg.displayName, roomId: msg.roomId });
      }
      renderOnlinePanel();
      break;
    case 'error':
      log(`Server: ${msg.payload?.message || msg.payload?.code || 'unknown error'}`, 'error');
      break;
  }
  renderGame();
}

function onPlayerMoved(playerId) {
  const sprite = spriteCache.get(playerId);
  if (sprite) sprite.onMove();
}

function handleChatMessage(msg) {
  const el = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="name">${escapeHtml(msg.displayName || msg.playerId)}:</span> <span class="text">${escapeHtml(msg.text)}</span>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function ensureFurnitureSprite(itemId) {
  if (furnitureImages[itemId]) return;
  const def = MANIFEST.furniture?.[itemId];
  if (!def) return;
  loadImage(def.sprite).then(img => { furnitureImages[itemId] = img; }).catch(() => {});
}

export function toggleChat() {
  const section = document.getElementById('chat-section');
  const btn = document.getElementById('chat-toggle-btn');
  const collapsed = section.classList.toggle('collapsed');
  btn.textContent = collapsed ? '▲' : '▼';
}
