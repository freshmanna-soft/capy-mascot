// Minimal Server-Sent Events reader over a `fetch` response body, shared by
// both chat backends — Anthropic's /v1/messages and Ollama's
// OpenAI-compatible /v1/chat/completions both speak the same wire format:
// events separated by a blank line, payload carried on `data:` lines. Yields
// each payload already JSON-parsed, so callers only deal with objects.
//
// Hand-rolled rather than a dependency: this is the app's only SSE consumer
// and it needs no event-name dispatch at all (both APIs put a discriminating
// `type`/shape inside the JSON itself, so the `event:` line is redundant),
// which makes a library more code than it saves.
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF here rather than per-line: a \r\n pair split across two
      // network chunks leaves a lone trailing \r in the buffer, which this
      // joins up on the next pass. Only complete events are consumed below,
      // so nothing is lost to that split.
      buffer = buffer.replace(/\r\n/g, '\n');
      // Everything before the last blank line is a complete event; whatever
      // follows is one still arriving, so it stays buffered.
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue; // `event:` / `id:` / `:` comments
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') return; // OpenAI's end sentinel; Anthropic has none
          try {
            yield JSON.parse(payload);
          } catch {
            // One malformed payload isn't worth failing a whole turn over.
          }
        }
      }
    }
  } finally {
    // Abandoned early (the consumer broke out, or something upstream threw) —
    // release the socket rather than leaving it half-read.
    reader.cancel().catch(() => {});
  }
}

module.exports = { sseEvents };
