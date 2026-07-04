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

  // Format recent action history compactly
  _formatHistory(history) {
    if (!history.length) return 'None — step 1.';
    return history
      .slice(-6)
      .map(h => {
        const ok = h.succeeded === false ? '✗ FAILED' : '✓';
        const what = h.target_label
          ? `${h.action.type} on "${h.target_label}"`
          : JSON.stringify(h.action);
        // Ground-truth transition, computed from real navigation — not the
        // model's memory of what it thought would happen.
        let transition = '';
        if (h.resultingUrl !== undefined && h.resultingUrl !== null) {
          transition = h.resultingUrl !== h.url
            ? ` [NAVIGATED: ${h.url} → ${h.resultingUrl}]`
            : ` [same URL, no navigation]`;
        }
        const why = h.thought ? ` (was thinking: "${h.thought.slice(0, 90)}")` : '';
        return `${ok} ${what}${transition} → ${h.result}${why}`;
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

  async plan({ taskId, screenshot, elementMap, pageContext, domSnapshot, task, history, navigatedSinceStart, openTabsText, overallPlan, step, maxSteps, urlTrail }) {
    const body = {
      taskId,
      screenshot,            // base64 JPEG (no data: prefix)
      task,
      history: this._formatHistory(history),
      elements: this._formatElements(elementMap),
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
      step: step || 1,
      maxSteps: maxSteps || 30,
      urlTrail: this._formatUrlTrail(urlTrail),
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
