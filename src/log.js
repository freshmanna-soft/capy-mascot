// Shared diagnostic logger. A packaged .app has no terminal attached, so
// plain console.log()/console.error() calls in the main process go nowhere
// visible — they need to be written to a real file to be seen at all. This
// is that file, shared by every module (voice, chat, stt, main) so a full
// latency/error trace survives outside dev mode, not just in `electron .`.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// `app.getPath` needs a real Electron main-process context — falls back to
// console-only (no file) when required under plain `node`, e.g. a manual
// smoke test of a module that happens to pull this in transitively.
const LOG_PATH = app
  ? path.join(app.getPath('logs'), 'capy-mascot.log')
  : path.join(os.tmpdir(), 'capy-mascot-standalone.log');

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    // Diagnostics must never affect the mascot.
  }
}

module.exports = { log, LOG_PATH };
