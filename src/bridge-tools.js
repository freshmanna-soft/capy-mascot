// Tools against the dev-bridge, shared by both chat backends (chat.js's
// Anthropic call and chat-local.js's Ollama call) — each API wants a
// differently-shaped tool schema, but the underlying definitions and
// executors are identical either way, so this is the one place they're
// defined and each caller adapts the shape it needs.
//
// Read-only tools execute immediately. The two write actions
// (trigger_build, create_github_issue) do NOT — calling them only *stages*
// the action; the model's job is to read back what it's about to do and ask
// the user to confirm out loud. The actual execution is gated by a
// deterministic keyword check on the user's next reply, done in chat.js
// BEFORE the model is even called again — not by trusting the model's own
// judgment about whether the user said yes. A voice pipeline (STT mishears
// are real) is the wrong place to let "start a build" or "file an issue"
// happen on the model's say-so alone.
const { log } = require('./log');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8791/status';
const BRIDGE_ORIGIN = BRIDGE_URL.replace(/\/status$/, '');
const GITHUB_REPO = process.env.MASCOT_GITHUB_REPO || 'freshmanna-soft/capy-pos-public';
const FETCH_TIMEOUT_MS = 4000;
const PENDING_TTL_MS = 90_000; // how long a staged action stays confirmable

async function getJson(path) {
  const res = await fetch(`${BRIDGE_ORIGIN}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

// The one piece of cross-turn state here — what's staged and waiting on a
// confirmation, if anything. Module-level (not per-conversation) is fine:
// this app only ever has one active voice conversation at a time.
let pendingAction = null;

function getPending() {
  if (!pendingAction) return null;
  if (Date.now() - pendingAction.stagedAt > PENDING_TTL_MS) {
    pendingAction = null;
    return null;
  }
  return pendingAction;
}

function clearPending() {
  pendingAction = null;
}

function stage(name, args) {
  pendingAction = { name, args, stagedAt: Date.now() };
  log(`[tool] staged ${name}(${JSON.stringify(args)}) — awaiting user confirmation`);
  return { status: 'confirmation_required', note: 'Not executed yet. Tell the user what this will do and ask them to confirm out loud before it happens.' };
}

// The real actions, only ever called from chat.js's deterministic confirm
// check — never directly by a tool call.
async function executeStaged(name, args) {
  if (name === 'trigger_build') return triggerBuild(args);
  if (name === 'create_github_issue') return createGithubIssue(args);
  return { error: `Unknown staged action: ${name}` };
}

async function triggerBuild({ request }) {
  const res = await fetch(`${BRIDGE_ORIGIN}/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`/build returned ${res.status}: ${detail.slice(0, 200)}`);
  }
  return res.json(); // {status:'queued', mode:'build'}
}

async function createGithubIssue({ title, body }) {
  const { stdout } = await execFileAsync(
    'gh',
    ['issue', 'create', '--repo', GITHUB_REPO, '--title', title, '--body', body || '(filed via Capy voice command)'],
    { timeout: FETCH_TIMEOUT_MS * 2 }
  );
  return { url: stdout.trim() }; // `gh issue create` prints the new issue's URL on success
}

/**
 * name/description/parameters: a plain JSON-Schema tool definition, shaped
 * so it converts trivially to either Anthropic's or OpenAI's tool format
 * (see toAnthropicTools/toOpenAITools, below).
 * execute(args): what actually runs when the model calls this tool. For the
 * read-only tools that's the real dev-bridge call; for the two write
 * actions it's only `stage()` — see the file header.
 */
const TOOLS = [
  {
    name: 'get_bridge_status',
    description: 'Get the dev-bridge\'s current build status: FSM state, branch, and request being worked on right now.',
    parameters: { type: 'object', properties: {} },
    execute: () => getJson('/status'),
  },
  {
    name: 'get_recent_history',
    description: 'Get the outcomes of the last several dev-bridge jobs (what ran, whether it passed).',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const history = await getJson('/history');
      return Array.isArray(history) ? history.slice(-10) : history;
    },
  },
  {
    name: 'get_pending_approvals',
    description: 'List builds currently awaiting human approval — PR, branch, and review verdicts for each.',
    parameters: { type: 'object', properties: {} },
    execute: () => getJson('/pending'),
  },
  {
    name: 'get_git_info',
    description: 'Get the dev-bridge\'s current git state (branch, latest commit, etc).',
    parameters: { type: 'object', properties: {} },
    execute: () => getJson('/git'),
  },
  {
    name: 'get_job_log',
    description: 'Get the tail of a job\'s log. Omit the id for the current/most recent job.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id. Optional — omit for the current/most recent job.' },
      },
    },
    execute: async ({ id } = {}) => {
      const res = await fetch(`${BRIDGE_ORIGIN}/log${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`/log returned ${res.status}`);
      const text = await res.text();
      // A full log is not something to speak aloud or burn context on.
      return { log: text.slice(-2000) };
    },
  },
  {
    name: 'trigger_build',
    description:
      'Stage a request to start a new dev-bridge build (free text describing the work, or "#123" for an existing issue). ' +
      'Does NOT start it — only stages it. You must tell the user exactly what you are about to build and ask them to ' +
      'confirm out loud (e.g. say "yes" or "confirm") before it actually runs.',
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The build request — free text, or "#123" to reference an existing issue.' },
      },
      required: ['request'],
    },
    execute: (args) => stage('trigger_build', args),
  },
  {
    name: 'create_github_issue',
    description:
      `Stage a new GitHub issue in ${GITHUB_REPO} that the dev-bridge can later be asked to build. Does NOT create it — ` +
      'only stages it. You must read back the title and a short summary of the body and ask the user to confirm out ' +
      'loud before it actually gets created.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body/description. Optional.' },
      },
      required: ['title'],
    },
    execute: (args) => stage('create_github_issue', args),
  },
];

async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    log(`[tool] ${name}(${JSON.stringify(args || {})})`);
    return await tool.execute(args || {});
  } catch (err) {
    log(`[tool] ${name} failed: ${err.message}`);
    return { error: err.message };
  }
}

function toAnthropicTools() {
  return TOOLS.map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }));
}

function toOpenAITools() {
  return TOOLS.map(({ name, description, parameters }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
}

module.exports = { runTool, toAnthropicTools, toOpenAITools, getPending, clearPending, executeStaged };
