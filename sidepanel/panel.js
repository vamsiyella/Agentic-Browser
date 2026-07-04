// sidepanel/panel.js

const serverUrlEl = document.getElementById('serverUrl');
const taskEl      = document.getElementById('task');
const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const statusEl    = document.getElementById('status');
const logEl       = document.getElementById('log');

// ── Port to service worker ────────────────────────────────────────────────

let port = null;

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 1000);
  });
}

connect();

// ── Message handler ───────────────────────────────────────────────────────

function onMessage(msg) {
  switch (msg.type) {
    case 'PING': break;

    case 'LOG':
      addLog(msg.level, msg.text, msg.ts);
      break;

    case 'SCREENSHOT':
      addScreenshot(msg.data, msg.url);
      break;

    case 'DONE':
      addLog('success', `✓ Done: ${msg.result}`);
      setIdle();
      break;

    case 'ERROR':
      addLog('error', `✗ ${msg.message}`);
      setIdle();
      break;
  }
}

// ── Controls ──────────────────────────────────────────────────────────────

function startTask() {
  const task = taskEl.value.trim();
  const serverUrl = serverUrlEl.value.trim();
  if (!task) { addLog('error', 'Enter a task first.'); return; }
  if (!serverUrl) { addLog('error', 'Enter server URL.'); return; }
  if (!port) { addLog('error', 'Not connected to background. Reload extension.'); return; }

  logEl.innerHTML = '';
  addLog('info', `Server: ${serverUrl}`);
  addLog('info', `Task: ${task}`);

  port.postMessage({ type: 'START', task, serverUrl });

  startBtn.disabled = true;
  stopBtn.disabled  = false;
  statusEl.textContent = 'running';
  statusEl.className   = 'running';
}

function stopTask() {
  if (port) port.postMessage({ type: 'STOP' });
  setIdle();
}

function setIdle() {
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  statusEl.textContent = 'idle';
  statusEl.className   = '';
}

startBtn.onclick = startTask;
stopBtn.onclick  = stopTask;

// Also start on Ctrl+Enter in textarea
taskEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) startTask();
});

// Persist server URL across panel opens
chrome.storage.session.get('serverUrl').then(v => {
  if (v.serverUrl) serverUrlEl.value = v.serverUrl;
});
serverUrlEl.addEventListener('change', () => {
  chrome.storage.session.set({ serverUrl: serverUrlEl.value });
});

// ── Log helpers ───────────────────────────────────────────────────────────

function addLog(level, text, ts) {
  const t = ts || new Date().toLocaleTimeString('en-US', { hour12: false });
  const div = document.createElement('div');
  div.className = `entry ${level}`;
  div.innerHTML = `<span class="ts">${t}</span><span class="msg">${escHtml(text)}</span>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function addScreenshot(base64, url) {
  const div = document.createElement('div');
  div.className = 'entry info screenshot-entry';
  div.innerHTML = `
    <span class="ts">   </span>
    <span class="msg">
      <span style="color:#3d444d;font-size:10px">${escHtml(url)}</span>
      <img src="data:image/jpeg;base64,${base64}" alt="screenshot">
    </span>`;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
