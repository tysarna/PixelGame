import {
  ROOM, MANIFEST, TILE_SIZE, CELL, SCALE, DIR_ROW, POSE_COL,
  player, spriteSheet, selectedChar, tileCanvasCache, furnitureImages, gameLoop,
  setGameLoop
} from './state.js';

export function render() {
  const cvs = document.getElementById('room-canvas');
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cvs.width, cvs.height);

  if (tileCanvasCache) ctx.drawImage(tileCanvasCache, 0, 0);

  const drawList = [];

  for (const f of (ROOM.furniture || [])) {
    const def = MANIFEST.furniture?.[f.itemId];
    const img = furnitureImages[f.itemId];
    const gw = def?.gridWidth || 1;
    const gh = def?.gridHeight || 1;
    const fw = gw * TILE_SIZE * 2;
    const fh = gh * TILE_SIZE * 2;
    const footCX = f.x * TILE_SIZE + gw * TILE_SIZE / 2;
    const footBY = f.y * TILE_SIZE + gh * TILE_SIZE;
    const fx = footCX - fw / 2;
    const fy = footBY - fh;
    drawList.push({ sortY: footBY, draw() {
      if (img) {
        ctx.drawImage(img, fx, fy, fw, fh);
      } else if (def) {
        ctx.fillStyle = '#2a3040';
        ctx.fillRect(fx, fy, fw, fh);
        ctx.fillStyle = '#555d73'; ctx.font = '8px monospace';
        ctx.fillText(f.itemId.split('_')[0], fx + 2, fy + 10);
      }
    }});
  }

  if (spriteSheet) {
    const px = player.x * TILE_SIZE + TILE_SIZE / 2;
    const py = player.y * TILE_SIZE + TILE_SIZE / 2;
    const dw = CELL * SCALE;
    const dh = CELL * SCALE;
    drawList.push({ sortY: py + dh / 2, draw() {
      const row = DIR_ROW[player.direction] ?? 0;
      const col = POSE_COL[player.pose] ?? 0;
      const dx = px - dw / 2;
      const dy = py - dh / 2;
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(px, py + dh / 2 - 6, 16, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.drawImage(spriteSheet, col * CELL, row * CELL, CELL, CELL, dx, dy, dw, dh);
      ctx.fillStyle = '#fff'; ctx.font = '8px "Press Start 2P"'; ctx.textAlign = 'center';
      ctx.fillText(selectedChar?.id ?? 'You', px, dy - 4);
    }});
  }

  drawList.sort((a, b) => a.sortY - b.sortY);
  for (const item of drawList) item.draw();

  setGameLoop(requestAnimationFrame(render));
}

export function startLoop() {
  if (gameLoop) cancelAnimationFrame(gameLoop);
  render();
}
