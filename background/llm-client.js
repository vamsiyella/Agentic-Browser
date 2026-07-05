// background/llm-client.js
// Sends observation data to YOUR server (RPi or Vercel).
// The server holds the API key and calls NVIDIA / Ollama / Anthropic.
// No API key stored in the extension.

export class LLMClient {
  constructor(serverUrl) {
    // e.g. "http://192.168.1.50:3000" or "https://your-app.vercel.app"
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  // Format element map as a concise readable list for the prompt
  _formatElements(elementMap) {
    const entries = Object.entries(elementMap);
    if (!entries.length) {
      return '(none visible in current viewport — this is often fine: scroll to reveal more, ' +
        'or use an element-free action like navigate/new_tab/switch_tab/key_press/finish)';
    }
    return entries
      .map(([id, el]) => {
        const label = el.ariaLabel || el.text || el.placeholder || el.href || '';
        const type  = el.type ? `[${el.type}]` : '';
        const href  = el.tag === 'a' && el.href ? ` → ${el.href.slice(0, 50)}` : '';
        return `[${id}] ${el.tag}${type}: ${label.slice(0, 70)}${href}`;
      })
      .join('\n');
  }

  // A small, unmissable, deterministic summary of every fillable field on
  // the page and its CURRENT actual value — pulled straight from the live
  // DOM, never inferred from vision or guessed.
  //
  // WHY THIS EXISTS: on a form-heavy page (flight/hotel search, any search
  // box, login, checkout) the full INTERACTIVE ELEMENTS list can have
  // 15-30+ entries, and a small vision-language model reliably loses track
  // of which specific field has which value buried in there — it will
  // confidently assert a field "has already been filled in" when it
  // hasn't, or ignore a stale/autofilled value (e.g. Chrome remembering
  // "Savannah" in an origin box from a previous session) that directly
  // contradicts the task. Pulling just the fields into their own short,
  // labeled block in front of the model makes that mismatch impossible to
  // miss, instead of relying on it to notice inside a wall of text.
  _formatFormFields(elementMap) {
    const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
    const entries = Object.entries(elementMap).filter(
      ([, el]) => FIELD_TAGS.has(el.tag) || el.role === 'combobox' || el.role === 'textbox'
    );
    if (!entries.length) return null; // no fields on this page — omit the section entirely
    return entries
      .map(([id, el]) => {
        const label = el.ariaLabel || el.placeholder || el.name || `${el.tag} field`;
        const value = (el.text || '').trim();
        return `[#${id}] "${label.slice(0, 50)}" = ${value ? `"${value.slice(0, 60)}"` : 'EMPTY'}`;
      })
      .join('\n');
  }

  // Format recent action history compactly. This is the model's ONLY memory
  // of what already happened — everything here should be ground truth
  // (computed by code from real observations), not the model's own guesses.
  _formatHistory(history) {
    if (!history.length) return 'None — step 1.';
    return history
      .slice(-6)
      .map(h => {
        const ok = h.succeeded === false ? '✗ FAILED' : '✓';

        if (h.action?.type === 'ask_user') {
          return `${ok} asked_user: "${h.action.question || ''}" → ${h.result}`;
        }

        const what = h.target_label
          ? `${h.action.type} on "${h.target_label}"`
          : JSON.stringify(h.action);

        // Ground-truth navigation transition, computed from the REAL next
        // observation — never from what the model predicted would happen.
        let transition = '';
        if (h.resultingUrl !== undefined && h.resultingUrl !== null) {
          transition = h.resultingUrl !== h.url
            ? ` [NAVIGATED: ${h.url} → ${h.resultingUrl}]`
            : ` [same URL, no navigation]`;
        }

        // Ground-truth field value, read directly from the DOM right after
        // a 'type' action executed — not guessed or re-derived from vision.
        let fieldState = '';
        if (h.resultingValue !== undefined && h.resultingValue !== null) {
          fieldState = ` [FIELD NOW CONTAINS: "${h.resultingValue}"]`;
        }

        const why = h.thought ? ` (was thinking: "${h.thought.slice(0, 90)}")` : '';
        return `${ok} ${what}${transition}${fieldState} → ${h.result}${why}`;
      })
      .join('\n');
  }

  // Format the ground-truth sequence of distinct pages actually visited so
  // far. This is computed from real observations, never from model text —
  // it's what the model should trust over its own past "thought" claims
  // about what page it's on.
  _formatUrlTrail(urlTrail) {
    if (!urlTrail || !urlTrail.length) return '(no navigation yet — still on the starting page)';
    return urlTrail
      .map((e, i) => {
        const here = i === urlTrail.length - 1 ? '  ← YOU ARE HERE' : '';
        const title = e.title ? ` ("${e.title.slice(0, 60)}")` : '';
        return `${i + 1}. ${e.url}${title}${here}`;
      })
      .join('\n');
  }

  async plan({
    taskId, screenshot, elementMap, pageContext, domSnapshot, task, history,
    navigatedSinceStart, openTabsText, overallPlan, stepNumber, maxSteps, urlTrail,
    dataBufferCount, dataBufferKind,
  }) {
    const body = {
      taskId,
      screenshot,            // base64 JPEG (no data: prefix)
      task,
      history: this._formatHistory(history),
      elements: this._formatElements(elementMap),
      formFields: this._formatFormFields(elementMap),
      elementCount: Object.keys(elementMap || {}).length,
      domSnapshot: domSnapshot || '',
      pageText: (pageContext.text || '').slice(0, 1500),
      url: pageContext.url,
      title: pageContext.title,
      scrollY: pageContext.scrollY,
      scrollHeight: pageContext.scrollHeight,
      navigatedSinceStart: !!navigatedSinceStart,
      openTabs: openTabsText || '',
      overallPlan: overallPlan || '',
      step: stepNumber || 1,
      maxSteps: maxSteps || 30,
      urlTrail: this._formatUrlTrail(urlTrail),
      // Ground truth on the running bulk-extraction buffer — computed by
      // the loop from real 'extract' results, not the model's own claims.
      // Lets the model know whether it's already collected data (and how
      // much) before deciding to keep paginating vs. export_data/finish.
      dataBufferCount: dataBufferCount || 0,
      dataBufferKind: dataBufferKind || null,
    };

    const resp = await fetch(`${this.serverUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      let message = raw;
      try { message = JSON.parse(raw).error || raw; } catch { /* not JSON, use as-is */ }
      throw new Error(message.length < 300 ? message : `Server ${resp.status}: ${message.slice(0, 200)}`);
    }

    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.action; // { game_plan, thought, action }
  }
}
