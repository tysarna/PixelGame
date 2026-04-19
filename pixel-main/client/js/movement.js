import {
  ROOM, TILESET, MANIFEST, WALK_SEQ,
  player, walkIdx, walkTimer, keysDown, moveInterval, isLive, ws,
  setPlayer, setWalkIdx, setWalkTimer, setMoveInterval
} from './state.js';

export function isWalkable(x, y) {
  if (y < 0 || y >= ROOM.height || x < 0 || x >= ROOM.width) return false;
  const id = ROOM.tileMap[y]?.[x];
  const tile = TILESET[id];
  if (!tile || !tile.walkable) return false;
  for (const f of (ROOM.furniture || [])) {
    const def = MANIFEST.furniture?.[f.itemId];
    if (!def) continue;
    if (def.sittable) continue;
    if (x >= f.x && x < f.x + (def.gridWidth||1) && y >= f.y && y < f.y + (def.gridHeight||1)) return false;
  }
  return true;
}

export function movePlayer(dir) {
  let nx = player.x, ny = player.y;
  if (dir==='up') ny--; if (dir==='down') ny++; if (dir==='left') nx--; if (dir==='right') nx++;
  player.direction = dir;
  if (isWalkable(nx,ny)) {
    player.x = nx; player.y = ny;
    const newIdx = (walkIdx+1) % WALK_SEQ.length;
    setWalkIdx(newIdx);
    player.pose = WALK_SEQ[newIdx];
    clearTimeout(walkTimer);
    setWalkTimer(setTimeout(() => { player.pose='idle'; setWalkIdx(0); }, 200));
    if (isLive && ws?.readyState === 1)
      ws.send(JSON.stringify({ type:'move', payload:{ x:player.x, y:player.y, direction:dir } }));
  }
}

export function doEmote(e) {
  player.pose = e;
  clearTimeout(walkTimer);
  setWalkTimer(setTimeout(() => { player.pose='idle'; }, 1200));
}

const KEY_DIR = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right', w:'up', s:'down', a:'left', d:'right', W:'up', S:'down', A:'left', D:'right' };

export function initRoomKeyboard() {
  addEventListener('keydown', (e) => {
    if (!document.getElementById('room-screen').classList.contains('active')) return;
    if (KEY_DIR[e.key]) {
      e.preventDefault(); keysDown.add(KEY_DIR[e.key]);
      if (!moveInterval) {
        movePlayer(KEY_DIR[e.key]);
        setMoveInterval(setInterval(() => { for (const d of ['up','down','left','right']) if (keysDown.has(d)) { movePlayer(d); break; } }, 140));
      }
    }
    if (e.key===' ') { e.preventDefault(); doEmote('wave'); }
    if (e.key==='e'||e.key==='E') doEmote('eat');
    if (e.key==='r'||e.key==='R') doEmote('laugh');
    if (e.key==='z'||e.key==='Z') doEmote('sleep');
  });
  addEventListener('keyup', (e) => {
    if (KEY_DIR[e.key]) { keysDown.delete(KEY_DIR[e.key]); if (!keysDown.size && moveInterval) { clearInterval(moveInterval); setMoveInterval(null); } }
  });
}
