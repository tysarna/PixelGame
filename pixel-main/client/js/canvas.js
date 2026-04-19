import { ROOM, TILE_SIZE } from './state.js';
import { computeTileScale, buildTileCanvas } from './utils.js';

export function positionArrows() {
  const cvs = document.getElementById('room-canvas');
  const rect = cvs.getBoundingClientRect();
  const prev = document.getElementById('template-prev');
  const next = document.getElementById('template-next');
  if (!prev || !next) return;
  const leftCenter  = Math.round(rect.left / 2);
  const rightCenter = Math.round(rect.right + (window.innerWidth - rect.right) / 2);
  prev.style.left      = leftCenter  + 'px';
  prev.style.right     = 'auto';
  prev.style.transform = 'translateX(-50%) translateY(-50%)';
  next.style.left      = rightCenter + 'px';
  next.style.right     = 'auto';
  next.style.transform = 'translateX(-50%) translateY(-50%)';
}

export function sizeCanvas() {
  computeTileScale();
  buildTileCanvas();
  const cvs = document.getElementById('room-canvas');
  const rw = (ROOM.width || 12) * TILE_SIZE;
  const rh = (ROOM.height || 12) * TILE_SIZE;
  cvs.width = rw; cvs.height = rh;
  cvs.style.width = rw + 'px'; cvs.style.height = rh + 'px';
  positionArrows();
}
