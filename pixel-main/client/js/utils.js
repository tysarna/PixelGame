import {
  ROOM, TILESET, TILE_SIZE, CELL, MANIFEST, tileImages,
  TILE_FALLBACK, tileCanvasCache,
  setTILE_SIZE, setSCALE, setTileCanvasCache
} from './state.js';

export function log(msg, cls = '') {
  const bar = document.getElementById('log-bar');
  const t = new Date().toLocaleTimeString('en', { hour12: false });
  bar.innerHTML += `<div class="entry ${cls}">[${t}] ${msg}</div>`;
  bar.scrollTop = bar.scrollHeight;
}

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    img.src = url;
  });
}

export function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function computeTileScale() {
  const availW = innerWidth - 40;
  const availH = innerHeight - 140;
  const newTileSize = Math.max(32, Math.min(
    Math.floor(availW * 0.90 / (ROOM.width || 12)),
    Math.floor(availH * 0.90 / (ROOM.height || 12))
  ));
  setTILE_SIZE(newTileSize);
  setSCALE(Math.max(2, Math.round(newTileSize * 2 / CELL)));
}

export function buildTileCanvas() {
  const w = ROOM.width || 12, h = ROOM.height || 12;
  const cvs = document.createElement('canvas');
  cvs.width  = w * TILE_SIZE;
  cvs.height = h * TILE_SIZE;
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = ROOM.tileMap[y][x];
      const img = tileImages[id];
      if (img) {
        ctx.drawImage(img, x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      } else {
        ctx.fillStyle = TILE_FALLBACK[id] || '#1a1a2e';
        ctx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
  }
  setTileCanvasCache(cvs);
}
