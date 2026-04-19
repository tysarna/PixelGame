import {
  CFG, CELL, characters, selectedChar,
  setCharacters, setSelectedChar
} from './state.js';
import { log, loadImage } from './utils.js';
import { enterRoom } from './room.js';

export async function fetchCharacters() {
  const grid = document.getElementById('char-grid');
  grid.innerHTML = '<div class="grid-loading">Loading characters…</div>';
  try {
    const resp = await fetch(CFG.listApi);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    setCharacters(await resp.json());
    const { characters: chars } = await import('./state.js');
    log(`Fetched ${chars.length} character(s)`, 'ok');
  } catch (err) {
    log(`Character list: ${err.message}`, 'error');
    grid.innerHTML = '<div class="grid-empty">Could not load character list.</div>';
    return;
  }
  const { characters: chars } = await import('./state.js');
  if (!chars.length) {
    grid.innerHTML = '<div class="grid-empty">No characters yet. Generate some or use the input above.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const char of chars) {
    const cell = document.createElement('div');
    cell.className = 'char-cell';
    cell.title = char.id;
    const cvs = document.createElement('canvas');
    cvs.width = CELL; cvs.height = CELL;
    cell.appendChild(cvs);
    const label = document.createElement('div');
    label.className = 'char-id';
    label.textContent = char.id;
    cell.appendChild(label);
    cell.addEventListener('click', () => selectCharacter(char, cell));
    grid.appendChild(cell);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      cvs.getContext('2d').drawImage(img, 0, 0, CELL, CELL, 0, 0, CELL, CELL);
      char._img = img;
    };
    img.onerror = () => {
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ff6b6b33'; ctx.fillRect(0,0,CELL,CELL);
      ctx.fillStyle = '#ff6b6b'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText('ERR', CELL/2, CELL/2+3);
    };
    img.src = char.url;
  }
}

export function rebuildGrid() {
  const { characters: chars, selectedChar: selChar, CELL: cellSize } = (() => {
    // Use dynamic import pattern to get fresh state
    return { characters, selectedChar, CELL };
  })();
  const grid = document.getElementById('char-grid');
  if (!chars.length) {
    grid.innerHTML = '<div class="grid-empty">No characters yet. Generate some or use the input above.</div>';
    return;
  }
  grid.innerHTML = '';
  for (const char of chars) {
    const cell = document.createElement('div');
    cell.className = 'char-cell';
    if (char === selChar) cell.classList.add('selected');
    if (char._isNew) cell.classList.add('new-char');
    cell.title = char.id;
    const cvs = document.createElement('canvas');
    cvs.width = CELL; cvs.height = CELL;
    cell.appendChild(cvs);
    if (char._isNew) {
      const badge = document.createElement('div');
      badge.className = 'new-badge';
      badge.textContent = 'NEW';
      cell.appendChild(badge);
    }
    const label = document.createElement('div');
    label.className = 'char-id';
    label.textContent = char.id;
    cell.appendChild(label);
    cell.addEventListener('click', () => selectCharacter(char, cell));
    grid.appendChild(cell);

    if (char._img) {
      cvs.getContext('2d').drawImage(char._img, 0, 0, CELL, CELL, 0, 0, CELL, CELL);
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { cvs.getContext('2d').drawImage(img, 0, 0, CELL, CELL, 0, 0, CELL, CELL); char._img = img; };
      img.onerror = () => {
        const ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ff6b6b33'; ctx.fillRect(0,0,CELL,CELL);
        ctx.fillStyle = '#ff6b6b'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
        ctx.fillText('ERR', CELL/2, CELL/2+3);
      };
      img.src = char.url;
    }
  }
}

export function selectCharacter(char, cellEl) {
  document.querySelectorAll('.char-cell.selected').forEach(c => c.classList.remove('selected'));
  if (cellEl) cellEl.classList.add('selected');
  setSelectedChar(char);
  if (char._img) enterRoom(char._img);
  else {
    log(`Loading sprite for ${char.id}…`);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { char._img = img; enterRoom(img); };
    img.onerror = () => log(`Failed to load ${char.url}`, 'error');
    img.src = char.url;
  }
}
