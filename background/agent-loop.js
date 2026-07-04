// background/agent-loop.js
// Observe → Plan → Execute → Recover cycle.
// No separate verify API call — saves rate limits.
// The next observation naturally shows whether the action worked.

import { LLMClient } from './llm-client.js';

const MAX_STEPS = 30;
const MAX_CONSECUTIVE_FAILURES = 3;
const POST_ACTION_DELAY_MS = 500;
const POST_NAV_EXTRA_MS = 800;
const NEW_TAB_DETECT_DELAY_MS = 350;

// Actions that don't touch a specific DOM element at all. These MUST still
// be allowed to run when the current page has zero interactive elements —
// a pure-text article, a blank tab, a page still loading, or a task that's
// just "open a new tab" have nothing to click and don't need to.
const ACTIONS_REQUIRING_ELEMENT = new Set(['click', 'type', 'select', 'hover']);

export class AgentLoop {
  constructor(serverUrl, onUpdate) {
    this.client = new LLMClient(serverUrl);
    this.onUpdate = onUpdate;
    this.running = false;
    this.history = [];
    this.consecutiveFailures = 0;
    this.consecutivePlanFailures = 0;
    this.lastActionSignature = null;
    this.sameActionStreak = 0;
    this.tabId = null;
    this.taskId = null;
    this.overallPlan = null;
    this.lastObservedElements = {};
    // Ground-truth record of every DISTINCT page actually visited, computed
    // from real observations — never from the model's own "thought" text.
    // This is what lets the model check itself against reality instead of
    // trusting its own (possibly stale/repeated) reasoning from a prior step.
    this.urlTrail = [];
  }

  stop() { this.running = false; }

  // ─── MAIN LOOP ────────────────────────────────────────────────────────────

  async run(task, tabId) {
    this.running = true;
    this.history = [];
    this.consecutiveFailures = 0;
    this.consecutivePlanFailures = 0;
    this.lastActionSignature = null;
    this.sameActionStreak = 0;
    this.startUrl = null;
    this.tabId = tabId;
    this.taskId = (crypto.randomUUID && crypto.randomUUID()) || `task-${Date.now()}`;
    this.overallPlan = null;
    this.urlTrail = [];

    this._log('info', `Starting task: ${task}`);

    try {
      for (let step = 0; step < MAX_STEPS && this.running; step++) {
        this._log('info', `── Step ${step + 1} ──────────────`);

        // ── OBSERVE ──────────────────────────────────────────────────────
        let obs;
        try {
          obs = await this._observe(this.tabId);

          if (Object.keys(obs.elementMap).length === 0) {
            this._log('warn', 'No interactive elements detected — retrying once in case the page is still rendering.');
            await sleep(1000);
            obs = await this._observe(this.tabId);
          }

          this._log('info', `Observed: ${obs.pageContext.url}`);
          this._log('info', `DOM: ${Object.keys(obs.elementMap).length} elements`);
          if (Object.keys(obs.elementMap).length === 0) {
            this._log('warn', 'Still zero interactive elements. Often fine (article page, blank tab, or the task needs no click) — handing to the planner instead of giving up.');
          }

          this.onUpdate({ type: 'SCREENSHOT', data: obs.screenshot, url: obs.pageContext.url });
          if (this.startUrl === null) this.startUrl = obs.pageContext.url;

          // ── GROUND-TRUTH BACKFILL ───────────────────────────────────────
          // Now that we can see the REAL result of the previous action, stamp
          // it onto that history entry instead of trusting what the model
          // predicted would happen. Also grow the distinct-page trail.
          if (this.history.length > 0) {
            const prevEntry = this.history[this.history.length - 1];
            if (prevEntry.resultingUrl === undefined) {
              prevEntry.resultingUrl = obs.pageContext.url;
            }
          }
          const lastTrailEntry = this.urlTrail[this.urlTrail.length - 1];
          if (!lastTrailEntry || lastTrailEntry.url !== obs.pageContext.url) {
            this.urlTrail.push({ url: obs.pageContext.url, title: obs.pageContext.title, step: step + 1 });
          }
          this._log('info', `Progress: step ${step + 1}/${MAX_STEPS} · ${this.urlTrail.length} distinct page(s) visited so far`);
        } catch (err) {
          this._log('error', `Observe error: ${err.message}`);
          if (/chrome security restriction/i.test(err.message)) {
            this.onUpdate({ type: 'ERROR', message: err.message });
            return;
          }
          await sleep(1500);
          continue;
        }

        // ── PLAN ─────────────────────────────────────────────────────────
        this._log('info', 'Planning…');
        let plan;
        try {
          plan = await this.client.plan({
            taskId: this.taskId,
            screenshot: obs.screenshot,
            elementMap: obs.elementMap,
            pageContext: obs.pageContext,
            domSnapshot: obs.domSnapshot,
            task,
            history: this.history,
            navigatedSinceStart: this.startUrl !== null && obs.pageContext.url !== this.startUrl,
            openTabsText: await this._formatOpenTabs(),
            overallPlan: this.overallPlan,
            stepNumber: step + 1,
            maxSteps: MAX_STEPS,
            urlTrail: this.urlTrail,
          });

          if (!this.overallPlan && plan.game_plan) {
            this.overallPlan = plan.game_plan;
          }

          if (plan.game_plan) this._log('plan', `Plan: ${plan.game_plan}`);
          this._log('think', `Thought: ${plan.thought}`);
          this._log('action', `Action: ${JSON.stringify(plan.action)}`);

          chrome.tabs.sendMessage(this.tabId, {
            type: 'UPDATE_UI',
            thought: plan.thought,
            actionText: `Executing: ${plan.action?.type}`,
          }).catch(() => {});

          this.consecutivePlanFailures = 0;
        } catch (err) {
          this.consecutivePlanFailures++;
          this._log('error', `Plan error (${this.consecutivePlanFailures}/3): ${err.message}`);
          if (/^BUDGET_EXCEEDED/i.test(err.message)) {
            this._log('error', 'Stopping: budget limit reached. Adjust MAX_COST_PER_TASK_USD / DAILY_BUDGET_USD in server/.env.');
            this.onUpdate({ type: 'ERROR', message: err.message });
            return;
          }
          if (this.consecutivePlanFailures >= 3) {
            this._log('error', 'Server/API not responding. Check server logs and your API key.');
            this.onUpdate({ type: 'ERROR', message: err.message });
            return;
          }
          await sleep(2000);
          continue;
        }

        // ── DONE CHECK ───────────────────────────────────────────────────
        if (plan.action?.type === 'finish') {
          this._log('success', `Task Completed! Reason: ${plan.action.reason || 'Goal achieved.'}`);
          this.onUpdate({ type: 'DONE', result: plan.action.reason || plan.thought });
          this.running = false;
          break;
        }
        if (plan.action?.type === 'done') {
          // Defensive fallback in case the model emits an alternate phrasing.
          this._log('success', `Done: ${plan.action?.result || plan.thought}`);
          this.onUpdate({ type: 'DONE', result: plan.action?.result || plan.thought });
          return;
        }

        // ── EXECUTE ──────────────────────────────────────────────────────
        try {
          const targetEl = plan.action?.element_id != null
            ? obs.elementMap[String(plan.action.element_id)]
            : null;
          // FIX: prefer STABLE identifiers first. `targetEl.text` for an
          // <input> is derived from its live value (see labelElements() in
          // content/agent.js), so it changes every time the user types into
          // it — e.g. "" → "Agentic AI" → "Agentic AIAgentic AI". Using it as
          // the primary label broke the repeat-action safety net below,
          // because the signature looked "different" every step even though
          // the same type-into-the-same-box action was firing over and over.
          // ariaLabel/placeholder/name don't change when the value does.
          const targetLabel = targetEl
            ? (targetEl.ariaLabel || targetEl.placeholder || targetEl.name || targetEl.text || `${targetEl.tag} element`)
            : (plan.action?.url || plan.action?.key || null);

          const preScrollHeight = obs.pageContext.scrollHeight;
          // NOTE: this used to be called twice per step (a real bug — every
          // click/type/navigate was firing twice). Call it exactly once.
          const execResult = await this._execute(plan.action);

          this.consecutiveFailures = 0;
          this.history.push({
            action: plan.action,
            target_label: targetLabel, // e.g. "Next" — meaningful across steps, unlike element_id
            thought: plan.thought,
            result: `executed OK`,
            succeeded: true,
            url: obs.pageContext.url,
            // Ground truth for 'type' actions: what the field actually
            // contains right after typing, from the content script itself —
            // not a guess. Lets the model see "field now contains: X" on the
            // next turn instead of re-deriving it from a screenshot.
            resultingValue: plan.action.type === 'type' ? execResult?.finalValue : undefined,
            // resultingUrl intentionally left undefined here — it gets
            // backfilled at the top of the NEXT step once we actually
            // observe where the browser ended up (see GROUND-TRUTH BACKFILL
            // above). Don't guess it here.
          });

          const isExploratory = plan.action.type === 'scroll' || plan.action.type === 'wait';

          if (plan.action.type === 'scroll') {
            const postScrollHeight = execResult?.scrollHeight || preScrollHeight;
            if (postScrollHeight > preScrollHeight) {
              this._log('info', 'Page height increased. Waiting extra time for lazy-loaded content to paint...');
              await sleep(1500);
            }
          }

          const signature = `${plan.action.type}:${targetLabel || plan.action.element_id || ''}`;
          if (signature === this.lastActionSignature && !isExploratory) {
            this.sameActionStreak++;
          } else {
            this.sameActionStreak = 1;
            this.lastActionSignature = signature;
          }

          if (this.sameActionStreak >= 2) {
            // NOTE: this used to unconditionally claim the task was already
            // complete. That's the right call for one-shot nav actions, but
            // for click/type it more often means the agent is stuck
            // re-doing an ineffective action (exactly the bug this session
            // fixed). Message reflects both possibilities honestly instead
            // of asserting success it can't actually confirm.
            const likelyDone = ['navigate', 'new_tab', 'go_back', 'go_forward', 'click'].includes(plan.action.type);
            this._log('warn', `Same action repeated ${this.sameActionStreak}x in a row (${signature}). ${likelyDone ? 'Assuming task already complete' : 'This usually means the agent is stuck retrying an ineffective action'} — stopping to avoid an infinite loop.`);
            this.onUpdate({
              type: 'DONE',
              result: `Repeated "${signature}" ${this.sameActionStreak}x — ${likelyDone ? 'task likely already completed after the first execution.' : 'stopped before burning more steps/budget on a stuck loop. Check the last screenshot to see what\'s blocking progress.'}`,
            });
            this.running = false;
            return;
          }
        } catch (err) {
          this.consecutiveFailures++;
          this._log('error', `Execute failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
          this.history.push({
            action: plan.action,
            target_label: null,
            thought: plan.thought,
            result: `FAILED: ${err.message}`,
            succeeded: false,
            url: obs.pageContext.url,
          });

          if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this._log('error', 'Too many consecutive failures. Stopping.');
            this.onUpdate({ type: 'ERROR', message: 'Too many consecutive failures.' });
            return;
          }
          await sleep(800);
          continue;
        }

        // Settle
        await sleep(POST_ACTION_DELAY_MS);
        if (['navigate', 'new_tab', 'go_back', 'go_forward'].includes(plan.action.type)) {
          await this._waitForNavigation(this.tabId);
        }
      }

      if (this.running) {
        this._log('error', `Hit step limit (${MAX_STEPS}).`);
        this.onUpdate({ type: 'ERROR', message: `Hit ${MAX_STEPS}-step limit.` });
      }

    } catch (err) {
      this._log('error', `Fatal: ${err.message}`);
      this.onUpdate({ type: 'ERROR', message: err.message });
    } finally {
      try { await chrome.tabs.sendMessage(this.tabId, { type: 'REMOVE_OVERLAY' }); } catch {}
      this.running = false;
    }
  }

  // ─── OBSERVE ──────────────────────────────────────────────────────────────

  async _observe(tabId) {
    let res = await this._trySend(tabId, { type: 'LABEL_ELEMENTS' }, 3);

    if (!res?.success) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/agent.js'] });
      } catch (err) {
        // Chrome refuses to inject scripts into chrome://, extension, webstore,
        // and PDF-viewer pages — enforced by Chrome itself, no workaround.
        if (/cannot access|chrome:\/\/|extension gallery|contents of the page/i.test(err.message || '')) {
          throw new Error(
            `Chrome blocks extensions from running on this page (${err.message}). ` +
            `This is a Chrome security restriction, not a bug — navigate to a normal http/https page and try again.`
          );
        }
        throw err;
      }
      await sleep(400);
      res = await chrome.tabs.sendMessage(tabId, { type: 'LABEL_ELEMENTS' });
    }

    if (!res?.success) {
      throw new Error('Cannot access page. Must be a regular http/https page.');
    }

    await sleep(80); // let labels paint before the screenshot
    const screenshot = await this._screenshot(tabId);
    chrome.tabs.sendMessage(tabId, { type: 'REMOVE_OVERLAY' }).catch(() => {});
    this.lastObservedElements = res.elementMap || {};
    return {
      screenshot,
      elementMap: res.elementMap || {},
      pageContext: res.pageContext || {},
      domSnapshot: res.domSnapshot || '',
    };
  }

  async _screenshot(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return url.split(',')[1]; // strip data:image/jpeg;base64,
  }

  async _formatOpenTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t, i) => {
        const current = t.id === this.tabId ? ' (CURRENT)' : '';
        return `[${i}] "${(t.title || '').slice(0, 60)}" → ${t.url}${current}`;
      }).join('\n') || '(only one tab open)';
    } catch {
      return '(tab list unavailable)';
    }
  }

  // ─── EXECUTE ──────────────────────────────────────────────────────────────

  async _execute(action) {
    const tabId = this.tabId;

    if (action.element_id !== undefined && action.element_id !== null) {
      action.element_id = String(action.element_id);
    }
    const elementIdStr = action.element_id || null;
    const validIds = Object.keys(this.lastObservedElements || {});

    this._log('info', `Executing action: ${action.type}${elementIdStr ? ` on ID: ${elementIdStr}` : ''}`);

    // Only click/type/select/hover strictly require a real element_id.
    // (key_press acts on document.activeElement — it must NOT be in this
    // list, or pressing Enter after typing into a search box always fails.)
    if (ACTIONS_REQUIRING_ELEMENT.has(action.type)) {
      if (!elementIdStr) {
        throw new Error(`Action '${action.type}' requires an element_id, but none was provided.`);
      }
      if (!validIds.includes(action.element_id)) {
        throw new Error(`Element #${action.element_id} does not exist in current observation.`);
      }
    }

    if (action.type === 'scroll' && elementIdStr && !validIds.includes(action.element_id)) {
      throw new Error(`Cannot scroll on Element #${action.element_id} because it does not exist.`);
    }

    try {
      switch (action.type) {
        case 'navigate':
          await chrome.tabs.update(tabId, { url: action.url });
          await this._waitForNavigation(tabId);
          return {};

        case 'new_tab': {
          const newTab = await chrome.tabs.create({ url: action.url || 'about:blank', active: true });
          this.tabId = newTab.id;
          if (action.url) await this._waitForNavigation(this.tabId);
          this._log('info', `Opened a new tab and switched focus to it (tab id ${newTab.id}).`);
          return { newTabId: newTab.id };
        }

        case 'switch_tab': {
          const tabs = await chrome.tabs.query({});
          const idx = Number(action.tab_index);
          const target = tabs[idx];
          if (!target) throw new Error(`No tab at index ${action.tab_index}. There are ${tabs.length} tabs open.`);
          await chrome.tabs.update(target.id, { active: true });
          if (target.windowId != null) { try { await chrome.windows.update(target.windowId, { focused: true }); } catch {} }
          this.tabId = target.id;
          return { switchedTo: target.id };
        }

        case 'close_tab': {
          const tabs = await chrome.tabs.query({});
          const closeId = action.tab_index != null ? tabs[Number(action.tab_index)]?.id : this.tabId;
          if (!closeId) throw new Error('No matching tab to close.');
          const wasCurrent = closeId === this.tabId;
          await chrome.tabs.remove(closeId);
          if (wasCurrent) {
            const remaining = await chrome.tabs.query({ active: true, currentWindow: true });
            if (remaining[0]) this.tabId = remaining[0].id;
            else throw new Error('Closed the last open tab — nothing left to act on.');
          }
          return { closed: closeId };
        }

        case 'go_back':
          await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: () => history.back() });
          await this._waitForNavigation(this.tabId);
          return {};

        case 'go_forward':
          await chrome.scripting.executeScript({ target: { tabId: this.tabId }, func: () => history.forward() });
          await this._waitForNavigation(this.tabId);
          return {};

        case 'wait':
          await sleep(action.ms || 1000);
          return {};

        case 'key_press': {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action });
          if (!r?.success) throw new Error(r?.error || 'Content script error');
          return r.result || {};
        }

        case 'click': {
          const tabsBefore = await chrome.tabs.query({});
          const r = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action });
          if (!r?.success) throw new Error(r?.error || 'Content script error');

          // Detect target="_blank" / window.open() links that spawn a real
          // new tab outside our control — without this, the loop keeps
          // observing the now-stale original tab forever.
          await sleep(NEW_TAB_DETECT_DELAY_MS);
          const tabsAfter = await chrome.tabs.query({});
          if (tabsAfter.length > tabsBefore.length) {
            const known = new Set(tabsBefore.map(t => t.id));
            const fresh = tabsAfter.find(t => !known.has(t.id));
            if (fresh) {
              this._log('info', 'That click opened a new tab — following it.');
              await chrome.tabs.update(fresh.id, { active: true });
              this.tabId = fresh.id;
            }
          }
          return r.result || {};
        }

        case 'type':
        case 'scroll':
        case 'select':
        case 'hover': {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action });
          if (!r?.success) throw new Error(r?.error || 'Content script error');
          return r.result || {};
        }

        default:
          throw new Error(`Unknown action: ${action.type}`);
      }
    } catch (err) {
      if (err.message.includes('not found')) {
        this._log('info', 'Element missing, forcing re-label and retrying...');
        await this._observe(this.tabId);
        const retryRes = await chrome.tabs.sendMessage(this.tabId, { type: 'EXECUTE_ACTION', action });
        if (!retryRes?.success) throw new Error(retryRes?.error || 'Retry failed');
        return retryRes.result || {};
      }
      throw err;
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  async _waitForNavigation(tabId, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') { await sleep(POST_NAV_EXTRA_MS); return; }
      } catch { break; }
      await sleep(250);
    }
  }

  async _trySend(tabId, msg, retries = 2) {
    for (let i = 0; i < retries; i++) {
      try {
        const r = await chrome.tabs.sendMessage(tabId, msg);
        if (r?.success) return r;
      } catch {}
      if (i < retries - 1) await sleep(400);
    }
    return null;
  }

  _log(level, text) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    this.onUpdate({ type: 'LOG', level, text, ts });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
