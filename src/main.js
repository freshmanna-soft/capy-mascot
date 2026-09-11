require('./env');
const { app, BrowserWindow, screen, ipcMain, globalShortcut, Tray, Menu, nativeImage, session, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const voice = require('./voice');
const stt = require('./stt');
const sttLocal = require('./stt-local');
const chat = require('./chat');
const bridgeEvents = require('./bridge-events');
const bridgeTools = require('./bridge-tools');
const { isGoodbye } = require('./transcript-filter');

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8791/status';
const BRIDGE_ORIGIN = BRIDGE_URL.replace(/\/status$/, '');
const ASSERT_ON_TOP_MS = 3000; // unrelated to the bridge connection — just the always-on-top reassertion cadence
const WIDTH = 260;
const HEIGHT = 340; // canvas (260) + a real caption bar below it, see index.html
const CHAT_HOTKEY = 'CommandOrControl+Shift+Space';
// A backstop, not a conversation policy. This was 3, which meant every real
// back-and-forth hit it and got told to press the shortcut again — the cap was
// doing the ending, rather than the user. A conversation now ends when the user
// says so (isGoodbye) or when nobody is there (consecutive silent turns); this
// number exists only so a stuck re-arm loop can't cycle the mic forever
// unattended, and shouldn't be reachable in normal use.
const MAX_CONVERSATION_TURNS = 25;
// How many turns in a row can come back with nothing before we conclude nobody
// is there. One is far too few: a single quiet or misheard turn is normal, and
// treating it as the end of the conversation is what made this feel brittle.
const MAX_SILENT_TURNS = 2;
// Streamed reply text is pushed to the caption at most this often. A token-rate
// IPC + relayout storm buys nothing an eye can see.
const CAPTION_STREAM_THROTTLE_MS = 60;
// Only used to pace the caption's scroll while a reply is spoken. ~2.9 words/sec
// matches both the Watson voice and `say -r 190`. Deliberately just an estimate:
// voice.speak() resolving is what actually ends the crawl, so running a little
// fast or slow costs nothing.
const SPEECH_WORDS_PER_SECOND = 2.9;
const MIN_CRAWL_MS = 1200;
const DEFAULT_SETTINGS = {
  useLocalVoice: false, useLocalLLM: false, alwaysOnTop: true, launchAtLogin: false, windowX: null, windowY: null,
  avatarX: 0, avatarY: 0, avatarZ: 0, outfit: 'none', defaultMood: 'neutral', workHelmet: true,
  watsonVoice: 'en-US_MichaelExpressive',
};
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const { log: diagnosticLog } = require('./log');

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(next) {
  const settings = { ...DEFAULT_SETTINGS, ...next };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return settings;
}

// FSM state -> { visual pose, mood, a short status label, spoken/captioned
// line on the FIRST tick we see it }. Build-lifecycle only, per the agreed v1
// scope — no per-persona-vote or per-repair-attempt granularity.
// `working: true` layers a small animated "typing indicator" overlay on top
// of the capybara's own idle pose (drawn in renderer-entry.ts, not inside the
// reused CapybaraRenderer itself) — its built-in `scanning` pose brings a
// camera/scan-box visual from the clerk feature's barcode-scanning context,
// which reads as wrong here ("the AI is writing code", not "scanning an
// item"). Extending the 1800-line renderer with a real new pose would be
// correct but slow; this overlay approach is fast and keeps the reused file
// untouched.
//
// `label` is what actually answers "what is it doing right now" — a pose or
// a halo is a vibe, not information. It's shown in the caption bar; `say` (if
// set) is spoken AND shown as the caption's body text, so the reasoning is
// readable as well as audible.
const STATE_MAP = {
  idle: { visual: 'idle', mood: 'neutral', label: '' },
  RESOLVING: { visual: 'idle', mood: 'neutral', working: true, label: 'Starting', say: 'Starting a new build.' },
  BUILDING: { visual: 'idle', mood: 'neutral', working: true, label: 'Building' },
  PUSHING: { visual: 'idle', mood: 'neutral', working: true, label: 'Pushing' },
  REPAIRING: { visual: 'confused', mood: 'unsure', working: true, label: 'Repairing', say: 'Gate pushed back — trying a fix.' },
  REVIEWING: { visual: 'listening', mood: 'neutral', label: 'Reviewing', say: 'Running the review quorum.' },
  AWAITING_APPROVAL: { visual: 'found', mood: 'happy', label: 'Awaiting approval', say: 'Quorum passed. Pull request is up.' },
  CHANGES_REQUESTED: { visual: 'confused', mood: 'unsure', working: true, label: 'Iterating', say: 'Changes requested — iterating.' },
  MERGING: { visual: 'found', mood: 'happy', label: 'Merging', say: 'Merge queued.' },
  GATE_FAILED: { visual: 'confused', mood: 'sorry', label: 'Gate failed', say: 'The gate failed. Might need you.' },
  ERROR: { visual: 'confused', mood: 'alert', label: 'Error', say: 'Something went wrong.' },
  STOPPED: { visual: 'idle', mood: 'neutral', label: '' },
  WORKTREE_FAILED: { visual: 'confused', mood: 'alert', label: 'Worktree failed', say: 'Could not set up a worktree.' },
};

// One place that owns the caption bar's content, so every call site (bridge
// states and voice chat alike) speaks the same shape of message.
function sendCaption(label, text) {
  win?.webContents.send('mascot:caption', { label, text: text || '' });
}

let win = null;
let lastKey = null; // dedupe: only react (and speak) on an actual transition
let lastStatus = null; // most recent /status body, for the chat's bridge-summary context
let chatActive = false; // true from hotkey-toggle-on until the chat reply has finished speaking

function resolveKey(status) {
  // Prefer the bridge's terminal/coarse state over a stale granular phase. The
  // bridge can finish a job with `fsm: REVIEWING` still in its last event while
  // the authoritative payload already says `state: idle`.
  const state = String(status.state || '').toLowerCase();
  const phase = String(status.phase || '').toLowerCase();
  if (state === 'idle' || phase === 'idle' || status.endedAt) {
    if (status.passed === true) return 'AWAITING_APPROVAL';
    if (status.passed === false) return 'GATE_FAILED';
    return 'idle';
  }
  return status.fsm || status.state || 'idle';
}

function sendVisualForKey(key) {
  const mapped = STATE_MAP[key] || { visual: 'idle', mood: 'neutral', label: '' };
  win?.webContents.send('mascot:state', { visual: mapped.visual, mood: mapped.mood, working: !!mapped.working });
  sendCaption(mapped.label, mapped.say);
  return mapped;
}

function bridgeStatusSummary() {
  if (!lastStatus) return 'unreachable — nothing known';
  const key = resolveKey(lastStatus);
  const bits = [key];
  if (lastStatus.branch) bits.push(`branch ${lastStatus.branch}`);
  if (lastStatus.request) bits.push(`request: ${lastStatus.request.slice(0, 120)}`);
  if (lastStatus.prUrl) bits.push(`PR: ${lastStatus.prUrl}`);
  if (lastStatus.elapsedSec) bits.push(`elapsed: ${lastStatus.elapsedSec}s`);
  if (lastStatus.errors > 0) bits.push(`errors: ${lastStatus.errors}`);
  if (lastStatus.flaky) bits.push('flaky: yes');
  if (lastStatus.model) bits.push(`model: ${lastStatus.model}`);
  return bits.join(', ');
}

// Driven by bridge-events.js's SSE connection now, not a poll timer — the
// dev-bridge pushes a full status payload the instant anything changes
// (same publicStatus() shape either way), so this fires immediately instead
// of however late the next poll tick would have been. Body unchanged from
// the old poll()'s success path.
function handleBridgeStatus(status) {
  lastStatus = status;
  const key = resolveKey(status);
  if (key !== lastKey) {
    lastKey = key;
    // Don't let a routine update stomp the mascot's visual mid-conversation;
    // lastKey still advances above so the post-chat resume step stays accurate.
    if (chatActive) return;
    const mapped = sendVisualForKey(key);
    if (mapped.say) voice.speak(mapped.say);
  }
}

// Fires on initial connect failure or any drop — bridge-events.js is already
// reconnecting with backoff underneath, this just reflects "unreachable"
// while it does. Body unchanged from the old poll()'s catch branch.
function handleBridgeUnreachable() {
  lastStatus = null;
  if (lastKey !== 'unreachable') {
    lastKey = 'unreachable';
    if (!chatActive) {
      win?.webContents.send('mascot:state', { visual: 'idle', mood: 'neutral' });
      sendCaption('', '');
    }
  }
}

let isListening = false;
let chatSession = null; // the active stt.createStreamingSession(), while listening
let conversationTurns = 0;
let consecutiveSilentTurns = 0; // turns in a row that produced no transcript
let heardSpeechThisTurn = false; // did the renderer's VAD hear real speech this turn
let apologized = false; // "Say that again?" is said at most once per conversation
let listeningStartedAt = 0;
let settings = readSettings();
let useLocalVoice = settings.useLocalVoice; // whisper.cpp + macOS `say` instead of Watson
let useLocalLLM = settings.useLocalLLM; // local Ollama model instead of the Anthropic proxy

function endChat() {
  isListening = false;
  chatActive = false;
  chatSession = null;
  conversationTurns = 0;
  consecutiveSilentTurns = 0;
  heardSpeechThisTurn = false;
  apologized = false;
  listeningStartedAt = 0;
  // A staged trigger_build/create_github_issue must not outlive the
  // conversation it was staged in — otherwise an unrelated "yes" in a LATER
  // conversation could confirm it. (bridge-tools also ages it out on its own
  // TTL; this closes the window deterministically at the point the user
  // actually walked away.)
  bridgeTools.clearPending();
  sendVisualForKey(lastKey || 'idle'); // resume whatever the bridge is actually doing
}

// Opens the mic. Called on the hotkey's first press, AND automatically again
// after each reply finishes speaking — that second case is the actual fix
// for "feels like a keyboard conversation": without it, every follow-up turn
// needed a press to start listening AND a press to stop, when only the
// "I'm done talking" press is actually necessary once a conversation is
// already underway.
async function startListening() {
  chatActive = true;
  isListening = true;
  // Cleared per turn so a stale "we heard speech" from the previous turn can
  // never trigger an apology on this one. False is the safe default: it means
  // "say nothing, just listen again".
  heardSpeechThisTurn = false;
  // Not "listening" yet — the mic isn't actually open until getUserMedia
  // resolves (mascot:mic-opened, below). Showing the listening halo before
  // that would be a lie: dots-on-idle here means "setting up," same visual
  // language as a build starting.
  win?.webContents.send('mascot:state', { visual: 'idle', mood: 'neutral', working: true });
  sendCaption('Setting up', '');
  listeningStartedAt = Date.now();

  const sttReady = useLocalVoice ? sttLocal.enabled() : stt.enabled();
  if (!sttReady || !chat.enabled()) {
    const what = useLocalVoice ? 'whisper-cli/model' : 'Watson API key';
    sendCaption('Not configured', `Voice chat isn't set up — missing ${what}.`);
    await voice.speak("Voice chat isn't set up yet.");
    endChat();
    return;
  }
  let session;
  try {
    session = useLocalVoice
      ? // Local mode: whisper.cpp has no live API, no partials, no server-side
        // inactivity timeout — the renderer's own VAD is what ends the turn.
        await sttLocal.createLocalSession()
      : await stt.createStreamingSession(
          (partial) => sendCaption('Listening', partial),
          // Fires if Watson closes the connection on its own (inactivity
          // timeout, most likely) — nobody pressed anything. This is the actual
          // "end without pressing anything" mechanism: react to Watson deciding
          // the silence has gone on long enough, rather than requiring a press
          // just to leave.
          (transcript) => {
            if (chatSession !== session) return; // a manual stop already claimed this turn
            chatSession = null;
            win?.webContents.send('mascot:record-control', 'stop'); // renderer's mic is still open locally
            showThinking();
            finishTurn(transcript);
          }
        );
  } catch (err) {
    diagnosticLog(`[stt] ${err.message}`);
    sendCaption('Error', 'Something went wrong starting voice chat.');
    await voice.speak('Something went wrong starting voice chat.');
    endChat();
    return;
  }
  chatSession = session;
  diagnosticLog(`[metrics] stt.ready_ms=${Date.now() - listeningStartedAt}`);
  // Focus the window before asking for the mic so macOS TCC sees a foreground
  // window when getUserMedia fires — required for the permission prompt to
  // appear on LSUIElement (background agent) apps.
  win?.show();
  win?.focus();
  win?.webContents.send('mascot:record-control', 'start');
}

function stopListening() {
  // No chime here — the renderer's own stopRecording() fires mic-closing
  // (below) at the exact moment it actually stops, regardless of whether a
  // keypress, local voice-activity detection, or Watson's inactivity timeout
  // triggered it. One accurate signal instead of guessing at each call site.
  win?.webContents.send('mascot:record-control', 'stop');
}

function toggleChat() {
  if (isListening) stopListening();
  else startListening();
}

// Fires the instant a turn is known to be over — before any of the slow,
// network-bound work (STT finalizing, the chat call) — so there's no dead
// gap between the mic closing and *something* visibly happening. Previously
// this same state/caption was set at the top of finishTurn(), which only ran
// after `await session.finish()` resolved; since finish() means waiting on
// Watson to actually close the WebSocket, that could be a very visible delay
// with zero feedback. Now every call site fires this synchronously first,
// then does its awaited work — one deterministic place that owns the
// listening→thinking transition, instead of it being an accidental side
// effect of how fast the network happened to respond.
function showThinking() {
  win?.webContents.send('mascot:state', { visual: 'idle', mood: 'neutral', working: true });
  sendCaption('Thinking', '');
}

// Rough spoken duration of a line, used only to pace the caption's scroll.
function estimateSpeechMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(MIN_CRAWL_MS, Math.round((words / SPEECH_WORDS_PER_SECOND) * 1000));
}

// A turn that produced no transcript. This used to END the conversation — with
// "Talk to you later." if anything had happened yet, and "Sorry, I didn't catch
// that." if not — on the very first empty turn. Both halves were wrong. An
// empty turn usually just means the mic caught nothing this time, which is
// worth another go rather than a goodbye, and definitely not worth an apology
// every single time. Now it re-arms quietly, and only leaves once silence has
// actually repeated.
async function handleEmptyTurn() {
  consecutiveSilentTurns += 1;
  if (consecutiveSilentTurns >= MAX_SILENT_TURNS) {
    // Repeated silence does read as "nobody's there" — leave the same graceful
    // way an explicit goodbye would.
    diagnosticLog(`[chat] ending on ${consecutiveSilentTurns} silent turns`);
    sendCaption('', '');
    await voice.speak('Talk to you later.');
    endChat();
    return;
  }
  // Worth saying out loud ONLY when the mic genuinely heard speech and the
  // transcript still came back empty — i.e. "you said something and I couldn't
  // make it out". When nothing was heard at all there is nothing to apologise
  // for, and repeating it every turn is what made it grating, so it's capped at
  // once per conversation.
  if (heardSpeechThisTurn && !apologized) {
    apologized = true;
    sendCaption('Say that again?', '');
    await voice.speak('Say that again?');
  } else {
    sendCaption('Still listening', '');
  }
  await startListening();
}

// Shared by both ways a turn can end: the user pressing the hotkey (which
// calls session.finish() then this), and Watson closing the session on its
// own via inactivity (stt.js's onEnded, above). Same handling either way —
// reply and re-arm on real speech, tolerate a quiet turn, and leave on an
// explicit goodbye or on repeated silence.
// Callers are responsible for calling showThinking() before the slow work
// that produces `transcript` — this function only handles the result.
async function finishTurn(transcript, metrics = {}) {
  try {
    if (!transcript) {
      await handleEmptyTurn();
      return;
    }
    consecutiveSilentTurns = 0; // a real turn clears the silence streak

    // An explicit spoken goodbye ends things right here, before the model is
    // called at all. The user's own sign-off is not something a model needs to
    // weigh in on, and short-circuiting it also skips a pointless API round
    // trip. Detection is deliberately a deterministic keyword match — see
    // isGoodbye() in transcript-filter.js.
    if (isGoodbye(transcript)) {
      diagnosticLog(`[chat] goodbye: "${transcript}"`);
      sendCaption('', `You said: "${transcript}"`);
      await voice.speak('Talk to you later.');
      endChat();
      return;
    }

    sendCaption('Thinking', `You said: "${transcript}"`);
    // Per-stage timing so a slow/inaccurate turn can actually be diagnosed
    // instead of guessed at — see [timing] lines in the log.
    let t = Date.now();

    // The reply is streamed into the caption as the model writes it, rather
    // than appearing all at once once the turn is already over. `onText` gets
    // the accumulated text of the current round (same contract as Watson's
    // partial transcripts), so this stays a plain "set the caption" call and
    // a new round's text simply replaces the previous round's aside.
    let lastCaptionAt = 0;
    let flippedToSpeaking = false;
    const onText = (textSoFar) => {
      if (!flippedToSpeaking) {
        flippedToSpeaking = true;
        // Change pose as soon as words exist, not after the whole reply lands.
        win?.webContents.send('mascot:state', { visual: 'speaking', mood: 'happy', working: false });
      }
      const now = Date.now();
      if (now - lastCaptionAt < CAPTION_STREAM_THROTTLE_MS) return;
      lastCaptionAt = now;
      sendCaption('Responding', textSoFar);
    };

    const replyText = await chat.reply(transcript, bridgeStatusSummary(), onText);
    const chatMs = Date.now() - t;
    diagnosticLog(`[metrics] chat_ms=${chatMs} backend=${useLocalLLM ? 'ollama' : 'anthropic'}`);
    win?.webContents.send('mascot:state', { visual: 'speaking', mood: 'happy', working: false });
    // The authoritative final text: the throttle above can legitimately drop
    // the last streamed chunk, so this is what guarantees the caption ends up
    // showing exactly what gets spoken.
    sendCaption('Responding', replyText);
    t = Date.now();
    // Scroll the caption through the reply at roughly speaking pace, so a reply
    // longer than the visible box can be read along with the voice instead of
    // stranding its later lines out of view.
    win?.webContents.send('mascot:caption-crawl', { durationMs: estimateSpeechMs(replyText) });
    await voice.speak(replyText);
    win?.webContents.send('mascot:caption-crawl-end'); // speech is over: rest on the last line
    const ttsMs = Date.now() - t;
    conversationTurns += 1;
    const totalMs = metrics.startedAt ? Date.now() - metrics.startedAt : null;
    diagnosticLog(`[metrics] tts_ms=${ttsMs} turn=${conversationTurns} total_ms=${totalMs ?? 'unknown'} stt_ms=${metrics.sttMs ?? 'unknown'}`);
    if (conversationTurns >= MAX_CONVERSATION_TURNS) {
      // The unattended-loop backstop, not a normal stopping point.
      sendCaption('Paused', 'Long conversation — press the shortcut to keep going.');
      await voice.speak("I'll wait here. Press the shortcut when you want to continue.");
      endChat();
      return;
    }
    await startListening();
  } catch (err) {
    sendCaption('Error', 'Something went wrong with voice chat.');
    await voice.speak('Something went wrong with voice chat.');
    diagnosticLog(`[chat] ${err.message}`);
    endChat();
  }
}

// Fires once getUserMedia has actually resolved and recording has started —
// only now is the mic genuinely open, so only now does the listening halo
// (and its chime) appear.
ipcMain.on('mascot:mic-opened', () => {
  diagnosticLog('[mic] renderer reported microphone opened');
  voice.chime('Tink');
  win?.webContents.send('mascot:state', { visual: 'listening', mood: 'neutral', working: false });
  sendCaption('Listening', '');
});

// Fires the instant the renderer's stopRecording() actually runs — whether
// that came from a keypress, local voice-activity detection deciding the
// user is done talking, or (via the record-control it was sent) Watson's own
// inactivity timeout. Single accurate "mic just closed" signal either way.
ipcMain.on('mascot:mic-closing', (_e, spoke) => {
  // `spoke` is the renderer's VAD verdict for this turn. It's the difference
  // between "nothing was ever said" (nothing to apologise for) and "you were
  // heard but the transcript came back empty" (worth one "say that again?").
  heardSpeechThisTurn = !!spoke;
  diagnosticLog(`[mic] renderer reported microphone closing spoke=${!!spoke}`);
  voice.chime('Pop');
  // This is the actual earliest point a turn is known to be ending — it fires
  // synchronously the moment stopRecording() runs, before MediaRecorder's own
  // async flush (which delays its 'onstop' event, which is what the
  // mascot:audio-end round trip was waiting behind) even starts. Firing here
  // instead of in the audio-end handler is what closes the remaining gap.
  showThinking();
});

// The renderer calibrated its own noise floor for this recording — logged so
// it's actually verifiable (e.g. after moving to a noisier room) instead of
// just trusted to be working.
ipcMain.on('mascot:vad-calibration', (_e, threshold) => {
  diagnosticLog(`[mic] VAD calibrated threshold=${Number(threshold).toFixed(4)}`);
});

// Permission denied, no device, etc. — the old code just hung silently in
// the listening pose forever. Now it says so and resets.
ipcMain.on('mascot:mic-error', async () => {
  diagnosticLog('[mic] renderer reported microphone error');
  sendCaption('Error', "Couldn't access the microphone.");
  await voice.speak("I couldn't get access to the microphone.");
  endChat();
});

// Each chunk is forwarded to Watson as it's captured — this is the actual
// latency win over the old batch upload (see stt.js).
let audioChunkCount = 0;
ipcMain.on('mascot:audio-chunk', (_e, buffer) => {
  audioChunkCount += 1;
  if (audioChunkCount === 1 || audioChunkCount % 20 === 0) {
    diagnosticLog(`[mic] audio chunk count=${audioChunkCount} bytes=${buffer.byteLength}`);
  }
  chatSession?.send(Buffer.from(buffer));
});

// The renderer calls this once its MediaRecorder has flushed its last chunk,
// so we don't send Watson's "stop" action while audio is still in flight.
ipcMain.handle('mascot:audio-end', async () => {
  const session = chatSession;
  chatSession = null;
  if (!session) return;
  showThinking(); // fire immediately — session.finish() below is a network round trip
  const transcript = (await session.finish()).trim();
  await finishTurn(transcript, {
    startedAt: listeningStartedAt,
    sttMs: listeningStartedAt ? Date.now() - listeningStartedAt : null,
  });
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('mic:request', async () => {
  if (process.platform !== 'darwin') {
    diagnosticLog('[mic] permission request skipped: non-macOS');
    return true;
  }
  const status = systemPreferences.getMediaAccessStatus('microphone');
  diagnosticLog(`[mic] permission status before renderer request=${status}`);
  if (status === 'granted') return true;
  if (status === 'denied') return false; // must be re-enabled in System Settings
  // 'not-determined' — trigger the system prompt now
  const granted = await systemPreferences.askForMediaAccess('microphone');
  diagnosticLog(`[mic] askForMediaAccess result=${granted}`);
  return granted;
});
ipcMain.on('mic:open-settings', () => {
  if (process.platform === 'darwin') {
    require('node:child_process').execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone']);
  }
});
ipcMain.handle('settings:set', (_event, patch) => {
  settings = writeSettings({ ...settings, ...patch });
  if (typeof patch.useLocalVoice === 'boolean') {
    useLocalVoice = patch.useLocalVoice;
    voice.setForceLocal(useLocalVoice);
  }
  if (typeof patch.useLocalLLM === 'boolean') {
    useLocalLLM = patch.useLocalLLM;
    chat.setUseLocal(useLocalLLM);
  }
  if (typeof patch.alwaysOnTop === 'boolean') {
    win?.setAlwaysOnTop(patch.alwaysOnTop, 'floating');
  }
  if (typeof patch.launchAtLogin === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
  }
  if (typeof patch.watsonVoice === 'string') voice.setWatsonVoice(patch.watsonVoice);
  win?.webContents.send('mascot:settings', settings);
  return settings;
});

// `floating` can still get quietly demoted behind another app's window after
// focus changes (clicking another app, a permission dialog, the tray menu
// closing) — macOS doesn't guarantee it stays enforced, it's just the initial
// request. Re-asserting it defensively (on blur, and on a timer) is the only
// reliable fix short of `screen-saver` level, which outranks far more than
// this widget should.
function assertOnTop() {
  win?.setAlwaysOnTop(true, 'floating');
  win?.moveTop();
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const savedPosition = Number.isFinite(settings.windowX) && Number.isFinite(settings.windowY)
    ? { x: settings.windowX, y: settings.windowY }
    : { x: width - WIDTH - 24, y: height - HEIGHT - 24 };
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: savedPosition.x,
    y: savedPosition.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('blur', assertOnTop);
  win.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('[mic]')) diagnosticLog(`[renderer] ${message}`);
  });
  win.on('move', () => {
    clearTimeout(win.positionSaveTimer);
    win.positionSaveTimer = setTimeout(() => {
      const [windowX, windowY] = win.getPosition();
      settings = writeSettings({ ...settings, windowX, windowY });
    }, 250);
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

let tray = null;
let settingsWin = null;

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 460,
    height: 430,
    title: 'Capy Mascot Settings',
    resizable: false,
    backgroundColor: '#17110f',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadFile(path.join(__dirname, '..', 'settings.html'));
}

// A menu bar item so restarting (to pick up an edited .env, or a code change)
// doesn't require reaching for a terminal — right now that's the only way to
// pick up either, so this is the fast, no-asset way to get a real menu-bar
// presence: a 1x1 transparent icon plus setTitle for the visible emoji, no
// custom art needed.
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
  icon.setTemplateImage(true); // adapts to light/dark menu bar automatically
  tray = new Tray(icon);
  tray.setToolTip('Capy Mascot');
  // No tray.on('click', ...) — a bare click on the icon was opening Settings
  // on its own, on top of the context menu's own "Settings..." item doing
  // the same thing. The context menu (below) is the only intended trigger.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings...', click: createSettingsWindow },
      { type: 'separator' },
      {
        label: 'Use Local Voice (offline)',
        type: 'checkbox',
        checked: useLocalVoice,
        // Live toggle — no restart needed. Switches whisper.cpp/`say` in for
        // Watson on the NEXT time the mic opens; doesn't interrupt whatever's
        // already in flight. Persisted through the same settings.json as the
        // settings:set IPC, so this and any settings UI stay in sync.
        click: (item) => {
          useLocalVoice = item.checked;
          voice.setForceLocal(useLocalVoice);
          settings = writeSettings({ ...settings, useLocalVoice });
        },
      },
      { type: 'separator' },
      { label: 'Restart', click: () => { app.relaunch(); app.exit(0); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'microphone');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => (
    permission === 'media' || permission === 'microphone'
  ));
  if (process.platform === 'darwin') {
    diagnosticLog(`[mic] startup permission status=${systemPreferences.getMediaAccessStatus('microphone')}`);
  }
  if (process.platform === 'darwin') app.dock.hide();
  voice.setForceLocal(useLocalVoice);
  voice.setWatsonVoice(settings.watsonVoice);
  chat.setUseLocal(useLocalLLM);
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  createWindow();
  createTray();
  bridgeEvents.connect(BRIDGE_ORIGIN, { onStatus: handleBridgeStatus, onUnreachable: handleBridgeUnreachable });
  setInterval(assertOnTop, ASSERT_ON_TOP_MS);
  globalShortcut.register(CHAT_HOTKEY, toggleChat);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());

// Let the renderer's own click-to-drag (see index.html) work despite `frame:false`.
ipcMain.on('mascot:quit', () => app.quit());
ipcMain.on('mascot:restart', () => { app.relaunch(); app.exit(0); });
