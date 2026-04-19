import {
  ROOM, TILESET, MANIFEST, ROOM_TEMPLATES, templateIdx,
  tileImages, furnitureImages, isLive, ws, authState, gameState, selectedChar,
  moveInterval, gameLoop, furnDrag,
  setROOM, setTemplateIdx, setPlayer, setWalkIdx, setSpriteSheet, setIsLive,
  setTileCanvasCache, setWs, setCurrentRoomId, setMoveInterval, setGameLoop
} from './state.js';
import { log, showScreen, loadImage } from './utils.js';
import { sizeCanvas } from './canvas.js';
import { startLoop } from './render.js';
import { fetchCharacters } from './characters.js';
import { connectWS, disconnectWS } from './network.js';
import { handleCanvasClickGame, initGameLoop } from './game.js';
import { furnDragStart, furnDragMove, furnDragEnd, furnPreviewMove } from './furniture.js';

export async function loadTemplate(id) {
  const resp = await fetch(`/rooms/${id}.json`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const room = await resp.json();
  setROOM(room);

  const usedTiles = new Set();
  for (const row of room.tileMap) for (const t of row) usedTiles.add(t);
  await Promise.all([...usedTiles].map(tileId => {
    if (tileImages[tileId]) return;
    const def = TILESET[tileId];
    if (!def) return;
    return loadImage(def.sprite).then(img => { tileImages[tileId] = img; }).catch(() => {});
  }));

  const usedFurn = new Set((room.furniture || []).map(f => f.itemId));
  await Promise.all([...usedFurn].map(itemId => {
    if (furnitureImages[itemId]) return;
    const def = MANIFEST.furniture?.[itemId];
    if (!def) return;
    return loadImage(def.sprite).then(img => { furnitureImages[itemId] = img; }).catch(() => {});
  }));

  setTileCanvasCache(null);
}

export async function switchTemplate(delta) {
  const newIdx = ((templateIdx + delta) % ROOM_TEMPLATES.length + ROOM_TEMPLATES.length) % ROOM_TEMPLATES.length;
  setTemplateIdx(newIdx);
  const t = ROOM_TEMPLATES[newIdx];
  try {
    await loadTemplate(t.id);
  } catch (e) {
    log(`Failed to load room template: ${e.message}`, 'error');
    return;
  }
  const sp = ROOM.spawnPoint || { x: 6, y: 6 };
  setPlayer({ x: sp.x, y: sp.y, direction: 'down', pose: 'idle' });
  setWalkIdx(0);
  sizeCanvas();
  const myRooms = JSON.parse(localStorage.getItem('pixelMyRooms') || '{}');
  const badge = myRooms[t.id] ? ` ★${myRooms[t.id]}` : '';
  document.getElementById('template-label').textContent = `${t.name}${badge}  [${newIdx + 1}/${ROOM_TEMPLATES.length}]`;
  log(`Room: ${t.name}`, 'ok');
}

export async function enterRoom(img) {
  setSpriteSheet(img);
  setIsLive(false);

  const saved = localStorage.getItem('pixelRoomTemplate');
  const idx = ROOM_TEMPLATES.findIndex(t => t.id === saved);
  setTemplateIdx(idx >= 0 ? idx : 0);

  try { await loadTemplate(ROOM_TEMPLATES[templateIdx].id); }
  catch (e) { if (templateIdx !== 0) { setTemplateIdx(0); await loadTemplate(ROOM_TEMPLATES[0].id); } }

  const myRooms = JSON.parse(localStorage.getItem('pixelMyRooms') || '{}');
  const t = ROOM_TEMPLATES[templateIdx];
  const badge = myRooms[t.id] ? ` ★${myRooms[t.id]}` : '';
  document.getElementById('template-prev').classList.add('visible');
  document.getElementById('template-next').classList.add('visible');
  document.getElementById('template-label').classList.add('visible');
  document.getElementById('template-label').textContent = `${t.name}${badge}  [${templateIdx + 1}/${ROOM_TEMPLATES.length}]`;
  log(`Rooms: ${ROOM_TEMPLATES.map((r,i) => (i===templateIdx?'▶ ':'')+r.name).join(' · ')}`, 'ok');

  const sp = ROOM.spawnPoint || { x: 6, y: 6 };
  setPlayer({ x: sp.x, y: sp.y, direction: 'down', pose: 'idle' });
  setWalkIdx(0);
  document.getElementById('room-label').textContent = 'PICK YOUR ROOM';
  document.getElementById('room-label').className = 'room-label';
  document.getElementById('enter-btn').style.display = '';
  document.getElementById('live-toolbar').classList.remove('visible');
  showScreen('room-screen');
  sizeCanvas(); startLoop();
  log(`arrows: prev.visible=${document.getElementById('template-prev').classList.contains('visible')} left=${document.getElementById('template-prev').style.left}`, 'ok');
}

export function exitRoom() {
  if (ws) { disconnectWS(); ws.close(); setWs(null); }
  if (moveInterval) { clearInterval(moveInterval); setMoveInterval(null); }
  if (gameLoop) { cancelAnimationFrame(gameLoop); setGameLoop(null); }
  setIsLive(false);
  showScreen('select-screen');
  fetchCharacters();
}

export function enterGame() {
  localStorage.setItem('pixelRoomTemplate', ROOM_TEMPLATES[templateIdx].id);

  document.getElementById('template-prev').classList.remove('visible');
  document.getElementById('template-next').classList.remove('visible');
  document.getElementById('template-label').classList.remove('visible');

  setIsLive(true);
  document.getElementById('enter-btn').style.display = 'none';
  document.getElementById('live-toolbar').classList.add('visible');
  document.getElementById('room-label').textContent = 'LIVE';
  document.getElementById('room-label').className = 'room-label live';
  gameState.avatarUrl = selectedChar?.url || gameState.avatarUrl || '';
  log('Live mode', 'ok');

  const joinAndShow = (socket) => {
    const chosenTemplate = ROOM_TEMPLATES[templateIdx].id;
    const compositeRoomId = `${authState.playerId}:${chosenTemplate}`;
    setCurrentRoomId(compositeRoomId);
    socket.send(JSON.stringify({ type: 'join_room', payload: { roomId: compositeRoomId, avatarUrl: gameState.avatarUrl } }));
    socket.send(JSON.stringify({ type: 'get_online_players', payload: {} }));
    setTimeout(() => {
      showScreen('game-screen');
      const cvs = document.getElementById('game-canvas');
      cvs.addEventListener('mousedown', (e) => { if (furnDragStart(e, cvs)) e.preventDefault(); });
      document.addEventListener('mousemove', (e) => { furnDragMove(e); furnPreviewMove(e, cvs); });
      document.addEventListener('mouseup', (e) => { if (furnDrag) furnDragEnd(e, cvs); });
      cvs.addEventListener('click', handleCanvasClickGame);
      initGameLoop();
    }, 300);
  };

  // Always establish a fresh connection when entering the game
  if (ws) { disconnectWS(); try { ws.close(); } catch(e) {} setWs(null); }
  if (authState.jwt) {
    connectWS(joinAndShow);
  }
}
