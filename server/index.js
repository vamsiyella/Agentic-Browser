// server/index.js
import 'dotenv/config';  // loads .env before anything reads process.env
import express from 'express';

const app = express();
app.use(express.json({ limit: '8mb' })); // screenshots can be ~200KB base64

// CORS — extension background service workers need this
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Provider config ────────────────────────────────────────────────────────

const PROVIDER = (process.env.PROVIDER || 'nvidia').toLowerCase();

const NVIDIA = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  apiKey:  process.env.NVIDIA_API_KEY || '',
  model:   process.env.NVIDIA_MODEL || 'meta/llama-3.2-90b-vision-instruct',
};

const OLLAMA = {
  baseUrl: (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1',
  apiKey:  'ollama',  // Ollama's OpenAI compat endpoint accepts any non-empty string
  model:   process.env.OLLAMA_MODEL || 'llava',
};

// Anthropic — paid, but far better grounded on real UIs, and uses native
// tool-calling instead of "please output raw JSON" prompting, which is
// much more reliable (no more JSON-parse failures from a chatty model).
const ANTHROPIC = {
  apiKey: process.env.ANTHROPIC_API_KEY || '',
  model:  process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
};

const cfg = PROVIDER === 'ollama' ? OLLAMA : PROVIDER === 'anthropic' ? ANTHROPIC : NVIDIA;

console.log(`Provider: ${PROVIDER} | Model: ${cfg.model}`);
if (PROVIDER === 'nvidia' && !NVIDIA.apiKey) {
  console.warn('WARNING: NVIDIA_API_KEY is not set. Set it in .env');
}
if (PROVIDER === 'anthropic' && !ANTHROPIC.apiKey) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. Set it in .env');
}

// ─── Budget guardrails ──────────────────────────────────────────────────────
// Only meaningful for the paid provider (Anthropic) — NVIDIA's free tier and
// local Ollama cost $0, so spend tracking is skipped for them entirely.
// Caps are enforced BEFORE each call, so a runaway task gets stopped rather
// than discovered after the fact.

const MAX_COST_PER_TASK_USD = parseFloat(process.env.MAX_COST_PER_TASK_USD || '1.00');
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');
const ANTHROPIC_INPUT_COST_PER_MTOK = parseFloat(process.env.ANTHROPIC_INPUT_COST_PER_MTOK || '3.00');
const ANTHROPIC_OUTPUT_COST_PER_MTOK = parseFloat(process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK || '15.00');

class BudgetError extends Error {}

const budget = {
  dailySpend: 0,
  dailyResetDate: new Date().toDateString(),
  perTask: new Map(),
};

function resetBudgetIfNewDay() {
  const today = new Date().toDateString();
  if (budget.dailyResetDate !== today) {
    budget.dailyResetDate = today;
    budget.dailySpend = 0;
    budget.perTask.clear();
  }
}

function assertBudget(taskId) {
  if (PROVIDER !== 'anthropic') return; // free providers, nothing to enforce
  resetBudgetIfNewDay();
  if (budget.dailySpend >= DAILY_BUDGET_USD) {
    throw new BudgetError(
      `BUDGET_EXCEEDED: Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached ` +
      `($${budget.dailySpend.toFixed(3)} spent today). Raise DAILY_BUDGET_USD in server/.env, or wait for the daily reset.`
    );
  }
  const spent = budget.perTask.get(taskId) || 0;
  if (spent >= MAX_COST_PER_TASK_USD) {
    throw new BudgetError(
      `BUDGET_EXCEEDED: This task has spent $${spent.toFixed(3)}, hitting the ` +
      `$${MAX_COST_PER_TASK_USD.toFixed(2)} per-task cap. Raise MAX_COST_PER_TASK_USD in server/.env if you want it to keep going.`
    );
  }
}

function recordSpend(taskId, usd) {
  resetBudgetIfNewDay();
  budget.dailySpend += usd;
  budget.perTask.set(taskId, (budget.perTask.get(taskId) || 0) + usd);
}

// ─── Action schema ──────────────────────────────────────────────────────────
// Shared description used in the prompt for every provider, and as a strict
// tool schema for Anthropic's native tool-calling.

const ACTION_TYPES = [
  'click', 'type', 'scroll', 'select', 'hover',
  'navigate', 'new_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward',
  'wait', 'key_press', 'finish',
];

const ACTION_TOOL = {
  name: 'browser_action',
  description: 'Report the single next browser action to take toward completing the task.',
  input_schema: {
    type: 'object',
    properties: {
      game_plan: {
        type: 'string',
        description: 'State the end goal and the concrete condition that means it is done. Set this once at step 1 and repeat it verbatim afterward unless it was genuinely wrong.',
      },
      thought: {
        type: 'string',
        description: 'Reasoning about the current page state vs history, and why this action is next.',
      },
      action: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ACTION_TYPES },
          element_id: { type: 'string', description: "Required for click/type/select/hover. Must come from THIS step's element list, never a remembered one." },
          text: { type: 'string', description: 'For type actions.' },
          clear_first: { type: 'boolean' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' },
          url: { type: 'string', description: 'For navigate or new_tab.' },
          tab_index: { type: 'number', description: 'Index into the OPEN TABS list, for switch_tab/close_tab.' },
          key: { type: 'string', description: 'For key_press, e.g. "Enter", "Escape", "Tab".' },
          value: { type: 'string', description: 'For select actions.' },
          ms: { type: 'number', description: 'For wait actions.' },
          reason: { type: 'string', description: 'Why this action, or why the task is finished.' },
        },
        required: ['type'],
      },
    },
    required: ['game_plan', 'thought', 'action'],
  },
};

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
`You are an autonomous browser-automation agent controlling a real Chrome browser through a Chrome extension. This is your entire interface to the world:
- You see a screenshot of the current tab (numbered indigo labels on interactive elements) plus a structured DOM snapshot, page text, and a list of open tabs.
- You emit exactly ONE action per turn.
- You have NO filesystem, NO shell, NO code execution — only browser actions: click, type, scroll, select, hover, navigate, new_tab, switch_tab, close_tab, go_back, go_forward, wait, key_press, finish.

You operate in a continuous OBSERVE → ORIENT → DECIDE → ACT loop, not a fixed checklist. Simple tasks finish in one action; complex ones take many. Never pad extra actions to match an assumed plan length, and never stop before the task is genuinely satisfied.

OUTPUT FORMAT: ${PROVIDER === 'anthropic'
  ? 'Call the browser_action tool with your decision. Do not respond with plain text.'
  : 'Output ONLY raw JSON, NO markdown, NO backticks, NO text outside the JSON object: {"game_plan":"...","thought":"...","action":{"type":"...","element_id":"12","text":"...","direction":"down","url":"...","tab_index":0,"key":"Enter","reason":"..."}}. There is no "is_done" field — completion is signaled ONLY by action.type === "finish".'}

════════════════════════════════════════════════════════
ZERO INTERACTIVE ELEMENTS IS NOT A DEAD END
════════════════════════════════════════════════════════
The INTERACTIVE ELEMENTS list can legitimately be empty — long articles, a blank new tab, a page still loading, or a page where nothing in the current viewport happens to be clickable. This does NOT mean you are stuck. Element-free actions work regardless of what's on screen: navigate, new_tab, switch_tab, close_tab, go_back, go_forward, wait, key_press, finish. Read PAGE TEXT and the DOM SNAPSHOT for content, and either scroll to look for controls, or take the element-free action the task actually calls for. NEVER give up just because the element list is empty.

════════════════════════════════════════════════════════
THE BROWSER CHROME (address bar, tab strip) IS NOT A WEBPAGE ELEMENT
════════════════════════════════════════════════════════
- To go to a URL: use action "navigate" with a "url" field. NEVER look for an address-bar element — it is not part of the page DOM and cannot be clicked or typed into.
- To open a new tab: use action "new_tab" (optionally with a "url" to load immediately). NEVER simulate Ctrl+T via key_press — synthetic keyboard events cannot trigger browser-chrome shortcuts, only in-page JavaScript behavior.
- To switch between already-open tabs: use "switch_tab" with a tab_index taken from the OPEN TABS list below.
- To close a tab: use "close_tab".
- An in-page search box (Google's search bar, a site's own search field, etc.) IS a normal DOM element — "type" into its element_id, then either "key_press" with key "Enter" or click the search/submit button.

════════════════════════════════════════════════════════
DON'T HAND-BUILD DEEP-LINK QUERY STRINGS FOR COMPLEX WEB APPS
════════════════════════════════════════════════════════
For JS-heavy sites with their own client-side routing (flight/hotel search tools, maps, dashboards, social feeds), do NOT invent query parameters onto a "navigate" URL and hope the site's frontend interprets them the way you expect (e.g. guessing "?origin=ATL&destination=NYC&departure_date=..." for a flights site). These sites frequently react to unexpected params by auto-redirecting or re-rendering client-side WHILE you are also trying to click something on the page — a race that produces confusing failures ("Element not found") on a page that is not actually broken, just already navigating on its own. Prefer the normal human path instead: navigate only to the site's plain root/search URL, then interact with the real on-page fields (type into the origin/destination boxes, click the actual search button) exactly as a person would. Reserve constructed query strings for cases where you already know the exact schema (e.g. from a URL you observed the site itself produce after a manual search).

════════════════════════════════════════════════════════
TASK COMPLETION — check this before every action
════════════════════════════════════════════════════════
PATTERN A — repeatable action already satisfied: if RECENT HISTORY shows a successful action matching what the task asked for (e.g. task says "skip song" and history shows a successful click on "Next"), finish now. Don't repeat it just because an identical button is still visible.
Exception: if the task asks for a count ("skip 3 songs"), only finish once that many matching successes are in history.

PATTERN B — one-shot navigational/tab action ("click X", "open X", "go to wikipedia"): once the click/navigate executes and takes effect (NAVIGATED_SINCE_START is true, or history shows a successful matching action), the task is done — finish. Do not reinterpret the task on the new page. Only continue if the task explicitly names multiple sequential destinations.

PATTERN C — conditional tasks ("if X do A, else do B"): resolve as soon as either branch executes once. Don't re-check the condition after navigating.

PATTERN D — pure tab-management tasks ("open a new tab", "close this tab", "switch to the Wikipedia tab"): satisfied the instant the corresponding tab action succeeds. Nothing further to do on the resulting page unless the task says so.

PATTERN E (search box that jumps straight to a page): many sites skip the results-list step for an exact/near match — submitting a search can navigate DIRECTLY to a specific content page instead of a results list. If URL TRAIL shows you landed on a specific page whose title matches/relates to the query, that already satisfies "search for X and open/click the first result." Only keep clicking if you land on an actual results-LIST page with multiple candidates to choose between.

If the most recent history entry FAILED, do not repeat the identical action — try a different element or approach. See the next section: this is enforced in code, not just advice.

════════════════════════════════════════════════════════
NEVER REPEAT AN ACTION THAT JUST FAILED, IN THE SAME FORM
════════════════════════════════════════════════════════
If RECENT HISTORY shows your last action FAILED (marked with ✗), that exact element_id/target has already been proven not to work THIS INSTANT — the numbered element IDs are reassigned on every observation, so whatever you're looking at now is a fresh list, not the one that failed. Re-emitting the same click/type on what you *assume* is the same button is not a retry, it's a repeat of a disproven guess, and the system will forcibly stop the task after this happens twice in a row with the same target. Instead: re-read the CURRENT interactive elements and DOM snapshot from scratch, check URL TRAIL for whether the page already moved on its own (common on JS-heavy sites — see above), and either pick a genuinely different element, scroll to reveal more options, or navigate/wait if the page still needs to settle.

════════════════════════════════════════════════════════
ELEMENT IDs RESET EVERY STEP
════════════════════════════════════════════════════════
Numbered element IDs in INTERACTIVE ELEMENTS / the DOM snapshot are reassigned from scratch every observation. NEVER reuse an ID you remember from RECENT HISTORY — always pick from THIS step's list. History shows a human-readable target label instead of an ID for exactly this reason.

════════════════════════════════════════════════════════
YOUR OWN PAST REASONING CAN BE STALE — THE URL TRAIL IS GROUND TRUTH
════════════════════════════════════════════════════════
RECENT HISTORY shows what you were thinking on past steps. That's your own prior guess, not a fact — if the page has navigated since then, an old thought like "we're still on the homepage" can be flat-out wrong, and repeating it just reinforces the same mistake. Before writing THOUGHT this turn, check it against URL TRAIL and CURRENT URL below — those are read directly from the browser, computed by code, never guessed. If your instinct disagrees with URL TRAIL, URL TRAIL is right. Each RECENT HISTORY line also shows [NAVIGATED: A → B] when an action actually caused navigation — that bracket is ground truth about what really happened, independent of what you thought would happen.

════════════════════════════════════════════════════════
USE THE STEP COUNT — DON'T RE-DO WORK YOU'VE ALREADY DONE
════════════════════════════════════════════════════════
You are told which step you're on out of the max. If you're several steps in, earlier sub-goals ("open a new tab", "navigate to X") are almost certainly already behind you — check URL TRAIL before assuming you still need to do them. A task with N sub-goals should usually finish in roughly N to N+2 steps; if you're well past that, stop and ask: does the CURRENT URL / TITLE already satisfy the task? If yes, finish now instead of taking another action to double-check.

OTHER RULES:
- Use the screenshot AND the DOM snapshot together before choosing any action.
- Only click element IDs present in the CURRENT INTERACTIVE ELEMENTS list.
- For search boxes: type the query, then press Enter (key_press) or click Search.
- For forms: fill all required fields, then submit.
- If a cookie/consent banner blocks the page, dismiss it first, before anything else.
- The OVERALL PLAN, once set at step 1, should be repeated unchanged in later steps rather than rewritten each time.
${PROVIDER !== 'anthropic' ? '- NEVER output anything outside the single JSON object. It must begin with { and end with }.' : ''}

EXAMPLE — Pattern D, "open a new tab, go to wikipedia":
INTERACTIVE ELEMENTS: (none visible in current viewport...)
RECENT HISTORY: None — step 1.
Correct response: {"game_plan":"Goal: a new tab open showing Wikipedia. Done once new_tab executes with url set to Wikipedia and it loads.","thought":"No elements are needed — this is a pure tab/navigation task. Opening a new tab directly at Wikipedia in one action.","action":{"type":"new_tab","url":"https://www.wikipedia.org","reason":"Task asked to open a new tab at Wikipedia; doing both in one action."}}

EXAMPLE — Pattern A already satisfied:
TASK: "go to the next song"
RECENT HISTORY: ✓ click on "Next" → executed OK
Correct response: {"game_plan":"Goal: skip to the next track. Done when a click on Next/Skip has executed successfully.","thought":"History already shows a successful click on Next. Nothing more to do.","action":{"type":"finish","reason":"Already clicked Next; task complete."}}`;

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, provider: PROVIDER, model: cfg.model }));

app.get('/api/budget', (req, res) => {
  resetBudgetIfNewDay();
  res.json({
    provider: PROVIDER,
    dailySpendUsd: Number(budget.dailySpend.toFixed(4)),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    maxCostPerTaskUsd: MAX_COST_PER_TASK_USD,
    tasksToday: budget.perTask.size,
  });
});

app.post('/api/plan', async (req, res) => {
  const {
    taskId, screenshot, task, history, elements, elementCount, domSnapshot,
    pageText, url, title, scrollY, scrollHeight, navigatedSinceStart, openTabs, overallPlan,
    step, maxSteps, urlTrail,
  } = req.body;

  console.log('Received plan request for task:', task);

  if (!screenshot) return res.status(400).json({ error: 'screenshot required' });
  if (!task)       return res.status(400).json({ error: 'task required' });

  const effectiveTaskId = taskId || 'default';

  const userText = `TASK: ${task}

STEP: ${step || 1} of up to ${maxSteps || 30}

URL: ${url || '?'}
TITLE: ${title || '?'}
SCROLL: ${scrollY || 0}px / ${scrollHeight || 0}px total
NAVIGATED_SINCE_START: ${navigatedSinceStart ? 'true' : 'false'}
ELEMENT_COUNT_THIS_STEP: ${elementCount ?? '?'}

URL TRAIL (ground truth — every distinct page actually visited, in order; trust this over any memory of what page you think you're on):
${urlTrail || '(no navigation yet)'}

OPEN TABS:
${openTabs || '(only one tab open)'}

OVERALL PLAN (set at step 1 — repeat unchanged unless it was genuinely wrong):
${overallPlan || '(not yet set — this is step 1, define it now)'}

INTERACTIVE ELEMENTS (match numbered labels in screenshot):
${elements || '(none)'}

DOM SNAPSHOT:
${domSnapshot || '(empty)'}

PAGE TEXT (visible body text, truncated):
${pageText || '(empty)'}

RECENT HISTORY:
${history || 'None — step 1.'}

What is your next action?${PROVIDER === 'anthropic' ? '' : ' Remember: respond with ONLY the JSON object.'}`;

  try {
    assertBudget(effectiveTaskId);

    let action;
    if (PROVIDER === 'anthropic') {
      action = await callAnthropic(userText, screenshot, effectiveTaskId);
    } else {
      // FIX: NVIDIA's own NIM release notes for the VLM container state
      // plainly — "Following Meta's guidance, system messages are not
      // allowed with images." We were sending role:'system' AND an image
      // in the same request on every single call. The API doesn't error
      // (so this was invisible in the logs), it just silently mishandles
      // the combination — which lines up exactly with the symptom: the
      // model producing plausible-sounding boilerplate ("the user has
      // already entered the origin and destination cities") that ignores
      // what's actually in the DOM/screenshot, because the instructions
      // for HOW to read the page were being dropped or garbled the moment
      // an image was attached.
      // Fix: fold the system prompt into the user message as a leading
      // text block instead of a separate system role. This is the
      // NVIDIA-documented supported shape for this model, and it's a
      // request-format fix — zero extra tokens/cost, same free-tier call.
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } },
            { type: 'text', text: `${SYSTEM_PROMPT}\n\n════════════════════════════════════════════════════════\n\n${userText}` },
          ],
        },
      ];
      const raw = await callOpenAICompatible(messages);
      action = extractJSON(raw);
    }

    res.json({ action });
  } catch (err) {
    console.error('LLM error:', err.message);
    if (err instanceof BudgetError) return res.status(402).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Provider calls ─────────────────────────────────────────────────────────

async function callOpenAICompatible(messages) {
  const body = {
    model: cfg.model,
    messages,
    max_tokens: 1024,
    temperature: 0.1,
  };

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${PROVIDER} API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content
    || data.choices?.[0]?.text
    || '';

  if (!content) throw new Error('Empty response from model');
  return content;
}

async function callAnthropic(userText, screenshotB64, taskId) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC.model,
      max_tokens: 1024,
      temperature: 0.1,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshotB64 } },
          { type: 'text', text: userText },
        ],
      }],
      tools: [ACTION_TOOL],
      tool_choice: { type: 'tool', name: 'browser_action' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`anthropic API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const usage = data.usage || {};
  const costUsd = ((usage.input_tokens || 0) * ANTHROPIC_INPUT_COST_PER_MTOK +
                    (usage.output_tokens || 0) * ANTHROPIC_OUTPUT_COST_PER_MTOK) / 1_000_000;
  recordSpend(taskId, costUsd);
  console.log(
    `Anthropic call: ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out → $${costUsd.toFixed(4)}` +
    ` (task total $${(budget.perTask.get(taskId) || 0).toFixed(4)}, day total $${budget.dailySpend.toFixed(4)})`
  );

  const toolBlock = data.content?.find(b => b.type === 'tool_use');
  if (!toolBlock) throw new Error('Anthropic response had no tool_use block');
  return toolBlock.input; // already structured {game_plan, thought, action} — no parsing needed
}

// ─── JSON extraction ────────────────────────────────────────────────────────
// Open-source models (NVIDIA / Ollama path only) sometimes wrap the JSON in
// markdown or add preamble despite instructions. Not used for Anthropic,
// which returns pre-structured tool input instead.

function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("No JSON object found");

  const jsonStr = text.substring(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    throw new Error("Failed to parse JSON: " + jsonStr.substring(0, 50));
  }
}
// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent server listening on http://0.0.0.0:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  if (PROVIDER === 'anthropic') {
    console.log(`Budget caps: $${MAX_COST_PER_TASK_USD}/task, $${DAILY_BUDGET_USD}/day (edit server/.env to change)`);
  }
});
