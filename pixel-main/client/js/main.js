import {
  authState, ws, gameState, selectedChar, currentRoomId,
  ROOM_TEMPLATES, templateIdx, furnDrag, furnitureMode, furnEditMode, selectedFurnInstance,
  setCurrentRoomId, setWs
} from './state.js';
import { showScreen, log } from './utils.js';
import { signIn, signUp } from './auth.js';
import { boot } from './boot.js';
import { fetchCharacters } from './characters.js';
import { startGenerate, cancelGenerate } from './generate.js';
import { enterRoom, exitRoom, enterGame, switchTemplate } from './room.js';
import { connectWS, toggleChat } from './network.js';
import { tbAction, furnDragStart, furnDragMove, furnDragEnd, furnPreviewMove, furnRotate, furnCancelPreview, rotatePlacedFurniture } from './furniture.js';
import { sizeCanvas } from './canvas.js';
import { initRoomKeyboard } from './movement.js';
import { initTheme } from './theme.js';
import { tryMove, handleCanvasClickGame, exitGame, initGameLoop } from './game.js';

// ── AUTH UI ──
document.getElementById('show-signup').addEventListener('click', () => {
  document.getElementById('signin-form').style.display = 'none';
  document.getElementById('signup-form').style.display = 'block';
});
document.getElementById('show-signin').addEventListener('click', () => {
  document.getElementById('signup-form').style.display = 'none';
  document.getElementById('signin-form').style.display = 'block';
});

document.getElementById('signin-btn').addEventListener('click', async () => {
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  const errEl = document.getElementById('signin-error');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please fill in all fields'; return; }
  try {
    await signIn(email, password);
    connectWS();
    showScreen('select-screen');
    fetchCharacters();
  } catch (e) {
    errEl.textContent = e.message || 'Sign in failed';
  }
});

document.getElementById('signup-btn').addEventListener('click', async () => {
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const name = document.getElementById('signup-name').value.trim();
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  if (!email || !password || !name) { errEl.textContent = 'Please fill in all fields'; return; }
  if (password.length < 8) { errEl.textContent = 'Password must be 8+ characters'; return; }
  try {
    await signUp(email, password, name);
    document.getElementById('signup-form').style.display = 'none';
    document.getElementById('signin-form').style.display = 'block';
    document.getElementById('signin-email').value = email;
    errEl.textContent = '';
    const successDiv = document.createElement('div');
    successDiv.className = 'auth-error';
    successDiv.style.color = 'var(--accent)';
    successDiv.textContent = 'Account created! Please sign in.';
    errEl.parentNode.insertBefore(successDiv, errEl);
  } catch (e) {
    errEl.textContent = e.message || 'Sign up failed';
  }
});

// ── EXPOSE GLOBALS for onclick handlers in HTML ──
window.startGenerate = startGenerate;
window.cancelGenerate = cancelGenerate;
window.exitRoom = exitRoom;
window.switchTemplate = switchTemplate;
window.enterGame = enterGame;
window.exitGame = exitGame;
window.tbAction = tbAction;
window.toggleChat = toggleChat;

// ── RESIZE ──
addEventListener('resize', () => {
  if (document.getElementById('room-screen').classList.contains('active')) sizeCanvas();
});

// ── ROOM KEYBOARD ──
initRoomKeyboard();

// ── GAME KEYBOARD ──
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('game-screen').classList.contains('active')) return;
  if (document.getElementById('chat-input') === document.activeElement) return;

  // Furniture preview mode: arrow keys rotate, Escape cancels
  if (furnitureMode) {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); furnRotate(-1); return; }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); furnRotate(1); return; }
    if (e.key === 'Escape') { e.preventDefault(); furnCancelPreview(); return; }
    return; // block other keys during placement
  }

  // Rotate selected placed furniture in edit mode
  if (furnEditMode && selectedFurnInstance) {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { e.preventDefault(); rotatePlacedFurniture(-1); return; }
    if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { e.preventDefault(); rotatePlacedFurniture(1); return; }
  }

  const dirMap = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', W: 'up', s: 'down', S: 'down', a: 'left', A: 'left', d: 'right', D: 'right'
  };
  if (dirMap[e.key]) {
    e.preventDefault();
    tryMove(dirMap[e.key]);
  }
  if (e.key === 'Escape') {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'stand', payload: {} }));
  }
  if (e.key === ' ') { e.preventDefault(); sendEmote('wave'); }
  if (e.key === 'e' || e.key === 'E') sendEmote('eat');
  if (e.key === 'r' || e.key === 'R') sendEmote('laugh');
  if (e.key === 'z' || e.key === 'Z') sendEmote('sleep');
});

function sendEmote(emoteName) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'emote', payload: { emote: emoteName } }));
  // Immediate local feedback
  import('./game.js').then(m => m.applyLocalEmote(emoteName));
}

// ── CHAT ──
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'chat', payload: { text } }));
  input.value = '';
});

// ── THEME ──
initTheme();

// ── GO ──
boot();
