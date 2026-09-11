// IBM Watson Speech to Text, streamed over its WebSocket API for lower
// latency than the batch REST /v1/recognize call (upload-the-whole-recording,
// then wait) — audio is forwarded to Watson as it's captured, and Watson
// finalizes pieces of the transcript as it goes rather than all at once at
// the end. Basic auth with username "apikey" — no IAM token exchange, same
// as the REST version and your-career-mentor's voice.service.ts.
const WebSocket = require('ws');
const { cleanTranscript } = require('./transcript-filter');

const STT_KEY = process.env.WATSON_STT_APIKEY;
const STT_URL = process.env.WATSON_STT_URL;
const STT_MODEL = process.env.WATSON_STT_MODEL || 'en-US_Multimedia';

// How long to wait for a last trailing final result after sending "stop"
// before we close the connection ourselves, rather than waiting on Watson to
// close it (it doesn't reliably do so — see finish(), below).
const GRACE_MS = 600;
// Outer backstop only, for the case our own ws.close() somehow doesn't fire
// 'close' promptly — should essentially never be hit in practice.
const FINISH_TIMEOUT_MS = 3000;

// How long of pure silence (no speech detected at all) before Watson closes
// the connection on its own — this is what lets a conversation end itself
// without any keypress. Short enough that trailing off mid-conversation
// actually ends it soon after; long enough not to cut off someone who
// paused to think.
const INACTIVITY_TIMEOUT_S = 12;

class SttError extends Error {}

function enabled() {
  return !!(STT_KEY && STT_URL);
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`apikey:${STT_KEY}`).toString('base64');
}

/**
 * Opens one streaming session. Resolves once Watson is ready to receive
 * audio (its "listening" state), with `{ send(buffer), finish() }`:
 *   - send(buffer): forward one chunk of audio (any size, in order).
 *   - finish(): signal end-of-audio; resolves with the final transcript once
 *     Watson closes the connection (or the backstop timeout fires).
 *
 * `onPartial(text)`, if given, fires on every interim AND final result with
 * the best current guess at the full transcript so far — this is what lets a
 * caller show the user's own words on screen as they're recognized, not just
 * once at the very end.
 *
 * `onEnded(transcript)`, if given, fires if the connection closes on its own
 * — i.e. nobody ever called `finish()` — most commonly Watson's own
 * inactivity timeout after enough silence. This is the actual mechanism for
 * "end the conversation without pressing anything": the caller doesn't have
 * to poll or guess, it just gets told when Watson decided nobody's talking
 * anymore.
 */
function createStreamingSession(onPartial, onEnded) {
  if (!enabled()) return Promise.reject(new SttError('Watson STT not configured.'));

  return new Promise((resolve, reject) => {
    const wsUrl =
      STT_URL.replace(/^https:/, 'wss:').replace(/\/$/, '') +
      `/v1/recognize?model=${encodeURIComponent(STT_MODEL)}&smart_formatting=true`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: basicAuth() } });

    let ready = false;
    let finishing = false; // true once finish() has sent the stop action
    let transcript = ''; // finalized pieces only
    let finishResolve = null;

    const failToStart = (err) => {
      if (!ready) reject(err);
    };

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          action: 'start',
          'content-type': 'audio/webm;codecs=opus',
          interim_results: true,
          inactivity_timeout: INACTIVITY_TIMEOUT_S,
        })
      );
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error) {
        failToStart(new SttError(`Watson STT: ${msg.error}`));
        if (finishResolve) { finishResolve(cleanTranscript(transcript)); finishResolve = null; }
        return;
      }
      if (!ready && msg.state === 'listening') {
        ready = true;
        resolve({
          send: (buffer) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
          },
          finish: () =>
            new Promise((res) => {
              finishing = true;
              finishResolve = res;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'stop' }));
                // Watson does not reliably close the socket itself after
                // processing "stop" — observed empirically: every single
                // turn was falling all the way through to FINISH_TIMEOUT_MS
                // (8s) rather than finishing promptly, because ws.on('close')
                // just never fired on its own. Give any last trailing final
                // result a short grace window, then close the connection
                // ourselves — a client-initiated close fires 'close'
                // immediately, it doesn't depend on Watson cooperating.
                // FINISH_TIMEOUT_MS still exists below as an outer backstop,
                // in case even our own ws.close() somehow hangs.
                setTimeout(() => {
                  try { ws.close(); } catch { /* already closing */ }
                }, GRACE_MS);
                setTimeout(() => {
                  if (finishResolve) { finishResolve(cleanTranscript(transcript)); finishResolve = null; }
                }, FINISH_TIMEOUT_MS);
              } else {
                res(cleanTranscript(transcript));
              }
            }),
        });
        return;
      }
      let latestInterim = '';
      for (const r of msg.results ?? []) {
        const piece = (r.alternatives?.[0]?.transcript ?? '').trim();
        if (!piece) continue;
        if (r.final) transcript += (transcript ? ' ' : '') + piece;
        else latestInterim = piece;
      }
      if (onPartial) onPartial((transcript + (latestInterim ? ' ' + latestInterim : '')).trim());
    });

    ws.on('close', () => {
      if (finishResolve) { finishResolve(cleanTranscript(transcript)); finishResolve = null; return; }
      // Closed without anyone calling finish() — Watson decided the
      // conversation is over (inactivity timeout, most likely).
      if (ready && !finishing && onEnded) onEnded(cleanTranscript(transcript));
    });
    ws.on('error', (err) => {
      failToStart(new SttError(`Watson STT WS: ${err.message}`));
      if (finishResolve) { finishResolve(cleanTranscript(transcript)); finishResolve = null; }
    });
  });
}

module.exports = { createStreamingSession, enabled, SttError };
