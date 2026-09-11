// Open-ended chat via a local Ollama model — no network hop, no remote proxy
// latency. Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint,
// so this is the same request/response shape as chat.js's Anthropic call,
// just pointed at localhost with a placeholder auth header Ollama ignores.
//
// Tool-calling works here too — tested directly against this model with the
// bridge's actual tool set before wiring this up (a small, well-defined
// tool list is well within what a model like llama3.2 handles correctly,
// despite the assumption otherwise). Same tool-call loop shape as chat.js's
// Anthropic path, just OpenAI's tool_calls/role:"tool" message shape instead
// of Anthropic's tool_use/tool_result content blocks.
//
// Responses stream (stream: true), so the caption can fill in as the model
// writes rather than appearing all at once when the turn is already over —
// see the onText contract on reply(), below.
const bridgeTools = require('./bridge-tools');
const { sseEvents } = require('./sse');

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const MAX_TOOL_ROUNDS = 4; // backstop against a confused model looping forever
// Was a 15s AbortSignal.timeout over the whole request. With streaming that
// would abort mid-generation on any answer taking longer than 15s, killing
// good turns. It's now a time-to-FIRST-TOKEN deadline instead: a model that
// never starts still fails fast, but one that's mid-sentence is left alone.
const FIRST_TOKEN_TIMEOUT_MS = 15000;

class ChatLocalError extends Error {}

/**
 * One streamed completion call. Reassembles the pieces OpenAI-style streaming
 * splits apart — text from `delta.content`, and tool calls from `delta.tool_calls`
 * fragments keyed by `index` (name and id arrive once, `arguments` accumulates
 * across many deltas) — into the same shape the non-streaming response had.
 * `onText(textSoFar)` fires with this call's accumulated text as it grows.
 */
async function callOllamaStream(messages, onText) {
  const controller = new AbortController();
  let sawFirstToken = false;
  const deadline = setTimeout(() => {
    if (!sawFirstToken) controller.abort();
  }, FIRST_TOKEN_TIMEOUT_MS);
  const gotFirstToken = () => {
    if (sawFirstToken) return;
    sawFirstToken = true;
    clearTimeout(deadline);
  };

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ollama' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        max_tokens: 300,
        messages,
        tools: bridgeTools.toOpenAITools(),
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(deadline);
    throw new ChatLocalError(`Failed to reach Ollama at ${OLLAMA_URL}: ${err.message}`);
  }
  if (!res.ok) {
    clearTimeout(deadline);
    const detail = await res.text().catch(() => '');
    throw new ChatLocalError(`Ollama returned ${res.status}: ${detail.slice(0, 200)}`);
  }

  let text = '';
  const toolCalls = [];
  try {
    for await (const event of sseEvents(res)) {
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        gotFirstToken();
        text += delta.content;
        if (onText) onText(text);
      }
      for (const part of delta.tool_calls ?? []) {
        gotFirstToken();
        const index = part.index ?? 0;
        if (!toolCalls[index]) toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        const slot = toolCalls[index];
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.function.name = part.function.name;
        if (part.function?.arguments) slot.function.arguments += part.function.arguments;
      }
    }
  } catch (err) {
    throw new ChatLocalError(`Ollama stream failed: ${err.message}`);
  } finally {
    clearTimeout(deadline);
  }
  return { text, toolCalls: toolCalls.filter(Boolean) };
}

// Tool-call plumbing stays local to this one turn — built from a copy of
// `messages`, not mutated in place, so chat.js's persisted history doesn't
// bloat with tool round-trips every turn (same approach as replyViaAnthropic).
//
// `onText(textSoFar)`, if given, fires with the accumulated text of the
// CURRENT round. Accumulation restarts each round, so a pre-tool-call aside
// ("let me check the bridge...") shows while it happens and is then replaced
// by the real answer — the caption always ends on exactly what gets spoken.
async function reply(messages, systemPrompt, onText) {
  const local = [{ role: 'system', content: systemPrompt }, ...messages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { text, toolCalls } = await callOllamaStream(local, onText);

    if (toolCalls.length > 0) {
      local.push({ role: 'assistant', content: text, tool_calls: toolCalls });
      for (const call of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // Malformed arguments — run with none rather than fail the turn.
        }
        const result = await bridgeTools.runTool(call.function?.name, args);
        local.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    return text.trim();
  }
  throw new ChatLocalError('Tool-use loop did not resolve to a final answer.');
}

module.exports = { reply, OLLAMA_MODEL, ChatLocalError };
