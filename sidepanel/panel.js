// sidepanel/panel.js

const serverUrlEl     = document.getElementById('serverUrl');
const taskEl          = document.getElementById('task');
const startBtn        = document.getElementById('startBtn');
const stopBtn         = document.getElementById('stopBtn');
const statusEl        = document.getElementById('status');
const logEl           = document.getElementById('log');
const usageEl         = document.getElementById('usage');
const clarifyEl       = document.getElementById('clarify');
const clarifyQuestion = document.getElementById('clarifyQuestion');
const clarifyInput    = document.getElementById('clarifyInput');
const clarifySubmit   = document.getElementById('clarifySubmit');

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

    case 'ASK_USER':
      showClarifyPrompt(msg.question);
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
  hideClarifyPrompt();
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
  hideClarifyPrompt();
  setIdle();
}

function setIdle() {
  startBtn.disabled = false;
  stopBtn.disabled  = true;
  statusEl.textContent = 'idle';
  statusEl.className   = '';
  hideClarifyPrompt();
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

// ── ask_user clarification prompt ─────────────────────────────────────────
// Shown when the agent pauses mid-task to ask something it genuinely can't
// infer (e.g. "is a layover okay, or nonstop only?"). The answer is sent
// back over the same port and forwarded to the running loop.

function showClarifyPrompt(question) {
  addLog('think', `🤔 Agent is asking: ${question}`);
  clarifyQuestion.textContent = question;
  clarifyEl.classList.remove('hidden');
  clarifyInput.value = '';
  clarifyInput.focus();
}

function hideClarifyPrompt() {
  clarifyEl.classList.add('hidden');
}

function submitClarifyAnswer() {
  const answer = clarifyInput.value.trim();
  if (!answer) return;
  if (port) port.postMessage({ type: 'USER_ANSWER', answer });
  addLog('info', `You answered: ${answer}`);
  hideClarifyPrompt();
}

clarifySubmit.onclick = submitClarifyAnswer;
clarifyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') submitClarifyAnswer();
});

// ── Usage / budget readout ─────────────────────────────────────────────────
// Polls the server's /api/budget so free-tier call/token usage (and, for
// Anthropic, $ spend against the configured caps) is visible without
// waiting for a 429 or a budget-exceeded error to find out the hard way.

async function pollUsage() {
  const serverUrl = serverUrlEl.value.trim();
  if (!serverUrl) return;
  try {
    const resp = await fetch(`${serverUrl.replace(/\/$/, '')}/api/budget`);
    if (!resp.ok) return;
    const b = await resp.json();
    renderUsage(b);
  } catch {
    // Server not reachable — leave the last known reading in place rather
    // than flashing an error on every poll tick.
  }
}

function renderUsage(b) {
  let text;
  let warn = false;

  if (b.provider === 'anthropic') {
    text = `${b.provider} · $${b.dailySpendUsd.toFixed(3)}/$${b.dailyBudgetUsd.toFixed(2)} today · ${b.callsToday} calls · ${b.callsLastMinute}/min`;
    warn = b.dailySpendUsd >= b.dailyBudgetUsd * 0.8;
  } else {
    text = `${b.provider} · ${b.callsToday} calls today · ${b.callsLastMinute} in last 60s · ~${b.tokensToday.toLocaleString()} tokens today`;
    warn = b.callsLastMinute >= 8; // heads-up before a free-tier RPM cap is likely hit
  }

  usageEl.textContent = text;
  usageEl.className = warn ? 'warn' : '';
}

setInterval(pollUsage, 5000);
pollUsage();

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
