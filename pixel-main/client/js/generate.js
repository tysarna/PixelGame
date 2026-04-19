import { ws, authState, genController, genTimer, setGenController, setGenTimer } from './state.js';
import { log } from './utils.js';
import { connectWS } from './network.js';

export async function startGenerate() {
  const desc = document.getElementById('desc-input').value.trim();
  if (!desc) { log('Type a description first', 'error'); return; }

  const overlay = document.getElementById('gen-overlay');
  overlay.classList.add('active');
  document.getElementById('gen-status').textContent = 'Connecting…';
  let sec = 0;
  document.getElementById('gen-time').textContent = '0s';
  setGenTimer(setInterval(() => {
    sec++;
    document.getElementById('gen-time').textContent = sec + 's';
  }, 1000));
  setGenController(new AbortController());
  document.getElementById('gen-btn').disabled = true;

  const sendCreate = (socket) => {
    document.getElementById('gen-status').textContent = 'Sending to AI…';
    socket.send(JSON.stringify({ type: 'create_character', payload: { description: desc } }));
  };

  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendCreate(ws);
    } else if (authState.jwt) {
      connectWS(sendCreate);
    } else {
      throw new Error('Not signed in');
    }
  } catch (err) {
    const { genTimer: timer } = await import('./state.js');
    clearInterval(timer); overlay.classList.remove('active');
    document.getElementById('gen-btn').disabled = false;
    log(`Failed: ${err.message}`, 'error');
  }
}

export function cancelGenerate() {
  const { genController: ctrl, genTimer: timer } = (() => {
    return { genController, genTimer };
  })();
  if (ctrl) ctrl.abort();
  clearInterval(timer);
  document.getElementById('gen-overlay').classList.remove('active');
  document.getElementById('gen-btn').disabled = false;
}
