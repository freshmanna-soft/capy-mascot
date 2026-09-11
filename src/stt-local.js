// Local speech-to-text via whisper.cpp's `whisper-cli`, ported from
// agentic-chat/voice/stt.py's WhisperCppTranscriber — fully offline, nothing
// leaves the machine, and a real comparison point against Watson's cloud STT
// when accuracy or latency is in question.
//
// Same {send, finish} shape as stt.js's Watson session, so main.js can swap
// between them without touching the renderer at all — but this one batches
// rather than streams: whisper.cpp has no live API, so chunks are buffered
// to a temp file and only decoded once finish() is called. That means no
// live partial captions and no server-side inactivity timeout in local mode
// — the renderer's own volume-based VAD is what ends the turn either way.
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { log } = require('./log');
const { cleanTranscript } = require('./transcript-filter');
const path = require('node:path');

const BINARY = 'whisper-cli';
const MODEL_PATH = path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin');
const LANGUAGE = 'en';

class SttLocalError extends Error {}

function enabled() {
  try {
    execFileSync('which', [BINARY], { stdio: 'ignore' });
  } catch {
    return false;
  }
  return fs.existsSync(MODEL_PATH);
}

function transcribeWav(wavPath) {
  const threads = Math.max(4, os.cpus().length - 2);
  const proc = spawnSync(
    BINARY,
    ['-m', MODEL_PATH, '-f', wavPath, '-l', LANGUAGE, '-t', String(threads), '-nt', '-np'],
    { encoding: 'utf8' }
  );
  if (proc.status !== 0) throw new SttLocalError(`whisper-cli failed: ${(proc.stderr || '').slice(-300)}`);
  return cleanTranscript(proc.stdout || '');
}

function createLocalSession() {
  if (!enabled()) return Promise.reject(new SttLocalError('whisper-cli or its model is not installed.'));
  const chunks = [];
  return Promise.resolve({
    send: (buffer) => chunks.push(Buffer.from(buffer)),
    finish: () =>
      new Promise((resolve) => {
        if (chunks.length === 0) return resolve('');
        const webmPath = path.join(os.tmpdir(), `capy-mascot-stt-${Date.now()}.webm`);
        const wavPath = webmPath.replace(/\.webm$/, '.wav');
        fs.writeFileSync(webmPath, Buffer.concat(chunks));
        const ff = spawnSync('ffmpeg', ['-y', '-i', webmPath, '-ar', '16000', '-ac', '1', wavPath], {
          stdio: 'ignore',
        });
        let text = '';
        try {
          if (ff.status === 0) text = transcribeWav(wavPath);
        } catch (err) {
          log(`[stt-local] ${err.message}`);
        } finally {
          fs.unlink(webmPath, () => {});
          fs.unlink(wavPath, () => {});
        }
        resolve(text);
      }),
  });
}

module.exports = { createLocalSession, enabled, SttLocalError };
