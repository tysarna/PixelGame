import {
  CFG, MANIFEST, ROOM, TILESET, TILE_SIZE, CELL,
  tileImages, furnitureImages,
  setCFG, setMANIFEST, setROOM, setTILESET, setTILE_SIZE, setCELL, setDIR_ROW, setPOSE_COL
} from './state.js';
import { log, showScreen, loadImage } from './utils.js';

export async function boot() {
  const bootText = document.getElementById('boot-text');
  try {
    // 1. config
    bootText.textContent = 'Loading config…';
    const cfgResp = await fetch('/config.json');
    if (!cfgResp.ok) throw new Error(`config.json: HTTP ${cfgResp.status}`);
    const cfg = await cfgResp.json();
    setCFG(cfg);
    log('config.json loaded', 'ok');

    // 2. manifest
    bootText.textContent = 'Loading manifest…';
    const manResp = await fetch('/manifest.json');
    if (!manResp.ok) throw new Error(`manifest.json: HTTP ${manResp.status}`);
    const manifest = await manResp.json();
    setMANIFEST(manifest);
    setTILESET(manifest.tileset || {});
    setTILE_SIZE(manifest.tileSize || 32);
    setCELL(manifest.spriteSheet?.cellSize || 32);
    setDIR_ROW(manifest.spriteSheet?.rowMap || { down:0, left:1, up:2, right:3 });
    setPOSE_COL(manifest.spriteSheet?.colMap || { idle:0, stepA:1, stepB:2, sit:3, wave:4, sleep:5, eat:6, laugh:7 });
    log('manifest.json loaded', 'ok');

    // 3. default room
    bootText.textContent = 'Loading room…';
    // Re-read CFG from state since we just set it
    const { CFG: updatedCFG, TILESET: updatedTILESET, MANIFEST: updatedMANIFEST } = await import('./state.js');
    const roomPath = updatedCFG.defaultRoom || '/rooms/default.json';
    const roomResp = await fetch(roomPath);
    if (!roomResp.ok) throw new Error(`room json: HTTP ${roomResp.status}`);
    const room = await roomResp.json();
    setROOM(room);
    log(`Room "${room.name}" loaded (${room.width}x${room.height})`, 'ok');

    // 4. load tile sprites
    bootText.textContent = 'Loading tiles…';
    const usedTiles = new Set();
    for (const row of room.tileMap) for (const id of row) usedTiles.add(id);

    await Promise.all([...usedTiles].map(id => {
      const def = updatedTILESET[id];
      if (!def) { log(`Warning: tile "${id}" missing from tileset`, 'error'); return; }
      return loadImage(def.sprite).then(img => { tileImages[id] = img; })
        .catch(() => log(`Failed to load tile: ${id}`, 'error'));
    }));
    log(`${Object.keys(tileImages).length} tile sprites loaded`, 'ok');

    // 5. load furniture sprites
    bootText.textContent = 'Loading furniture…';
    const usedFurn = new Set((room.furniture || []).map(f => f.itemId));
    await Promise.all([...usedFurn].map(itemId => {
      const def = updatedMANIFEST.furniture?.[itemId];
      if (!def) { log(`Warning: furniture "${itemId}" missing from manifest`, 'error'); return; }
      return loadImage(def.sprite).then(img => { furnitureImages[itemId] = img; })
        .catch(() => log(`Failed to load furniture: ${itemId}`, 'error'));
    }));
    log(`${Object.keys(furnitureImages).length} furniture sprites loaded`, 'ok');

    // Boot complete → show auth
    showScreen('auth-screen');
    log('Boot complete', 'ok');

  } catch (err) {
    log(`Boot failed: ${err.message}`, 'error');
    bootText.innerHTML = '';
    document.querySelector('.boot-spinner').style.display = 'none';
    const errDiv = document.createElement('div');
    errDiv.className = 'boot-error';
    errDiv.innerHTML = `Failed to load: ${err.message}<br><br>
      Make sure config.json, manifest.json, and the room JSON are uploaded to S3.`;
    document.getElementById('boot-screen').appendChild(errDiv);
  }
}
