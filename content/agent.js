// content/agent.js
// Injected into every page. Three jobs:
//   1. Label interactive elements with numbered overlays (Set-of-Marks)
//   2. Build a structured DOM snapshot (accessibility tree-style)
//   3. Execute actions: click, type, scroll, select, key_press

(function () {
  if (window.__agentBrowserLoaded) return;
  window.__agentBrowserLoaded = true;

  let overlayEl = null;
  let elementMap = {};

  // ─────────────────────────────────────────────────────────────────────────
  // VISIBILITY HELPERS
  // ─────────────────────────────────────────────────────────────────────────

function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    
    // Must be at least partially in viewport
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;

    // -- NEW: Occlusion Check --
    // Find the center point of the element
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    
    // What is the topmost element at this exact pixel?
    const topEl = document.elementFromPoint(cx, cy);
    
    // If elementFromPoint returns null, it's off-screen
    if (!topEl) return false;
    
    // If the top element is NOT the element we are checking, AND it's not a child 
    // of our element (like an SVG inside a button), it is covered by a modal/overlay.
    if (topEl !== el && !el.contains(topEl)) {
      return false;
    }

    return true;
  }

  function getUniqueSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const agentId = el.getAttribute('data-agent-id');
    if (agentId) return `[data-agent-id="${agentId}"]`;

    const path = [];
    let node = el;
    while (node && node !== document.body) {
      let seg = node.tagName.toLowerCase();
      if (node.id) {
        seg = `#${CSS.escape(node.id)}`;
        path.unshift(seg);
        break;
      }
      const siblings = node.parentNode
        ? Array.from(node.parentNode.children).filter((s) => s.tagName === node.tagName)
        : [];
      if (siblings.length > 1) {
        seg += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(seg);
      node = node.parentNode;
    }
    return path.join(' > ');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ELEMENT LABELING  (Set-of-Marks)
  // ─────────────────────────────────────────────────────────────────────────

  function labelElements() {
    // FIX 1: Clear old tags from the PREVIOUS run before starting a new one.
    // This prevents stale IDs from interfering with new ones.
    document.querySelectorAll('[data-agent-id]').forEach((el) => {
      el.removeAttribute('data-agent-id');
    });

    removeOverlay();
    elementMap = {};

    const SELECTORS = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[onclick]',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const seen = new Set();
    const elements = [];
    document.querySelectorAll(SELECTORS).forEach((el) => {
      if (!seen.has(el) && isVisible(el)) {
        seen.add(el);
        elements.push(el);
      }
    });

    // Create a fixed overlay container that lives outside the page flow
    overlayEl = document.createElement('div');
    overlayEl.id = '__agentic_overlay__';
    overlayEl.setAttribute('data-agentic', 'true');
    overlayEl.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(overlayEl);

    elements.forEach((el, idx) => {
      const id = idx + 1;
      const rect = el.getBoundingClientRect();

      const label = document.createElement('div');
      label.style.cssText = [
        `position:absolute`, 
        `left:${Math.max(0, rect.left - 6)}px`, // Shift left slightly outside the box
        `top:${Math.max(0, rect.top - 6)}px`,   // Shift up slightly
        `background:rgba(79, 70, 229, 0.85)`,  // Semi-transparent Indigo
        `color:#fff`,
        `font-size:11px`,
        `font-weight:900`,
        `font-family:system-ui, sans-serif`,
        `padding:2px 6px`,
        `border-radius:4px`,
        `z-index:2147483647`,
        `pointer-events:none`,                 // Clicks pass through it
        `backdrop-filter: blur(2px)`,          // Frosted glass effect
        `border: 1px solid rgba(255,255,255,0.4)`,
        `box-shadow: 0 2px 4px rgba(0,0,0,0.3)`
      ].join(';');
      label.textContent = id;
      overlayEl.appendChild(label);

      el.setAttribute('data-agent-id', id);

      const text = (el.innerText || el.textContent || el.value || '').trim().slice(0, 80);
      elementMap[id] = {
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        placeholder: el.placeholder || '',
        text,
        href: el.href || '',
        name: el.name || '',
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        selector: getUniqueSelector(el),
        rect: {
          cx: Math.round(rect.left + rect.width / 2),
          cy: Math.round(rect.top + rect.height / 2),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    });

    return elementMap;
  }

  function removeOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
    
    // FIX 2: We STOP stripping the 'data-agent-id' attributes here!
    // The LLM needs these attributes to stay on the DOM elements so it can 
    // successfully query and click them later in the execution phase.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ACTION EXECUTION
  // ─────────────────────────────────────────────────────────────────────────

// Pass the elementMap into getElement so it has access to fallback selectors
  function getElement(action, currentMap = elementMap) {
    if (action.element_id) {
      // 1. Try the primary ID first
      let el = document.querySelector(`[data-agent-id="${action.element_id}"]`);
      if (el) return el;

      // 2. NEW: The React Re-render Fallback
      // If the ID was stripped by a framework update, try the exact CSS selector
      if (currentMap && currentMap[action.element_id] && currentMap[action.element_id].selector) {
        try {
          let fallbackEl = document.querySelector(currentMap[action.element_id].selector);
          if (fallbackEl) {
            console.log(`Agent: Rescued lost element #${action.element_id} using fallback selector.`);
            return fallbackEl;
          }
        } catch (e) { /* Ignore invalid selector errors */ }
      }
    }
    
    // 3. Fallback to generic selector if provided
    if (action.selector) {
      return document.querySelector(action.selector);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function executeClick(action) {
    const el = getElement(action);
    if (!el) throw new Error(`Element #${action.element_id} not found in DOM`);

    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    await sleep(80);
    el.focus();

    // Dispatch full mouse event sequence for JS-heavy pages
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    // Also call native .click() as fallback
    el.click();

    return { element: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 40) };
  }

  async function executeType(action) {
    const el = getElement(action);
    if (!el) throw new Error(`Element #${action.element_id} not found in DOM`);

    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    await sleep(80);
    el.focus();

    // FIX: 'type' means "set this field's value" — clear any existing
    // content first UNLESS the model explicitly opts out with
    // clear_first:false. This used to default to APPEND-only (clear_first
    // had to be explicitly true), which silently duplicated text whenever
    // the model re-issued the same type action on a field that already had
    // a value — e.g. re-typing "Agentic AI" into a box that already
    // contained "Agentic AI" produced "Agentic AIAgentic AIAgentic AI...".
    // Appending on purpose is a rare case, so it's now the opt-out, not the
    // default.
    const shouldClear = action.clear_first !== false;

    // Handle contenteditable
    if (el.isContentEditable) {
      if (shouldClear) el.textContent = '';
      document.execCommand('insertText', false, action.text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        typed: action.text.length,
        // Ground truth for the orchestrator/history — what the field
        // actually contains after this action, not what we assume it does.
        finalValue: (el.innerText || el.textContent || '').slice(0, 200),
      };
    }

    // For regular inputs: use native setter so React/Vue/Angular state syncs
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (shouldClear) {
      if (nativeSetter) nativeSetter.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Type character by character
    for (const char of action.text) {
      const current = el.value || '';
      if (nativeSetter) nativeSetter.call(el, current + char);
      else el.value = current + char;

      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
      await sleep(12);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: action.text.length, finalValue: (el.value || '').slice(0, 200) };
  }
  async function executeScroll(action) {
    const amount = action.amount || 400;
    const dir = action.direction || 'down';
    const dy = dir === 'down' ? amount : dir === 'up' ? -amount : 0;
    const dx = dir === 'right' ? amount : dir === 'left' ? -amount : 0;

    let targetEl = null;

    // 1. If the LLM passed a specific element_id, use it strictly.
    if (action.element_id) {
      targetEl = getElement(action);
      if (!targetEl) throw new Error(`Element #${action.element_id} not found in DOM`);
    } else {
      // 2. Smart scrolling: Find the largest scrollable container in the viewport.
      const scrollableElements = [];
      const allElements = document.querySelectorAll('*');

      for (const el of allElements) {
        if (dir === 'down' || dir === 'up') {
          if (el.scrollHeight > el.clientHeight) {
            const style = window.getComputedStyle(el);
            if (['auto', 'scroll', 'overlay'].includes(style.overflowY)) {
              scrollableElements.push(el);
            }
          }
        } else {
          if (el.scrollWidth > el.clientWidth) {
            const style = window.getComputedStyle(el);
            if (['auto', 'scroll', 'overlay'].includes(style.overflowX)) {
              scrollableElements.push(el);
            }
          }
        }
      }

      if (scrollableElements.length > 0) {
        // Sort by visible bounding box area to find the "main" scroll area
        scrollableElements.sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return (rectB.width * rectB.height) - (rectA.width * rectA.height);
        });
        targetEl = scrollableElements[0];
      } else {
        // Fallback to the main window
        targetEl = document.documentElement;
      }
    }

    // 3. Record starting position
    const startY = targetEl === document.documentElement ? window.scrollY : targetEl.scrollTop;
    const startX = targetEl === document.documentElement ? window.scrollX : targetEl.scrollLeft;

    // 4. Perform the scroll
    if (targetEl === document.documentElement) {
      window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    } else {
      targetEl.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    }

    await sleep(400); // Wait for smooth scroll to finish physically moving

    // 5. Verify if the scroll actually moved anything (Stagnation Detection)
    const endY = targetEl === document.documentElement ? window.scrollY : targetEl.scrollTop;
    const endX = targetEl === document.documentElement ? window.scrollX : targetEl.scrollLeft;

    if (Math.abs(endY - startY) < 5 && Math.abs(endX - startX) < 5) {
      throw new Error(`Scroll failed. Reached the limit of the scrollable area (or page is locked).`);
    }

    // NEW: Return the total height of the container so the orchestrator can detect lazy-loading
    return { 
      scrolled: targetEl.tagName.toLowerCase(), 
      dy: endY - startY, 
      dx: endX - startX,
      scrollHeight: targetEl.scrollHeight 
    };

    
  }

  async function executeSelect(action) {
    const el = getElement(action);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      throw new Error(`Select element #${action.element_id} not found`);
    }
    el.value = action.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: action.value };
  }

  async function executeKeyPress(action) {
    const target = document.activeElement || document.body;
    const key = action.key;
    const opts = { key, code: key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { key };
  }

  // NOTE: this used to live OUTSIDE the IIFE (after the closing `})();`),
  // referencing `getElement` and `elementMap` which only exist inside this
  // closure — calling it would have thrown a ReferenceError. Moved here so
  // it's actually callable, and wired into the EXECUTE_ACTION switch below.
  async function executeHover(action) {
    const el = getElement(action, elementMap);
    if (!el) throw new Error(`Element #${action.element_id} not found`);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(200);
    const rect = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    return { hovered: action.element_id };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DOM SNAPSHOT  (structured accessibility-tree-style representation)
  // Called AFTER labelElements() so data-agent-id attrs are set.
  // The #N ids here match the numbered labels in the screenshot.
  // ─────────────────────────────────────────────────────────────────────────

  function getDOMSnapshot() {
    const SKIP_TAGS = new Set([
      'script','style','noscript','head','meta','link','title',
      'svg','path','g','use','defs','br','hr','iframe',
      'video','audio','source','track','picture','map','area',
    ]);
    const MAX_CHARS = 6000;
    const VIEWPORT_MARGIN = 150; // px of slack above/below the fold, for a little context
    const lines = [];
    let totalLen = 0; // tracked incrementally — avoids O(n^2) lines.join() on every node

    function push(line) {
      lines.push(line);
      totalLen += line.length + 1;
    }

    function walk(el, depth) {
      if (depth > 12) return;
      if (totalLen > MAX_CHARS) return;
      if (el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;

      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;

      // FIX: this used to walk the ENTIRE document.body in DOM order with no
      // regard for scroll position, truncating at MAX_CHARS from the TOP of
      // the page every single time. On a long page (e.g. a trending-repos
      // list), that meant the DOM SNAPSHOT TEXT never changed no matter how
      // far the agent scrolled — only the SCREENSHOT did. The model was
      // being asked to find something in text it was never actually shown,
      // which looked like "it can't see the page" but was really "the page
      // description was frozen at the top regardless of scroll." Skipping
      // (and not recursing into) anything nowhere near the current viewport
      // ties the text snapshot to the same content the screenshot shows, so
      // scrolling actually reveals new text on the next observation.
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -VIEWPORT_MARGIN || rect.top > window.innerHeight + VIEWPORT_MARGIN) return;

      const pad = '  '.repeat(Math.min(depth, 7));
      const aid = el.getAttribute('data-agent-id');
      const astr = aid ? ` #${aid}` : '';

      if (/^h[1-6]$/.test(tag)) {
        const t = el.innerText?.trim().slice(0, 100);
        if (t) push(`${pad}[${tag.toUpperCase()}] ${t}`);

      } else if (tag === 'a') {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 70);
        const h = (el.getAttribute('href') || '').slice(0, 60);
        if (t || h) push(`${pad}[LINK${astr}] "${t}" → ${h}`);

      } else if (tag === 'button') {
        const t = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 70);
        push(`${pad}[BUTTON${astr}] "${t}"`);

      } else if (tag === 'input') {
        const type = el.type || 'text';
        if (type === 'hidden') return;
        const label = el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
        const val = type === 'password'
          ? (el.value ? '(filled)' : '')
          : (el.value?.slice(0, 50) || '');
        const chk = (type === 'checkbox' || type === 'radio')
          ? ` checked=${el.checked}` : '';
        push(`${pad}[INPUT:${type}${astr}] label="${label}"${val ? ` val="${val}"` : ''}${chk}`);

      } else if (tag === 'textarea') {
        const ph = el.placeholder?.slice(0, 40) || '';
        const val = el.value?.slice(0, 60) || '';
        push(`${pad}[TEXTAREA${astr}] ph="${ph}"${val ? ` val="${val}"` : ''}`);

      } else if (tag === 'select') {
        const sel = el.options[el.selectedIndex]?.text?.slice(0, 30) || '';
        const opts = Array.from(el.options).slice(0, 6).map(o => o.text?.slice(0, 20)).join(', ');
        push(`${pad}[SELECT${astr}] sel="${sel}" opts=[${opts}]`);

      } else if (tag === 'p') {
        const t = el.innerText?.trim().slice(0, 120);
        if (t && t.length > 8) push(`${pad}[P] ${t}`);
        return; // don't recurse into p

      } else if (['form','nav','main','section','header','footer','article'].includes(tag)) {
        const role = el.getAttribute('role') || '';
        const aria = el.getAttribute('aria-label') || '';
        const info = [role, aria].filter(Boolean).join(' ');
        push(`${pad}[${tag.toUpperCase()}${info ? ' '+info : ''}]`);

      } else if (tag === 'span' || tag === 'li' || tag === 'div') {
        // NEW: small inline "badge" text — a GitHub trending repo's
        // language tag ("Rust"), a star/fork count, a price, a status
        // pill — was previously INVISIBLE in the text snapshot entirely,
        // because only headings/links/buttons/inputs/paragraphs got a
        // line. That left the model no text-based way to find "the repo
        // written in Rust" and forced it to rely on reading small colored
        // dots/text in a downscaled JPEG screenshot, which free vision
        // models are unreliable at. Only DIRECT text nodes are used (not
        // nested elements' text), so a <li> or <div> wrapping a <a> or
        // <span> doesn't get its child's text double-counted here — the
        // child still gets its own line when walk() reaches it below.
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .filter(Boolean)
          .join(' ')
          .slice(0, 60);
        if (directText.length > 1) push(`${pad}[${tag.toUpperCase()}${astr}] ${directText}`);
      }

      for (const child of el.children) walk(child, depth + 1);
    }

    walk(document.body, 0);
    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PAGE CONTEXT
  // ─────────────────────────────────────────────────────────────────────────

  function getPageContext() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,canvas,img').forEach((el) => el.remove());
    const bodyText = (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

    return {
      url: window.location.href,
      title: document.title,
      text: bodyText,
      scrollY: window.scrollY,
      scrollHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGE LISTENER
  // ─────────────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case 'LABEL_ELEMENTS': {
            const map = labelElements();
            const ctx = getPageContext();
            const dom = getDOMSnapshot(); // called after labeling so #ids are populated
            sendResponse({ success: true, elementMap: map, pageContext: ctx, domSnapshot: dom });
            break;
          }
          case 'UPDATE_UI': {
            updateAgentUI(message.thought, message.actionText);
            sendResponse({ success: true });
            break;
          }

          case 'REMOVE_OVERLAY': {
            removeOverlay();
            sendResponse({ success: true });
            break;
          }

          case 'GET_PAGE_CONTEXT': {
            sendResponse({ success: true, context: getPageContext() });
            break;
          }

          case 'EXECUTE_ACTION': {
            const { action } = message;
            let result;
            switch (action.type) {
              case 'click':     result = await executeClick(action);    break;
              case 'type':      result = await executeType(action);     break;
              case 'scroll':    result = await executeScroll(action);   break;
              case 'select':    result = await executeSelect(action);   break;
              case 'key_press': result = await executeKeyPress(action); break;
              case 'hover':     result = await executeHover(action);    break;
              default: throw new Error(`Unknown action type: ${action.type}`);
            }
            sendResponse({ success: true, result });
            break;
          }

          default:
            sendResponse({ success: false, error: `Unknown message: ${message.type}` });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // keep channel open for async response
  });
})();

// ─────────────────────────────────────────────────────────────────────────
  // FLOATING AGENT UI (SHADOW DOM)
  // ─────────────────────────────────────────────────────────────────────────
let agentUI = null;
let shadowRoot = null;

function injectAgentUI() {
    if (agentUI) return;
    
    agentUI = document.createElement('div');
    agentUI.id = '__agent_browser_ui__';
    // Position fixed at the bottom right corner
    agentUI.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;';
    
    shadowRoot = agentUI.attachShadow({ mode: 'closed' });
    
    const uiHTML = `
      <style>
        .agent-panel {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
          width: 320px;
          font-family: system-ui, -apple-system, sans-serif;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .header {
          background: #4f46e5;
          color: white;
          padding: 12px 16px;
          font-weight: 600;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pulse {
          width: 8px;
          height: 8px;
          background: #34d399;
          border-radius: 50%;
          animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.7); }
          70% { box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
          100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
        }
        .content {
          padding: 16px;
          font-size: 13px;
          color: #374151;
          line-height: 1.5;
        }
        .thought-label {
          font-size: 11px;
          text-transform: uppercase;
          color: #6b7280;
          font-weight: 700;
          margin-bottom: 4px;
        }
        .thought-text {
          font-style: italic;
        }
        .action-text {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #f3f4f6;
          font-weight: 500;
          color: #111827;
        }
      </style>
      <div class="agent-panel">
        <div class="header">
          <div class="pulse"></div>
          Agentic Browser
        </div>
        <div class="content">
          <div class="thought-label">Current Thought</div>
          <div class="thought-text" id="thought-box">Initializing agent...</div>
          <div class="action-text" id="action-box">Observing page state...</div>
        </div>
      </div>
    `;
    
    shadowRoot.innerHTML = uiHTML;
    document.documentElement.appendChild(agentUI);
  }

  function updateAgentUI(thought, actionText) {
    if (!agentUI) injectAgentUI();
    if (thought) shadowRoot.getElementById('thought-box').textContent = thought;
    if (actionText) shadowRoot.getElementById('action-box').textContent = actionText;
  }
