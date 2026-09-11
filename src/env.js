// Zero-dependency .env loader — just enough for local dev secrets.
const fs = require('node:fs');
const path = require('node:path');

const envPaths = [
  path.join(__dirname, '..', '.env'),
  process.env.CAPY_MASCOT_ENV_PATH,
  process.env.HOME && path.join(process.env.HOME, 'Library', 'Application Support', 'capy-mascot', '.env'),
].filter(Boolean);

for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
