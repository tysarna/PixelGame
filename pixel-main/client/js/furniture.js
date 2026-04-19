import {
  furnEditMode, furnDrag, furnitureMode, liveFurniture, furnPreview,
  selectedFurnInstance,
  MANIFEST, TILE_SIZE, ROOM, ws, currentRoomId, furnitureImages,
  setFurnEditMode, setFurnDrag, setFurnitureMode, setFurnPreview, setDragJustEnded,
  setSelectedFurnInstance
} from './state.js';
import { log, loadImage } from './utils.js';

export function tbAction(a) {
  if (a === 'furniture') { toggleFurnitureEdit(); return; }
  if (a === 'chat') { document.getElementById('chat-input').focus(); return; }
  log(`[${a}] — not wired yet`);
}

export function toggleFurnitureEdit() {
  const newMode = !furnEditMode;
  setFurnEditMode(newMode);
  setFurnitureMode(null);
  setFurnPreview(null);
  const btns = document.querySelectorAll('.tb-btn');
  btns[0].style.background = newMode ? 'var(--accent-dim)' : '';
  btns[0].style.color = newMode ? 'var(--accent)' : '';
  let trash = document.getElementById('furn-trash');
  let picker = document.getElementById('furniture-picker');
  if (newMode) {
    if (!trash) {
      trash = document.createElement('div');
      trash.id = 'furn-trash';
      trash.className = 'furn-trash';
      trash.innerHTML = '🗑';
      document.getElementById('game-main').appendChild(trash);
    }
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'furniture-picker';
      picker.style.cssText = 'position:absolute;top:10px;right:16px;z-index:20;background:rgba(20,24,35,0.95);border:1px solid var(--border);border-radius:8px;padding:6px;display:flex;flex-wrap:wrap;gap:4px;max-width:260px;';
      for (const [itemId, def] of Object.entries(MANIFEST.furniture || {})) {
        const btn = document.createElement('button');
        btn.title = itemId.replace(/_/g, ' ');
        btn.style.cssText = 'width:40px;height:40px;background:#1a1e2e;border:1px solid #3a3f52;border-radius:4px;cursor:pointer;padding:2px;display:flex;align-items:center;justify-content:center;';
        const img = document.createElement('img');
        img.src = def.sprite;
        img.style.cssText = 'width:32px;height:32px;image-rendering:pixelated;';
        btn.appendChild(img);
        btn.onclick = () => {
          setFurnitureMode({ itemId, rotation: 0 });
          setFurnPreview(null);
          log(`Move mouse to canvas, arrow keys to rotate, click to place`, 'ok');
        };
        picker.appendChild(btn);
      }
      document.getElementById('game-main').appendChild(picker);
    }
    document.getElementById('game-canvas').style.cursor = 'grab';
    log('Furniture mode ON — drag to move, trash to delete, pick to place', 'ok');
  } else {
    if (trash) trash.remove();
    if (picker) picker.remove();
    document.getElementById('game-canvas').style.cursor = '';
    setSelectedFurnInstance(null);
    log('Furniture mode OFF');
  }
}

export function furnDragStart(e, canvasEl) {
  if (!furnEditMode || furnitureMode) return false;
  const rect = canvasEl.getBoundingClientRect();
  const tx = Math.floor((e.clientX - rect.left) / TILE_SIZE);
  const ty = Math.floor((e.clientY - rect.top) / TILE_SIZE);
  for (const f of liveFurniture) {
    const def = MANIFEST.furniture?.[f.itemId];
    if (!def) continue;
    const gw = def.gridWidth || 1, gh = def.gridHeight || 1;
    if (tx >= f.x && tx < f.x + gw && ty >= f.y && ty < f.y + gh) {
      setSelectedFurnInstance(f.instanceId);
      const ghost = document.createElement('img');
      ghost.className = 'furn-ghost';
      ghost.src = def.sprite;
      ghost.style.width = (gw * TILE_SIZE) + 'px';
      ghost.style.height = (gh * TILE_SIZE) + 'px';
      ghost.style.left = (e.clientX - 16) + 'px';
      ghost.style.top = (e.clientY - 16) + 'px';
      document.body.appendChild(ghost);
      setFurnDrag({ instanceId: f.instanceId, itemId: f.itemId, startX: f.x, startY: f.y, ghost });
      return true;
    }
  }
  return false;
}

export function furnDragMove(e) {
  if (!furnDrag) return;
  furnDrag.ghost.style.left = (e.clientX - 16) + 'px';
  furnDrag.ghost.style.top = (e.clientY - 16) + 'px';
  const trash = document.getElementById('furn-trash');
  if (trash) {
    const tr = trash.getBoundingClientRect();
    const over = e.clientX >= tr.left && e.clientX <= tr.right && e.clientY >= tr.top && e.clientY <= tr.bottom;
    trash.classList.toggle('over', over);
  }
}

export function furnDragEnd(e, canvasEl) {
  if (!furnDrag) return;
  furnDrag.ghost.remove();
  setDragJustEnded(true);
  const trash = document.getElementById('furn-trash');
  if (trash) {
    const tr = trash.getBoundingClientRect();
    if (e.clientX >= tr.left && e.clientX <= tr.right && e.clientY >= tr.top && e.clientY <= tr.bottom) {
      trash.classList.remove('over');
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'remove_furniture', payload: { roomId: currentRoomId, instanceId: furnDrag.instanceId } }));
      setFurnDrag(null);
      return;
    }
  }
  const rect = canvasEl.getBoundingClientRect();
  const tx = Math.floor((e.clientX - rect.left) / TILE_SIZE);
  const ty = Math.floor((e.clientY - rect.top) / TILE_SIZE);
  if (tx >= 0 && ty >= 0 && tx < 12 && ty < 12 && (tx !== furnDrag.startX || ty !== furnDrag.startY)) {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'move_furniture', payload: { roomId: currentRoomId, instanceId: furnDrag.instanceId, x: tx, y: ty } }));
  }
  setFurnDrag(null);
}

export function furnPreviewMove(e, canvasEl) {
  if (!furnitureMode) return;
  const rect = canvasEl.getBoundingClientRect();
  const tx = Math.floor((e.clientX - rect.left) / TILE_SIZE);
  const ty = Math.floor((e.clientY - rect.top) / TILE_SIZE);
  const rw = ROOM.width || 12;
  const rh = ROOM.height || 12;
  if (tx >= 0 && ty >= 0 && tx < rw && ty < rh) {
    setFurnPreview({ tileX: tx, tileY: ty });
  } else {
    setFurnPreview(null);
  }
}

export function furnRotate(direction) {
  if (!furnitureMode) return;
  const steps = [0, 90, 180, 270];
  const cur = steps.indexOf(furnitureMode.rotation);
  const next = (cur + direction + 4) % 4;
  setFurnitureMode({ ...furnitureMode, rotation: steps[next] });
}

export function rotatePlacedFurniture(direction) {
  if (!selectedFurnInstance) return;
  const f = liveFurniture.find(fi => fi.instanceId === selectedFurnInstance);
  if (!f) return;
  const steps = [0, 90, 180, 270];
  const cur = steps.indexOf(f.rotation ?? 0);
  const next = steps[(cur + direction + 4) % 4];
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ type: 'rotate_furniture', payload: { roomId: currentRoomId, instanceId: selectedFurnInstance, rotation: next } }));
  }
}

export function furnCancelPreview() {
  if (!furnitureMode) return;
  setFurnitureMode(null);
  setFurnPreview(null);
  log('Placement cancelled');
}
