// Live connection to the dev-bridge's Server-Sent-Events stream (its own
// dashboard already uses this same /events endpoint for real-time push) —
// replaces polling GET /status every few seconds, which meant up to
// POLL_MS of staleness on every state change plus constant wasted requests.
// No `eventsource` package: Node's built-in fetch + response.body's async
// iterator is enough, consistent with this project's zero-dep style
// elsewhere (stt.js, voice.js).
const { log } = require('./log');

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

/**
 * Connects to `${origin}/events` and stays connected, reconnecting with
 * backoff on any drop. `onStatus(status)` fires for every `event: status`
 * frame (the dev-bridge sends one immediately on connect, then again on
 * every real change) — that's the only event type the mascot needs; it
 * already gets the full picture from status alone, no need to separately
 * track action/error/subagent events. `onUnreachable()` fires whenever the
 * connection is down (initial connect failure or a drop), so the caller can
 * show "unreachable" the same way a failed poll used to.
 *
 * Returns a stop() function.
 */
function connect(origin, { onStatus, onUnreachable }) {
  let stopped = false;
  let delay = RECONNECT_MIN_MS;

  async function run() {
    while (!stopped) {
      try {
        const res = await fetch(`${origin}/events`, {
          headers: { Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error(`/events returned ${res.status}`);
        log(`[bridge] connected to ${origin}/events`);
        delay = RECONNECT_MIN_MS; // reset backoff on a successful connection

        let buffer = '';
        let eventType = null;
        for await (const chunk of res.body) {
          buffer += Buffer.from(chunk).toString('utf8');
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (eventType === 'status') {
                try {
                  onStatus(JSON.parse(data));
                } catch (err) {
                  log(`[bridge] bad status payload: ${err.message}`);
                }
              }
            } else if (line === '') {
              eventType = null; // blank line ends a frame
            }
          }
        }
        // Stream ended without an error — the bridge closed the connection
        // cleanly (e.g. restarting). Treat it the same as a drop.
        throw new Error('/events stream ended');
      } catch (err) {
        if (stopped) return;
        log(`[bridge] /events unreachable: ${err.message}`);
        onUnreachable();
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    }
  }

  run();
  return () => {
    stopped = true;
  };
}

module.exports = { connect };
