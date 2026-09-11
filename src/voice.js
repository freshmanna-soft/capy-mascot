// Voice output. Prefers IBM Watson Text-to-Speech (real IBM voice, on the
// user's own account) — same REST pattern as your-career-mentor's
// voice.service.ts: Basic auth, username "apikey", no IAM exchange, voice
// fallback retry on 400/404. Falls back to macOS `say` (ported from
// agentic-chat/voice/tts.py's SaySpeaker) only when Watson TTS isn't
// configured or the API call fails, so voice chat still works out of the box.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { log } = require('./log');

const TTS_KEY = process.env.WATSON_TTS_APIKEY;
const TTS_URL = process.env.WATSON_TTS_URL;
const DEFAULT_TTS_VOICE = process.env.WATSON_TTS_VOICE || 'en-US_MichaelExpressive';
const TTS_FALLBACK_VOICE = 'en-US_MichaelV3Voice';

const VOICE_PREFERENCES = [
  'Ava (Premium)', 'Ava (Enhanced)', 'Zoe (Premium)', 'Zoe (Enhanced)',
  'Evan (Premium)', 'Evan (Enhanced)', 'Samantha', 'Alex', 'Daniel', 'Karen',
];

let cachedVoice = null;
let currentProc = null;
let currentWs = null; // the in-flight TTS WebSocket, if any — so stop() can close it, not just the player
let forceLocal = false; // the "use local voice" toggle, set by main.js's tray menu
let watsonVoice = DEFAULT_TTS_VOICE;

function setWatsonVoice(value) {
  if (typeof value === 'string' && value.trim()) watsonVoice = value.trim();
}

function setForceLocal(value) {
  forceLocal = !!value;
}

function ttsEnabled() {
  return !forceLocal && !!(TTS_KEY && TTS_URL);
}

function basicAuth() {
  return 'Basic ' + Buffer.from(`apikey:${TTS_KEY}`).toString('base64');
}

async function synthesizeWith(text, voice) {
  const url = `${TTS_URL.replace(/\/$/, '')}/v1/synthesize?voice=${encodeURIComponent(voice)}`;
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/json', Accept: 'audio/mp3' },
    body: JSON.stringify({ text }),
  });
}

async function synthesizeRest(text) {
  let res = await synthesizeWith(text, watsonVoice);
  if (!res.ok && (res.status === 404 || res.status === 400) && watsonVoice !== TTS_FALLBACK_VOICE) {
    res = await synthesizeWith(text, TTS_FALLBACK_VOICE);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Watson TTS returned ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Streams audio straight from the WebSocket into `ffplay`'s stdin as chunks
 * arrive, instead of buffering the whole response before playback starts.
 * `afplay` (used everywhere else here) only takes a file path — no stdin
 * support — so this is the one place that needs a different player.
 * Resolves once playback actually finishes (ffplay exits), matching the same
 * contract as playBuffer(), with the same first-chunk/total timing metrics
 * the buffered version used to report.
 */
function playWebSocketStream(text, voice) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let firstChunkAt = null;
    let receivedAny = false;
    let settled = false;

    let player;
    try {
      player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-'], {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    currentProc = player;

    const wsUrl = `${TTS_URL.replace(/^https:/, 'wss:').replace(/\/$/, '')}/v1/synthesize?voice=${encodeURIComponent(voice)}`;
    const ws = new WebSocket(wsUrl, { headers: { Authorization: basicAuth() } });
    currentWs = ws;

    const cleanup = () => {
      if (currentProc === player) currentProc = null;
      if (currentWs === ws) currentWs = null;
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* best effort */ }
      try { player.kill(); } catch { /* best effort */ }
      cleanup();
      reject(error);
    };

    player.on('error', fail); // e.g. ffplay missing on this machine (ENOENT)
    player.on('exit', () => {
      cleanup();
      if (settled) return;
      settled = true;
      if (!receivedAny) {
        reject(new Error('Watson TTS WebSocket returned no audio'));
        return;
      }
      resolve({
        firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null,
        totalMs: Date.now() - startedAt,
      });
    });

    ws.on('open', () => ws.send(JSON.stringify({ text, accept: 'audio/mp3' })));
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          if (message.error) fail(new Error(`Watson TTS WebSocket: ${message.error}`));
        } catch {
          // Non-JSON text messages are warnings; audio continues normally.
        }
        return;
      }
      if (firstChunkAt === null) firstChunkAt = Date.now();
      receivedAny = true;
      try {
        player.stdin.write(Buffer.from(data));
      } catch {
        // Player already exited (e.g. killed by a barge-in) — nothing to write to.
      }
    });
    ws.on('close', () => {
      // Audio's all sent; ffplay finishes draining its stdin buffer and its
      // own 'exit' event (above) is what actually resolves/rejects this.
      try { player.stdin.end(); } catch { /* already closed */ }
    });
    ws.on('error', fail);
  });
}

/** Play an MP3 buffer via `afplay` (built into macOS), tracked like a spoken line. */
function playBuffer(mp3) {
  const file = path.join(os.tmpdir(), `capy-mascot-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
  fs.writeFileSync(file, mp3);
  const proc = spawn('afplay', [file], { stdio: 'ignore' });
  currentProc = proc;
  return new Promise((resolve) => {
    proc.on('exit', () => {
      if (currentProc === proc) currentProc = null;
      fs.unlink(file, () => {});
      resolve();
    });
  });
}

function availableVoices() {
  try {
    const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
    const voices = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^(.+?)\s{2,}[a-z]{2}[_-][A-Z]{2}/);
      if (m) voices.add(m[1].trim());
    }
    return voices;
  } catch {
    return new Set();
  }
}

function pickVoice() {
  if (cachedVoice !== null) return cachedVoice;
  const installed = availableVoices();
  for (const candidate of VOICE_PREFERENCES) {
    if (installed.has(candidate)) { cachedVoice = candidate; return cachedVoice; }
  }
  cachedVoice = ''; // fall back to system default
  return cachedVoice;
}

function speakWithSay(text, rate) {
  const voice = pickVoice();
  const args = ['-r', String(rate)];
  if (voice) args.push('-v', voice);
  const proc = spawn('say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
  currentProc = proc;
  proc.stdin.write(text);
  proc.stdin.end();
  return new Promise((resolve) => {
    proc.on('exit', () => {
      if (currentProc === proc) currentProc = null;
      resolve();
    });
  });
}

// Returns a promise that resolves once the line has finished being spoken
// (or immediately if there was nothing to say), so callers can wait for
// "done speaking" before changing visuals/state.
async function speak(text, { rate = 190 } = {}) {
  if (!text || !text.trim()) return;
  stop(); // barge-in: a new line cuts off whatever's still being said

  if (ttsEnabled()) {
    try {
      const result = await playWebSocketStream(text, watsonVoice);
      log(`[metrics] tts.websocket_first_chunk_ms=${result.firstChunkMs} tts.websocket_total_ms=${result.totalMs}`);
      return;
    } catch (err) {
      log(`[voice] Watson TTS streaming failed, trying REST fallback: ${err.message}`);
    }
    try {
      const mp3 = await synthesizeRest(text);
      await playBuffer(mp3);
      return;
    } catch (err) {
      log(`[voice] Watson TTS REST failed, falling back to say: ${err.message}`);
    }
  }
  await speakWithSay(text, rate);
}

function stop() {
  if (currentWs) { try { currentWs.close(); } catch { /* */ } currentWs = null; }
  if (currentProc) { try { currentProc.kill(); } catch { /* */ } currentProc = null; }
}

// Short, distinct, non-speech cues for mic open/close — audible feedback that
// doesn't depend on the user looking at the floating window, and doesn't
// compete with the halo/dots visuals for "am I actually being heard right
// now." Built-in macOS sounds, so this needs no audio asset of its own.
function chime(name) {
  try {
    spawn('afplay', [`/System/Library/Sounds/${name}.aiff`], { stdio: 'ignore' });
  } catch {
    /* best-effort — a missing chime shouldn't break voice chat */
  }
}

module.exports = { speak, stop, pickVoice, ttsEnabled, chime, setForceLocal, setWatsonVoice };
