import { CapybaraRenderer, ClerkMood, type ClerkVisualState } from '../canvas/capybara-renderer';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

declare global {
  interface Window {
    mascotAPI: {
      onState: (cb: (payload: { visual: ClerkVisualState; mood: string; working: boolean }) => void) => void;
      onCaption: (cb: (payload: { label: string; text: string }) => void) => void;
      onCaptionCrawl: (cb: (payload: { durationMs: number }) => void) => void;
      onCaptionCrawlEnd: (cb: () => void) => void;
      onSettings: (cb: (settings: AvatarSettings) => void) => void;
      onRecordControl: (cb: (action: 'start' | 'stop') => void) => void;
      sendAudioChunk: (buffer: ArrayBuffer) => void;
      endAudio: () => Promise<void>;
      micOpened: () => void;
      micClosing: (spoke: boolean) => void;
      micError: () => void;
      logVadCalibration: (threshold: number) => void;
      quit: () => void;
      showContextMenu: () => void;
      getSettings: () => Promise<AvatarSettings>;
      setSettings: (patch: Partial<AvatarSettings>) => Promise<AvatarSettings>;
      requestMicrophone: () => Promise<boolean>;
      openMicrophoneSettings: () => void;
      restart: () => void;
    };
  }
}

type AvatarSettings = {
  useLocalVoice: boolean; alwaysOnTop: boolean; launchAtLogin: boolean;
  windowX: number | null; windowY: number | null;
  avatarX: number; avatarY: number; avatarZ: number;
  outfit: 'none' | 'work' | 'sun'; defaultMood: string; workHelmet: boolean; watsonVoice: string;
};

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new CapybaraRenderer(canvas);
const ctx = canvas.getContext('2d')!; // same context CapybaraRenderer already owns — drawing after render() layers on top

// Mic permission probe — runs once after the window is visible and focused.
// getUserMedia is the only call that reliably triggers the macOS TCC prompt
// for packaged Electron apps (askForMediaAccess is silently ignored on
// macOS 12+). We do it here, not at module load, because TCC silently
// auto-denies requests made before the window has focus. The 300ms delay
// gives the window time to appear and receive focus before the request fires.
// If already granted or denied, getUserMedia resolves/rejects instantly with
// no dialog — no repeated prompting on every launch.
window.addEventListener('load', () => {
  setTimeout(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop()); // prompt accepted — release immediately
    } catch {
      // denied or no device — startRecording() will handle it properly when the hotkey fires
    }
  }, 300);
});

const threeCanvas = document.getElementById('stage-3d') as HTMLCanvasElement;
const threeRenderer = new THREE.WebGLRenderer({ canvas: threeCanvas, alpha: true, antialias: true });
threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
threeRenderer.setClearColor(0x000000, 0);
const threeScene = new THREE.Scene();
const threeCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
threeCamera.position.set(0, 1.6, 10);
threeCamera.up.set(0, 1, 0);
threeCamera.lookAt(0, 1.6, 0);
const threeRoot = new THREE.Group();
threeRoot.scale.setScalar(0.78);
threeRoot.position.y = 0;
threeScene.add(threeRoot);
const outfitGroup = new THREE.Group();
const helmetGroup = new THREE.Group();
threeRoot.add(outfitGroup, helmetGroup);
const outfitMaterial = new THREE.MeshStandardMaterial({ color: 0x6f91b8, roughness: 0.8 });
const helmetMaterial = new THREE.MeshStandardMaterial({ color: 0xf0b429, roughness: 0.7 });
const shirt = new THREE.Mesh(new THREE.SphereGeometry(0.82, 20, 12), outfitMaterial);
shirt.scale.set(1.05, 0.82, 0.5);
shirt.position.set(0, 1.0, 0.92);
outfitGroup.add(shirt);
const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), helmetMaterial);
helmet.position.set(0, 2.55, 0.0);
const helmetBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.10, 24), helmetMaterial);
helmetBrim.rotation.x = Math.PI / 2;
helmetBrim.position.set(0, 2.48, 0.0);
helmetGroup.add(helmet, helmetBrim);
helmetGroup.visible = false;
threeScene.add(new THREE.HemisphereLight(0xffead5, 0x2a1710, 2.4));
const threeKey = new THREE.DirectionalLight(0xfff1dc, 3.2);
threeKey.position.set(-3, 5, 6);
threeScene.add(threeKey);
let threeReady = false;
const threeClock = new THREE.Clock();

new GLTFLoader().load('assets/capybara.glb', (gltf) => {
  threeRoot.add(gltf.scene);
  document.body.classList.add('three-ready');
  threeReady = true;
}, undefined, (error) => {
  console.warn('[mascot] 3D capybara unavailable; keeping 2D renderer', error);
});

function resizeThree() {
  const width = threeCanvas.clientWidth || 260;
  const height = threeCanvas.clientHeight || 260;
  threeRenderer.setSize(width, height, false);
  const halfHeight = 2;
  const halfWidth = halfHeight * (width / height);
  threeCamera.left = -halfWidth;
  threeCamera.right = halfWidth;
  threeCamera.top = halfHeight;
  threeCamera.bottom = -halfHeight;
  threeCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeThree);
resizeThree();


let working = false;
let avatarSettings: AvatarSettings = {
  useLocalVoice: false, alwaysOnTop: true, launchAtLogin: false, windowX: null, windowY: null,
  avatarX: 0, avatarY: 0, avatarZ: 0, outfit: 'none', defaultMood: 'neutral', workHelmet: true,
  watsonVoice: 'en-US_MichaelExpressive',
};

function applyAvatarSettings(next: AvatarSettings) {
  avatarSettings = next;
  threeRoot.position.x = next.avatarX;
  threeRoot.position.y = next.avatarY;
  threeRoot.position.z = next.avatarZ;
  outfitGroup.visible = next.outfit !== 'none';
  outfitMaterial.color.set(next.outfit === 'sun' ? 0xe5a23a : 0x6f91b8);
  helmetGroup.visible = next.workHelmet && working;
  const moodValue = (ClerkMood as Record<string, string>)[next.defaultMood.toUpperCase()] ?? next.defaultMood;
  renderer.setMood(moodValue as (typeof ClerkMood)[keyof typeof ClerkMood], 0.8);
}

window.mascotAPI.getSettings().then(applyAvatarSettings);
window.mascotAPI.onSettings(applyAvatarSettings);

// A small bouncing-dots "typing indicator", drawn on top of the capybara's
// own idle pose — see main.js's STATE_MAP comment for why this is an overlay
// rather than a real new CapybaraRenderer pose.
function drawWorkingIndicator(now: number) {
  const dpr = window.devicePixelRatio || 1;
  const cx = canvas.width / dpr / 2;
  const baseY = canvas.height / dpr * 0.82;
  const dotSpacing = 16;
  const dotRadius = 4;
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const phase = now / 260 - i * 0.6;
    const bounce = Math.abs(Math.sin(phase)) * 6;
    const x = cx + (i - 1) * dotSpacing;
    const y = baseY - bounce;
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(90, 62, 43, 0.75)'; // warm brown, matches the capybara's own fur tone
    ctx.fill();
  }
  ctx.restore();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  // The canvas's own box, not the window's — the window is now taller than
  // the canvas to fit the caption bar below it (see index.html), and sizing
  // against window.innerHeight would stretch every tuned proportion in
  // capybara-renderer.ts to fill that extra height.
  renderer.resize(canvas.clientWidth, canvas.clientHeight, dpr);
}
window.addEventListener('resize', resize);
resize();

renderer.setState('idle');
renderer.setMood(ClerkMood.NEUTRAL, 1);
renderer.plop(); // entrance bounce so it's obviously "alive" the moment it appears

function loop(now: number) {
  renderer.render(now);
  if (threeReady) {
    const elapsed = threeClock.getElapsedTime();
    threeRoot.position.y = avatarSettings.avatarY + Math.sin(elapsed * 2.1) * 0.035;
    threeRoot.rotation.y = Math.sin(elapsed * 0.7) * 0.08;
    threeRenderer.render(threeScene, threeCamera);
  }
  if (working) drawWorkingIndicator(now);
  checkVoiceActivity(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.mascotAPI.onState(({ visual, mood, working: nextWorking }) => {
  renderer.setState(visual);
  const moodValue = (ClerkMood as Record<string, string>)[mood.toUpperCase()] ?? mood;
  renderer.setMood(moodValue as (typeof ClerkMood)[keyof typeof ClerkMood], 1);
  working = !!nextWorking;
  helmetGroup.visible = avatarSettings.workHelmet && working;
});


// The actual "what is it doing / what did I say / what is it saying" readout
// — see index.html's #caption. A pose communicates a vibe; this is the part
// that's actually legible.
const captionEl = document.getElementById('caption') as HTMLDivElement;
const captionLabelEl = document.getElementById('caption-label') as HTMLDivElement;
const captionTextEl = document.getElementById('caption-text') as HTMLDivElement;

// The caption body is taller than the box it lives in for any normal reply, so
// somebody has to scroll it — nothing did, which is why a reply looked frozen
// on its first couple of lines. Two things scroll it now:
//   1. While the reply streams in, it sticks to the newest line (below).
//   2. Once the reply is being spoken, it crawls top-to-bottom over roughly
//      the duration of the speech, so the text can be read along with the
//      voice instead of sitting at whichever end it happened to stop at.
let crawlFrame: number | null = null;

function cancelCrawl() {
  if (crawlFrame === null) return;
  cancelAnimationFrame(crawlFrame);
  crawlFrame = null;
}

function startCaptionCrawl(durationMs: number) {
  cancelCrawl();
  const distance = captionTextEl.scrollHeight - captionTextEl.clientHeight;
  if (distance <= 1) return; // short reply, fits already — scrolling it would just twitch
  captionTextEl.scrollTop = 0;
  const duration = Math.max(600, durationMs);
  const startedAt = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startedAt) / duration);
    // Ease in/out: a linear crawl lurches into motion and stops dead at the end.
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    captionTextEl.scrollTop = distance * eased;
    crawlFrame = t < 1 ? requestAnimationFrame(step) : null;
  };
  crawlFrame = requestAnimationFrame(step);
}

// Speech actually finished — whatever the estimate was, stop here and rest on
// the last line so the end of the reply is what's left on screen.
function finishCaptionCrawl() {
  cancelCrawl();
  captionTextEl.scrollTop = captionTextEl.scrollHeight;
}

window.mascotAPI.onCaption(({ label, text }) => {
  captionLabelEl.textContent = label;
  captionTextEl.textContent = text;
  captionEl.classList.toggle('visible', !!(label || text));
  // New text supersedes any crawl still running over the old text, and
  // streamed text should follow the newest line rather than stay at the top.
  cancelCrawl();
  captionTextEl.scrollTop = captionTextEl.scrollHeight;
});

window.mascotAPI.onCaptionCrawl(({ durationMs }) => startCaptionCrawl(durationMs));
window.mascotAPI.onCaptionCrawlEnd(() => finishCaptionCrawl());

// Push-to-talk to START (main.js drives this via a global hotkey since it
// works even when the mascot window isn't focused), but ending a turn is
// volume-based, not another keypress or a flat timer: a real end-of-speech
// detector on the mic's own level is both the more reliable "did it actually
// hear me" signal (you can see the meter move) and a much snappier way to
// know someone's done talking than waiting on a fixed timeout. Watson's own
// inactivity timeout (see stt.js) stays as a backstop for "never said
// anything at all," not as the primary mechanism.
let mediaRecorder: MediaRecorder | null = null;
let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let vadBuffer: Uint8Array | null = null;
let vadActive = false;
let hasSpokenThisTurn = false;
let silenceStartedAt: number | null = null;
let aboveThresholdSince: number | null = null;
let speechWindowStartedAt: number | null = null; // when calibration ended and we began actually listening

const DEFAULT_SPEECH_THRESHOLD = 0.025; // fallback if calibration ever fails to produce a sane value
// Was 900ms — that's 900ms of pure dead time between actually finishing a
// sentence and anything visibly happening, on every single turn. 550ms is
// still comfortably longer than a normal mid-sentence breath/pause (most run
// under ~350ms), so this shouldn't cut real speech off; it just stops making
// every turn wait through the tail of a window sized for a worst case that
// rarely happens.
const SILENCE_HANGOVER_MS = 550;
// A single instantaneous spike above the threshold counted as "started
// talking" before this — a mouse click, a key tap, a door closing all clear
// that bar just as easily as a word does. Requiring the level to stay above
// it continuously for this long filters those out without needing a smarter
// (and slower) VAD model.
const MIN_SPEECH_MS = 150;
// If nobody says anything at all, the turn used to stay open until Watson's
// own 12s inactivity timeout expired (stt.js) before anything happened. That
// is the exact path that ends in "Sorry, I didn't catch that", so it was the
// slowest possible route to the least useful outcome. Giving up locally after
// this long cuts ~7s of dead air off every silent turn; the Watson timeout
// stays as the backstop for the case where this never fires.
const NO_SPEECH_TIMEOUT_MS = 5000;

// Noise-floor calibration: a hardcoded threshold assumes one fixed room. Real
// rooms vary — a quiet office and one with a fan running need different
// cutoffs — so instead every recording samples its own ambient level for the
// first CALIBRATION_MS and derives the threshold from THAT, before any
// speech-detection logic runs at all.
const CALIBRATION_MS = 250;
const NOISE_MARGIN_MULTIPLIER = 2.5; // how far above the measured floor counts as "someone's talking"
const NOISE_MARGIN_FLOOR = 0.006; // guards a near-silent room's floor (~0) from producing a near-zero threshold
const MIN_THRESHOLD = 0.012;
const MAX_THRESHOLD = 0.09;

let activeThreshold = DEFAULT_SPEECH_THRESHOLD;
let calibrating = false;
let calibrationStartedAt = 0;
let calibrationSamples: number[] = [];

const vuFillEl = document.getElementById('vu-fill') as HTMLDivElement;

function currentLevel(): number {
  if (!analyser || !vadBuffer) return 0;
  analyser.getByteTimeDomainData(vadBuffer);
  let sumSquares = 0;
  for (let i = 0; i < vadBuffer.length; i++) {
    const centered = (vadBuffer[i] - 128) / 128;
    sumSquares += centered * centered;
  }
  return Math.sqrt(sumSquares / vadBuffer.length);
}

function finishCalibration() {
  calibrating = false;
  if (calibrationSamples.length === 0) {
    activeThreshold = DEFAULT_SPEECH_THRESHOLD;
  } else {
    const floor = calibrationSamples.reduce((sum, v) => sum + v, 0) / calibrationSamples.length;
    const computed = floor * NOISE_MARGIN_MULTIPLIER + NOISE_MARGIN_FLOOR;
    activeThreshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, computed));
  }
  calibrationSamples = [];
  window.mascotAPI.logVadCalibration(activeThreshold);
}

// Called every animation frame while recording (see loop(), below).
function checkVoiceActivity(now: number) {
  if (!vadActive) return;
  const level = currentLevel();
  vuFillEl.style.width = `${Math.min(100, level * 400)}%`;

  if (calibrating) {
    calibrationSamples.push(level);
    if (now - calibrationStartedAt < CALIBRATION_MS) return;
    finishCalibration();
    speechWindowStartedAt = now; // only now is the threshold real, so only now does the clock start
    return; // evaluate speech starting next frame, on a level reading taken after calibration
  }

  if (level > activeThreshold) {
    if (aboveThresholdSince === null) aboveThresholdSince = now;
    if (!hasSpokenThisTurn && now - aboveThresholdSince >= MIN_SPEECH_MS) {
      hasSpokenThisTurn = true;
    }
    silenceStartedAt = null;
    return;
  }
  aboveThresholdSince = null;
  if (!hasSpokenThisTurn) {
    // Nothing has been said yet this turn. Reached only on a frame where the
    // level is BELOW the threshold, so this can't cut off a word that's
    // currently being spoken.
    if (speechWindowStartedAt !== null && now - speechWindowStartedAt >= NO_SPEECH_TIMEOUT_MS) stopRecording();
    return; // hasn't sustained real speech yet — don't count silence before it
  }
  if (silenceStartedAt === null) {
    silenceStartedAt = now;
    return;
  }
  if (now - silenceStartedAt >= SILENCE_HANGOVER_MS) {
    stopRecording(); // a real pause after real speech — this turn is done
  }
}

async function startRecording() {
  console.log(`[mic] recording start requested mediaDevices=${!!navigator.mediaDevices} mediaRecorder=${typeof MediaRecorder}`);
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = micStream.getAudioTracks()[0];
    console.log(`[mic] getUserMedia success track=${track?.label || 'unknown'} state=${track?.readyState || 'unknown'}`);
  } catch (error) {
    console.error('[mic] getUserMedia failed:', error instanceof DOMException ? `${error.name}: ${error.message}` : error);
    window.mascotAPI.micError(); // permission denied or no mic — main.js speaks up and resets
    return;
  }
  window.mascotAPI.micOpened(); // only now is the mic actually open

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  vadBuffer = new Uint8Array(analyser.frequencyBinCount);
  hasSpokenThisTurn = false;
  silenceStartedAt = null;
  aboveThresholdSince = null;
  speechWindowStartedAt = null;
  calibrating = true;
  calibrationStartedAt = performance.now();
  calibrationSamples = [];
  vadActive = true;

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : '';
  console.log(`[mic] MediaRecorder mimeType=${mimeType || 'browser default'}`);
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0) window.mascotAPI.sendAudioChunk(await e.data.arrayBuffer());
    else console.warn('[mic] MediaRecorder emitted an empty chunk');
  };
  mediaRecorder.onstop = async () => {
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    await window.mascotAPI.endAudio();
  };
  mediaRecorder.start(250);
  console.log('[mic] MediaRecorder started');
}

function stopRecording() {
  if (!mediaRecorder) return; // already stopped (VAD and a manual/auto stop can race)
  vadActive = false;
  vuFillEl.style.width = '0%';
  audioCtx?.close();
  audioCtx = null;
  analyser = null;
  // The single, accurate "mic is closing now" signal, whoever triggered it —
  // carrying whether real speech was ever detected, which is what lets the
  // main process stop apologising for silence it was never given.
  window.mascotAPI.micClosing(hasSpokenThisTurn);
  mediaRecorder.stop();
  mediaRecorder = null;
}

window.mascotAPI.onRecordControl((action) => {
  if (action === 'start') startRecording();
  else stopRecording();
});

// Right-click opens the tray context menu (Settings, Restart, Quit) — quitting
// directly on right-click was too easy to trigger by accident.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.mascotAPI.showContextMenu();
});
