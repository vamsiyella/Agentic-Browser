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

// ─── Budget + usage tracking ────────────────────────────────────────────────
// Dollar caps only apply to Anthropic (the only paid provider here), but
// call/token counts are now tracked for EVERY provider — including the free
// NVIDIA/Ollama paths — because free doesn't mean unlimited: NVIDIA's NIM
// free tier still enforces its own rate limits, and there was previously no
// visibility into how close you were to them until a 429 actually happened.

const MAX_COST_PER_TASK_USD = parseFloat(process.env.MAX_COST_PER_TASK_USD || '1.00');
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');
const ANTHROPIC_INPUT_COST_PER_MTOK = parseFloat(process.env.ANTHROPIC_INPUT_COST_PER_MTOK || '3.00');
const ANTHROPIC_OUTPUT_COST_PER_MTOK = parseFloat(process.env.ANTHROPIC_OUTPUT_COST_PER_MTOK || '15.00');

class BudgetError extends Error {}

const budget = {
  dailySpend: 0,
  dailyResetDate: new Date().toDateString(),
  perTask: new Map(),
  // NEW: provider-agnostic usage counters.
  callsToday: 0,
  tokensToday: 0,
  callTimestamps: [], // ms epoch timestamps of recent calls, pruned to last 60s
};

function resetBudgetIfNewDay() {
  const today = new Date().toDateString();
  if (budget.dailyResetDate !== today) {
    budget.dailyResetDate = today;
    budget.dailySpend = 0;
    budget.perTask.clear();
    budget.callsToday = 0;
    budget.tokensToday = 0;
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

// NEW: call this after EVERY successful LLM call, regardless of provider.
// Tracks how many calls/tokens have happened today and in the last 60s, so
// a free-tier rate limit (RPM/RPD) can be seen coming instead of just
// showing up as a sudden 429.
function recordCall(tokensIn = 0, tokensOut = 0) {
  resetBudgetIfNewDay();
  budget.callsToday += 1;
  budget.tokensToday += (tokensIn + tokensOut);
  const now = Date.now();
  budget.callTimestamps.push(now);
  budget.callTimestamps = budget.callTimestamps.filter(t => now - t < 60_000);
}

function callsLastMinute() {
  const now = Date.now();
  budget.callTimestamps = budget.callTimestamps.filter(t => now - t < 60_000);
  return budget.callTimestamps.length;
}

// ─── Action schema ──────────────────────────────────────────────────────────
// Shared description used in the prompt for every provider, and as a strict
// tool schema for Anthropic's native tool-calling.
//
// Action families:
//  - Single-element actions (unchanged): click, type, scroll, select, hover
//  - Navigation/tab actions (unchanged): navigate, new_tab, switch_tab,
//    close_tab, go_back, go_forward, wait, key_press
//  - Control actions (unchanged): ask_user, finish
//  - NEW bulk data/UI actions: extract, expand_all, scroll_to_bottom,
//    find_images, check_matching
//  - NEW buffer/download actions: export_data, copy_clipboard,
//    download_asset, download_matching_images

const ACTION_TYPES = [
  'click', 'type', 'scroll', 'select', 'hover',
  'navigate', 'new_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward',
  'wait', 'key_press', 'ask_user', 'finish',
  // bulk data / UI actions
  'extract', 'expand_all', 'scroll_to_bottom', 'find_images', 'check_matching',
  // buffer / download actions
  'export_data', 'copy_clipboard', 'download_asset', 'download_matching_images',
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
          element_id: { type: 'string', description: "Required for click/type/select/hover. Optional for extract (table mode) to point at a specific table. Must come from THIS step's element list, never a remembered one." },
          text: { type: 'string', description: 'For type actions.' },
          clear_first: { type: 'boolean', description: 'type clears the field by default; set this to false ONLY to append instead of replace.' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' },
          url: { type: 'string', description: 'For navigate or new_tab. Also required for download_asset (the file URL to download).' },
          tab_index: { type: 'number', description: 'Index into the OPEN TABS list, for switch_tab/close_tab.' },
          key: { type: 'string', description: 'For key_press, e.g. "Enter", "Escape", "Tab".' },
          value: { type: 'string', description: 'For select actions.' },
          ms: { type: 'number', description: 'For wait actions.' },
          question: { type: 'string', description: 'Required for ask_user — one short, specific question for the human when a genuinely unstated preference blocks progress.' },
          reason: { type: 'string', description: 'Why this action, or why the task is finished.' },

          // ── extract ──
          extract_mode: {
            type: 'string',
            enum: ['emails', 'external_links', 'table', 'custom_regex'],
            description: 'Required for action.type="extract". "emails": every email address on the page (visible text + mailto: links). "external_links": every link to a different domain, as [url, link text] rows — internal nav links are excluded. "table": transcribes the largest (or element_id-targeted) <table> on the page into rows. "custom_regex": runs "pattern" over the page\'s visible text and returns each match\'s capture groups as a row — use this for free-text data rips like "county name and fatality count" out of an unformatted document.',
          },
          pattern: { type: 'string', description: 'Regex pattern, required for extract_mode="custom_regex". Use capture groups for each column you want, e.g. "([A-Za-z ]+) County.*?(\\\\d+) (?:killed|fatalit)" to pull (county, fatalities) pairs.' },
          flags: { type: 'string', description: 'Regex flags for extract_mode="custom_regex", e.g. "gi". "g" is always applied automatically.' },

          // ── expand_all ──
          match_patterns: {
            type: 'array',
            items: { type: 'string' },
            description: 'For expand_all — extra lowercase label substrings to click besides the built-in accordion/"read more"/"show more"/aria-expanded defaults, e.g. ["faq toggle", "+ details"].',
          },

          // ── scroll_to_bottom ──
          times: { type: 'number', description: 'For scroll_to_bottom — how many scroll-to-bottom iterations to perform (auto-stops early once page height stops growing for 3 iterations in a row, so it is safe to ask for more than you think you need, e.g. 15).' },

          // ── find_images / download_matching_images ──
          min_width: { type: 'number', description: 'For find_images/download_matching_images — minimum natural width in pixels (e.g. 1000 for "hi-res only").' },
          min_height: { type: 'number', description: 'For find_images/download_matching_images — minimum natural height in pixels.' },
          exclude_hints: {
            type: 'array',
            items: { type: 'string' },
            description: 'For find_images/download_matching_images — lowercase substrings checked against each image\'s alt text/class/src that should be EXCLUDED, e.g. ["logo","icon","avatar","profile"] to skip UI chrome and keep only content images like diagrams/charts.',
          },

          // ── check_matching ──
          keyword: { type: 'string', description: 'For check_matching — checks every unchecked, visible checkbox whose containing row/list-item/label text contains this keyword (case-insensitive), e.g. "Promo" to select every promotional email before a batch delete. Does not click delete itself — do that as a separate click action afterward so the selection can be sanity-checked first.' },

          // ── export_data / copy_clipboard ──
          format: { type: 'string', enum: ['csv', 'json'], description: 'For export_data/copy_clipboard — output format of the accumulated extraction buffer. Default csv (clean two-column lists, contact lists, tables, and link harvests all read naturally as CSV).' },
          filename: { type: 'string', description: 'For export_data — filename to save the export as. For download_asset — filename to save the downloaded file as. Optional; a sensible default is used if omitted.' },
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
- You have NO filesystem, NO shell, NO code execution — only browser actions: click, type, scroll, select, hover, navigate, new_tab, switch_tab, close_tab, go_back, go_forward, wait, key_press, ask_user, finish, extract, expand_all, scroll_to_bottom, find_images, check_matching, export_data, copy_clipboard, download_asset, download_matching_images.

You operate in a continuous OBSERVE → ORIENT → DECIDE → ACT loop, not a fixed checklist. Simple tasks finish in one action; complex ones take many. Never pad extra actions to match an assumed plan length, and never stop before the task is genuinely satisfied.

OUTPUT FORMAT: ${PROVIDER === 'anthropic'
  ? 'Call the browser_action tool with your decision. Do not respond with plain text.'
  : 'Output ONLY raw JSON, NO markdown, NO backticks, NO text outside the JSON object: {"game_plan":"...","thought":"...","action":{"type":"...","element_id":"12","text":"...","direction":"down","url":"...","tab_index":0,"key":"Enter","question":"...","reason":"...","extract_mode":"...","pattern":"...","times":10,"min_width":1000,"exclude_hints":["logo"],"keyword":"...","format":"csv"}}. There is no "is_done" field — completion is signaled ONLY by action.type === "finish".'}

════════════════════════════════════════════════════════
ZERO INTERACTIVE ELEMENTS IS NOT A DEAD END
════════════════════════════════════════════════════════
The INTERACTIVE ELEMENTS list can legitimately be empty — long articles, a blank new tab, a page still loading, or a page where nothing in the current viewport happens to be clickable. This does NOT mean you are stuck. Element-free actions work regardless of what's on screen: navigate, new_tab, switch_tab, close_tab, go_back, go_forward, wait, key_press, finish, extract, expand_all, scroll_to_bottom, find_images. Read PAGE TEXT and the DOM SNAPSHOT for content, and either scroll to look for controls, or take the element-free action the task actually calls for. NEVER give up just because the element list is empty.

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
FIELD STATE CHECK — read before every type/click
════════════════════════════════════════════════════════
"type" REPLACES a field's entire content by default (it clears first automatically — you do not need to clear it yourself). Before typing into any field, check the DOM SNAPSHOT's val="..." for that field's CURRENT actual content:
- If it already shows the value you intend to type, do NOT type again — the field is already correct. Move on to the next step (press Enter / click submit / click the matching suggestion in a dropdown).
- If RECENT HISTORY already shows a successful "type" on that same field with a matching resultingValue/[FIELD NOW CONTAINS: ...], trust that over your own instinct — don't re-type just because an on-screen dropdown still shows suggestions; that's the field working correctly, not evidence it's empty.
- Only type again if the CURRENT DOM SNAPSHOT genuinely shows a different or empty value than intended.

════════════════════════════════════════════════════════
BULK DATA COLLECTION — extract / export_data / copy_clipboard
════════════════════════════════════════════════════════
Use "extract" to pull structured data OFF the current page WITHOUT reasoning over it token-by-token yourself — it runs deterministic code in the page and returns clean rows. Every successful extract's rows are automatically appended to a running DATA BUFFER that persists for the rest of the task (you'll see its current size in "DATA BUFFER" below each observation) — you never have to re-state or remember the data yourself, and you don't need to re-extract a page you already extracted.
- extract_mode="emails" → contact scraping (directories, team pages): every email address on the page.
- extract_mode="external_links" → link harvesting from a citation-heavy article/wiki page: only links to OTHER domains, skipping internal nav.
- extract_mode="table" → transcribing a messy HTML <table> (e.g. old government data sites) into clean rows.
- extract_mode="custom_regex" → free-text data rips (e.g. pulling "county name" + "fatality count" pairs out of an unformatted document): write a regex with one capture group per column you want.
Once you've collected everything the task asked for, flush the buffer EXACTLY ONCE with:
- "export_data" (format csv or json) to save it as a downloaded file, or
- "copy_clipboard" to put it straight on the clipboard (use this when the task says "copy" rather than "download"/"save").
Then finish. Don't call export_data/copy_clipboard more than once per task unless the task explicitly asks for multiple separate exports.

PAGINATED / CROSS-PAGE SCRAPING PATTERN: for "scrape page 1 through N" or "every result across all pages" tasks: extract → click the actual Next-page control → extract → click Next → ... After each extract, the DATA BUFFER count should have grown; if it doesn't grow after a page you expected new data on, the page likely didn't change (check URL TRAIL) — don't just keep clicking Next blindly. Stop paginating once you've covered the requested page range or Next is no longer present/enabled, then export_data/copy_clipboard once, then finish.

════════════════════════════════════════════════════════
BULK PAGE MANIPULATION — expand_all / scroll_to_bottom
════════════════════════════════════════════════════════
- "expand_all" clicks every collapsed accordion / "Read more" / "Show more" / <details> / aria-expanded="false" control on the page repeatedly until none remain (FAQ pages, docs with collapsed sections). Do this BEFORE extracting or reading page text if the content you need might be hidden behind a toggle.
- "scroll_to_bottom" (with "times", e.g. 15) forces an infinite-scroll feed to load more content by repeatedly scrolling to the bottom and waiting for lazy content — it auto-stops early once the page stops growing, so it's safe to ask for more iterations than you think you'll need. Use this before extract/find_images/download_matching_images on feeds, image boards, or any page that lazy-loads on scroll.

════════════════════════════════════════════════════════
BULK IMAGE / FILE DOWNLOADS — find_images / download_matching_images / download_asset
════════════════════════════════════════════════════════
- "find_images" (min_width, min_height, exclude_hints) previews which images on the page meet a size/content filter, without downloading anything — use it first if you want to sanity-check the filter before committing to a bulk download.
- "download_matching_images" (min_width, min_height, exclude_hints) re-runs that same filter and downloads every match via the browser's downloads. Use min_width/min_height for "hi-res only" requests (e.g. 1000/1000), and exclude_hints for "ignore logos/icons/avatars" style requests (default excludes already skip common UI chrome like logo/icon/avatar/sprite/badge/button — add more terms specific to the page if needed, e.g. "thumbnail" for a gallery that also shows small preview crops).
- "download_asset" (url, optional filename) downloads one specific file by direct URL — e.g. a PDF link you found via extract_mode="external_links" or by reading the DOM snapshot. For "download the first 20 search results' PDFs", plan on repeating: read/click to the item's PDF link → download_asset with that url → back to results → next item.

════════════════════════════════════════════════════════
BATCH SELECTION / DELETION — check_matching
════════════════════════════════════════════════════════
"check_matching" (keyword) checks every unchecked, visible checkbox whose row/list-item/label text contains the keyword — e.g. keyword "Promo" to select every promotional email in an inbox before deleting. It does NOT click delete for you: after check_matching, look at the resulting screenshot/DOM to confirm the right items got checked, THEN issue a separate "click" on the actual delete/trash button.

════════════════════════════════════════════════════════
TASK COMPLETION — check this before every action
════════════════════════════════════════════════════════
PATTERN A — repeatable action already satisfied: if RECENT HISTORY shows a successful action matching what the task asked for (e.g. task says "skip song" and history shows a successful click on "Next"), finish now. Don't repeat it just because an identical button is still visible.
Exception: if the task asks for a count ("skip 3 songs"), only finish once that many matching successes are in history.

PATTERN B — one-shot navigational/tab action ("click X", "open X", "go to wikipedia"): once the click/navigate executes and takes effect (NAVIGATED_SINCE_START is true, or history shows a successful matching action), the task is done — finish. Do not reinterpret the task on the new page. Only continue if the task explicitly names multiple sequential destinations.

PATTERN C — conditional tasks ("if X do A, else do B"): resolve as soon as either branch executes once. Don't re-check the condition after navigating.

PATTERN D — pure tab-management tasks ("open a new tab", "close this tab", "switch to the Wikipedia tab"): satisfied the instant the corresponding tab action succeeds. Nothing further to do on the resulting page unless the task says so.

PATTERN E (search box that jumps straight to a page): many sites skip the results-list step for an exact/near match — submitting a search can navigate DIRECTLY to a specific content page instead of a results list. If URL TRAIL shows you landed on a specific page whose title matches/relates to the query, that already satisfies "search for X and open/click the first result." Only keep clicking if you land on an actual results-LIST page with multiple candidates to choose between.

PATTERN F — bulk extraction/download/pagination tasks: these are done once (a) the DATA BUFFER holds everything the task asked for AND you've called export_data/copy_clipboard exactly once, OR (b) for pure download tasks, download_matching_images/download_asset has run for every matching item/page the task specified. Don't finish a "copy/export/download all X" task without actually calling export_data, copy_clipboard, download_asset, or download_matching_images at least once — collecting into the buffer or previewing with find_images is not itself the deliverable.

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
RECENT HISTORY shows what you were thinking on past steps. That's your own prior guess, not a fact — if the page has navigated since then, an old thought like "we're still on the homepage" can be flat-out wrong, and repeating it just reinforces the same mistake. Before writing THOUGHT this turn, check it against URL TRAIL and CURRENT URL below — those are read directly from the browser, computed by code, never guessed. If your instinct disagrees with URL TRAIL, URL TRAIL is right. Each RECENT HISTORY line also shows [NAVIGATED: A → B] when an action actually caused navigation, and [FIELD NOW CONTAINS: ...] for the actual post-type value of a field — both are ground truth about what really happened, independent of what you thought would happen.

════════════════════════════════════════════════════════
USE THE STEP COUNT — DON'T RE-DO WORK YOU'VE ALREADY DONE
════════════════════════════════════════════════════════
You are told which step you're on out of the max. If you're several steps in, earlier sub-goals ("open a new tab", "navigate to X") are almost certainly already behind you — check URL TRAIL before assuming you still need to do them. A task with N sub-goals should usually finish in roughly N to N+2 steps; if you're well past that, stop and ask: does the CURRENT URL / TITLE already satisfy the task? If yes, finish now instead of taking another action to double-check.

════════════════════════════════════════════════════════
ASKING THE USER (use sparingly)
════════════════════════════════════════════════════════
Use action "ask_user" with a "question" field ONLY when the task is genuinely ambiguous in a way that only the human can resolve — an unstated preference or constraint that isn't on the page and can't be reasonably inferred (e.g. "find me a flight" with no stated max stops, budget, or time window; or a fork where multiple reasonable options diverge and nothing in the task or page breaks the tie). Ask ONE short, specific question. This pauses the whole run until the human answers, so do NOT use it for things you can figure out by reading the page, or for routine choices with an obvious default — guess a sensible default and mention the assumption in your reasoning instead.

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
Correct response: {"game_plan":"Goal: skip to the next track. Done when a click on Next/Skip has executed successfully.","thought":"History already shows a successful click on Next. Nothing more to do.","action":{"type":"finish","reason":"Already clicked Next; task complete."}}

EXAMPLE — ask_user for a genuinely unstated preference:
TASK: "find me the cheapest flight"
Correct response: {"game_plan":"Goal: find the cheapest flight matching the human's constraints. Not yet defined which constraints matter.","thought":"The task doesn't say how many stops are acceptable, which changes what \\"cheapest\\" even means (a 1-stop flight is often much cheaper than nonstop). This isn't inferable from the page — better to ask than guess wrong.","action":{"type":"ask_user","question":"Is a flight with layovers okay, or do you need nonstop only?"}}

EXAMPLE — Pattern F, bulk contact scrape:
TASK: "copy every email address on this page into one comma-separated list"
DATA BUFFER: 0 rows collected so far.
Correct response: {"game_plan":"Goal: every email on the page copied to the clipboard as one comma-separated list. Done once extract has run and copy_clipboard has flushed the buffer.","thought":"This is a bulk-extraction task. Run extract with extract_mode=emails first; the result goes into the data buffer automatically.","action":{"type":"extract","extract_mode":"emails","reason":"Pull every email address on the current page into the data buffer."}}
(Next step, once DATA BUFFER shows rows collected) Correct response: {"game_plan":"Goal: every email on the page copied to the clipboard as one comma-separated list. Done once extract has run and copy_clipboard has flushed the buffer.","thought":"Emails are already in the buffer. Flushing it to the clipboard now satisfies the task; nothing left to extract on this single page.","action":{"type":"copy_clipboard","format":"csv","reason":"Task said 'copy', so clipboard rather than a file download."}}
(Final step) Correct response: {"game_plan":"Goal: every email on the page copied to the clipboard as one comma-separated list. Done once extract has run and copy_clipboard has flushed the buffer.","thought":"copy_clipboard already succeeded. Task complete.","action":{"type":"finish","reason":"Emails extracted and copied to clipboard."}}`;

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, provider: PROVIDER, model: cfg.model }));

app.get('/api/budget', (req, res) => {
  resetBudgetIfNewDay();
  res.json({
    provider: PROVIDER,
    model: cfg.model,
    // Dollar figures are only meaningful for Anthropic — 0 for free providers.
    dailySpendUsd: Number(budget.dailySpend.toFixed(4)),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    maxCostPerTaskUsd: MAX_COST_PER_TASK_USD,
    tasksToday: budget.perTask.size,
    // NEW: provider-agnostic usage, meaningful for free providers too.
    callsToday: budget.callsToday,
    tokensToday: budget.tokensToday,
    callsLastMinute: callsLastMinute(),
  });
});

app.post('/api/plan', async (req, res) => {
  const {
    taskId, screenshot, task, history, elements, elementCount, domSnapshot,
    pageText, url, title, scrollY, scrollHeight, navigatedSinceStart, openTabs, overallPlan,
    step, maxSteps, urlTrail, dataBufferCount, dataBufferKind,
  } = req.body;

  console.log('Received plan request for task:', task);

  if (!screenshot) return res.status(400).json({ error: 'screenshot required' });
  if (!task)       return res.status(400).json({ error: 'task required' });

  const effectiveTaskId = taskId || 'default';

  const bufferStatus = dataBufferCount
    ? `${dataBufferCount} row(s) collected so far (kind: ${dataBufferKind || 'unknown'}). Keep extracting more pages if the task isn't fully covered yet, or export_data/copy_clipboard once you are done, then finish.`
    : '0 rows collected so far.';

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

DATA BUFFER (accumulated rows from 'extract' actions this task — ground truth, computed by code):
${bufferStatus}

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
      const { content: raw, usage } = await callOpenAICompatible(messages);
      recordCall(usage?.prompt_tokens || 0, usage?.completion_tokens || 0);
      console.log(
        `[${PROVIDER}] call #${budget.callsToday} today — ` +
        `${usage?.prompt_tokens || 0} in / ${usage?.completion_tokens || 0} out tokens ` +
        `(day total: ${budget.tokensToday} tokens, ${callsLastMinute()} calls in last 60s)`
      );
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
    // Surface rate-limit responses clearly instead of a generic 500 — free
    // tiers (NVIDIA NIM included) DO have per-minute/per-day request caps.
    if (resp.status === 429) {
      throw new Error(`${PROVIDER} API 429: rate limit hit. ${text.slice(0, 200)}`);
    }
    throw new Error(`${PROVIDER} API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content
    || data.choices?.[0]?.text
    || '';

  if (!content) throw new Error('Empty response from model');
  return { content, usage: data.usage || null };
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
  recordCall(usage.input_tokens || 0, usage.output_tokens || 0);
  console.log(
    `[anthropic] call #${budget.callsToday} today — ${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out → $${costUsd.toFixed(4)}` +
    ` (task total $${(budget.perTask.get(taskId) || 0).toFixed(4)}, day total $${budget.dailySpend.toFixed(4)}, ${callsLastMinute()} calls in last 60s)`
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
  } else {
    console.log(`Usage tracking: calls/tokens logged per request and available at GET /api/budget (no $ cost on ${PROVIDER}).`);
  }
});
