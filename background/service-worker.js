// background/service-worker.js
import { AgentLoop } from './agent-loop.js';

let loop = null;
let activePort = null;
let globalLogs = []; // Stores the UI history

// Open sidepanel on icon click
chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Chrome will not allow content-script injection or scripting on these —
// this is enforced by Chrome itself, there is no workaround. Detect it
// BEFORE starting the loop so the user gets a clear message instead of
// the loop silently retrying/failing inside _observe().
const RESTRICTED_URL_PATTERNS = [
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^chrome-untrusted:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^devtools:\/\//i,
  /^view-source:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
];

function getRestrictedUrlReason(url) {
  if (!url) return 'No page URL available.';
  if (url.endsWith('.pdf') || url.includes('/pdf/')) {
    return `Chrome's built-in PDF viewer blocks extension scripting. Open a regular http/https page instead.`;
  }
  for (const pattern of RESTRICTED_URL_PATTERNS) {
    if (pattern.test(url)) {
      return `"${url}" is a browser-internal page. Chrome blocks extensions from running on chrome://, extension, and webstore pages for security reasons — this cannot be worked around. Navigate to a normal http/https page first.`;
    }
  }
  return null; // not restricted
}

// SINGLE listener only — there was previously a duplicate onConnect listener
// registered twice, which caused every START/STOP message to be handled
// twice by two different loop-tracking variables (one of which,
// `currentLoop`, was never even declared). That bug has been removed.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return;

  activePort = port;

  // HYDRATION: send all past logs to the newly opened panel
  globalLogs.forEach(msg => {
    try { port.postMessage(msg); } catch {}
  });

  // Keep service worker alive while panel is open
  const keepAlive = setInterval(() => {
    try { port.postMessage({ type: 'PING' }); } catch {}
  }, 20000);

  port.onMessage.addListener(async msg => {
    if (msg.type === 'START') {
      if (loop) loop.stop();
      globalLogs = []; // clear history on new run

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        broadcastUpdate({ type: 'LOG', level: 'error', text: 'No active tab found.' });
        return;
      }

      const restrictedReason = getRestrictedUrlReason(tab.url);
      if (restrictedReason) {
        broadcastUpdate({ type: 'ERROR', message: restrictedReason });
        return;
      }

      broadcastUpdate({ type: 'LOG', level: 'info', text: 'Starting new task...' });

      loop = new AgentLoop(msg.serverUrl, broadcastUpdate);
      loop.run(msg.task, tab.id);
      return;
    }

    if (msg.type === 'STOP') {
      if (loop) { loop.stop(); loop = null; }
      broadcastUpdate({ type: 'LOG', level: 'warn', text: 'Task stopped by user.' });
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    clearInterval(keepAlive);
    activePort = null;
    if (loop) { loop.stop(); loop = null; }
  });
});

function broadcastUpdate(msg) {
  // Save to history (cap at 100 items to prevent memory leaks)
  globalLogs.push(msg);
  if (globalLogs.length > 100) globalLogs.shift();

  // Send to UI if open
  if (activePort) {
    try { activePort.postMessage(msg); } catch (e) { activePort = null; }
  }
}
