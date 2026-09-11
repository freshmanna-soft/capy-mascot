// Open-ended chat, direct to the Anthropic Messages API (no SDK). ANTHROPIC_BASE_URL
// overrides the host — same env var Anthropic's own CLI/SDK use for a corporate
// proxy — so this can point at an internal gateway instead of api.anthropic.com
// without changing the request shape at all.
//
// The "use local LLM" toggle (see setUseLocal) routes the same conversation
// through chat-local.js's Ollama call instead — same history, same system
// prompt, only the backend making the actual completion call changes. That
// keeps a mid-conversation switch seamless: the model doesn't lose context,
// only who's answering the next turn does.
const chatLocal = require('./chat-local');
const bridgeTools = require('./bridge-tools');
const { sseEvents } = require('./sse');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const MODEL = 'claude-sonnet-5';
const MAX_HISTORY_MESSAGES = 20; // ~10 user/assistant turns
const MAX_TOOL_ROUNDS = 4; // backstop against a confused model looping forever

class ChatError extends Error {}

let useLocal = false;

function setUseLocal(value) {
  useLocal = !!value;
}

function enabled() {
  return useLocal || !!API_KEY;
}

const history = [];

// Skips the paid API call for short greeting-type openers ("hello", "hi
// there", repeated while testing the mic) — but only when history is empty.
// Caching mid-conversation replies would answer from stale context once the
// same phrase reappears later in an actual back-and-forth, so this never
// applies past the first turn.
const OPENER_CACHE = new Map();
const OPENER_CACHE_MAX = 50;
const OPENER_MAX_CHARS = 40;

function normalizeOpener(text) {
  return text.trim().toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function systemPrompt(bridgeStatusSummary) {
  return (
    'You are Capy, a small capybara living on the user\'s desktop. You reflect, ' +
    'and can answer questions about, an autonomous dev-bridge build pipeline that ' +
    'writes code, opens PRs, and merges them under review-quorum gating. It moves ' +
    'through states: RESOLVING, BUILDING, PUSHING, REVIEWING, REPAIRING, ' +
    'AWAITING_APPROVAL, CHANGES_REQUESTED, MERGING, GATE_FAILED, ERROR, ' +
    'WORKTREE_FAILED, STOPPED, or idle. REPAIRING means the gate pushed back and ' +
    'the bridge is attempting a fix autonomously. ' +
    'Read-only tools — use these freely whenever the user asks about status, ' +
    'history, PRs, costs, or failures; answer from real data, never guess: ' +
    'get_bridge_status (current FSM state, branch, request, PR url, elapsed time, errors), ' +
    'get_recent_history (last 10 job outcomes with branch/PR/cost), ' +
    'get_pending_approvals (jobs awaiting human approval from the bridge side), ' +
    'get_open_prs (open GitHub PRs the bridge created, with review decisions), ' +
    'get_git_info (local branch state), ' +
    'get_job_log (structured summary: final result text, cost in USD, turn count, and review verdicts — call this when the user asks why something failed or what reviewers said). ' +
    'Write actions — these are STAGE-ONLY; calling the tool does NOT execute it. ' +
    'After staging, read back exactly what will happen and ask the user to confirm ' +
    'out loud (e.g. "say yes to confirm"). Never claim an action completed unless ' +
    'a tool result explicitly says so. If they say no or change the subject, drop it: ' +
    'trigger_build (queue a new build — free text or "#123" for an issue), ' +
    'create_github_issue (file an issue in the repo), ' +
    'approve_pr (approve a PR by URL — use get_open_prs first to find the URL). ' +
    'Keep replies short and conversational — they are spoken aloud, not read. ' +
    'Prefer one sentence answers for simple status questions. ' +
    `Last known status snapshot: ${bridgeStatusSummary || 'unknown'}.`
  );
}

/**
 * One streamed /v1/messages call, reassembled into exactly the
 * `{ content, stop_reason }` shape the non-streaming response returned — which
 * is why the tool-use loop below is untouched by streaming.
 *
 * Streaming splits a response into pieces that have to be put back together:
 * `content_block_start` opens a block, `content_block_delta` carries either a
 * `text_delta` (visible text) or an `input_json_delta` (a tool call's
 * arguments, as partial JSON fragments that must be concatenated and only
 * parsed once the block closes), and `message_delta` carries the stop_reason.
 * Thinking/signature deltas are accumulated too so a block echoed back on a
 * tool round is byte-faithful, exactly as the non-streaming path was.
 *
 * `onText(textSoFar)` fires with this call's accumulated visible text as it
 * grows — the whole point of streaming here, so the caption fills in while
 * the model writes instead of appearing all at once when the turn is over.
 */
async function streamAnthropic(messages, bridgeStatusSummary, onText) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: systemPrompt(bridgeStatusSummary),
        messages,
        tools: bridgeTools.toAnthropicTools(),
        stream: true,
      }),
    });
  } catch (err) {
    throw new ChatError(`Failed to reach Anthropic API: ${err.message}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ChatError(`Anthropic API returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  const content = [];
  const pendingInput = new Map(); // block index -> accumulated tool-input JSON
  let stopReason = null;
  let text = '';

  for await (const event of sseEvents(res)) {
    if (event.type === 'content_block_start') {
      content[event.index] = { ...event.content_block };
      if (event.content_block?.type === 'tool_use') pendingInput.set(event.index, '');
    } else if (event.type === 'content_block_delta') {
      const block = content[event.index];
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta') {
        if (block) block.text = (block.text || '') + delta.text;
        text += delta.text;
        if (onText) onText(text);
      } else if (delta.type === 'input_json_delta') {
        pendingInput.set(event.index, (pendingInput.get(event.index) || '') + (delta.partial_json || ''));
      } else if (delta.type === 'thinking_delta' && block) {
        block.thinking = (block.thinking || '') + (delta.thinking || '');
      } else if (delta.type === 'signature_delta' && block) {
        block.signature = (block.signature || '') + (delta.signature || '');
      }
    } else if (event.type === 'content_block_stop') {
      const raw = pendingInput.get(event.index);
      if (raw !== undefined) {
        if (content[event.index]) {
          try {
            content[event.index].input = raw ? JSON.parse(raw) : {};
          } catch {
            // A tool call whose arguments didn't parse runs with none, rather
            // than failing the whole turn — same posture as chat-local.js.
            content[event.index].input = {};
          }
        }
        pendingInput.delete(event.index);
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
    } else if (event.type === 'error') {
      throw new ChatError(`Anthropic API stream error: ${event.error?.message || 'unknown'}`);
    }
  }

  return { content: content.filter(Boolean), stop_reason: stopReason };
}

// Tool-call plumbing (the intermediate tool_use/tool_result messages) stays
// local to this one turn — it's built from a copy of `history`, not pushed
// into it. Only the final text answer gets persisted, by reply() below, so
// history doesn't bloat with tool round-trips every single turn.
async function replyViaAnthropic(bridgeStatusSummary, onText) {
  const messages = [...history];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const data = await streamAnthropic(messages, bridgeStatusSummary, onText);

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        const result = await bridgeTools.runTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    return (data.content ?? []).map((b) => b.text ?? '').join('').trim();
  }
  throw new ChatError('Tool-use loop did not resolve to a final answer.');
}

// Deliberately dumb and deterministic — this is the actual safety gate for
// trigger_build/create_github_issue, not the model's own judgment about
// whether the user confirmed. A misheard "yes" is still a real risk, but a
// simple keyword check on the user's own next words is a much smaller,
// more auditable surface than trusting an LLM to decide "did they confirm?"
const CONFIRM_RE = /^(yes|yeah|yep|yup|confirm|confirmed|go ahead|do it|please do|sure|okay|ok)\b/i;
const CANCEL_RE = /^(no|nope|nah|cancel|never ?mind|stop|don'?t)\b/i;

function describeStagedResult(name, result) {
  if (result.error) return `Something went wrong: ${result.error}`;
  if (name === 'trigger_build') return `Done — queued the build: ${result.request || ''}`.trim();
  if (name === 'create_github_issue') return `Done — created the issue: ${result.url}`;
  if (name === 'approve_pr') return `Done — PR approved.`;
  return 'Done.';
}

// `onText(textSoFar)` streams the reply into the caller as it is generated.
// Every return path fires it at least once, including the ones that never
// reach a model (cached opener, staged-action confirm/cancel), so the caption
// is populated the same way regardless of how the answer was produced.
async function reply(userText, bridgeStatusSummary, onText) {
  if (!enabled()) throw new ChatError('Anthropic API not configured.');

  // A staged write action is waiting on confirmation — settle that BEFORE
  // this turn goes anywhere near the model. The model doesn't get a vote.
  const pending = bridgeTools.getPending();
  if (pending) {
    const trimmed = userText.trim();
    if (CONFIRM_RE.test(trimmed)) {
      bridgeTools.clearPending();
      let result;
      try {
        result = { ...pending.args, ...(await bridgeTools.executeStaged(pending.name, pending.args)) };
      } catch (err) {
        result = { error: err.message };
      }
      const text = describeStagedResult(pending.name, result);
      history.push({ role: 'user', content: userText }, { role: 'assistant', content: text });
      if (onText) onText(text);
      return text;
    }
    bridgeTools.clearPending();
    if (CANCEL_RE.test(trimmed)) {
      const text = 'Okay, cancelled.';
      history.push({ role: 'user', content: userText }, { role: 'assistant', content: text });
      if (onText) onText(text);
      return text;
    }
    // Neither a clear yes nor no — don't leave a silent trap armed where a
    // later, unrelated "yes" (to something else entirely) would trigger it.
    // Falls through to a normal turn below.
  }

  const isOpener = history.length === 0 && userText.length <= OPENER_MAX_CHARS;
  const openerKey = isOpener ? normalizeOpener(userText) : null;
  if (openerKey && OPENER_CACHE.has(openerKey)) {
    const cached = OPENER_CACHE.get(openerKey);
    history.push({ role: 'user', content: userText }, { role: 'assistant', content: cached });
    if (onText) onText(cached);
    return cached;
  }

  history.push({ role: 'user', content: userText });
  if (history.length > MAX_HISTORY_MESSAGES) history.splice(0, history.length - MAX_HISTORY_MESSAGES);

  const text = useLocal
    ? await chatLocal.reply(history, systemPrompt(bridgeStatusSummary), onText)
    : await replyViaAnthropic(bridgeStatusSummary, onText);
  history.push({ role: 'assistant', content: text });

  if (openerKey) {
    if (OPENER_CACHE.size >= OPENER_CACHE_MAX) OPENER_CACHE.delete(OPENER_CACHE.keys().next().value);
    OPENER_CACHE.set(openerKey, text);
  }

  return text;
}

module.exports = { reply, enabled, setUseLocal, ChatError };
