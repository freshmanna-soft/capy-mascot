import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

declare global {
  interface Window {
    mascotAPI: {
      getSettings: () => Promise<Record<string, any>>;
      setSettings: (patch: Record<string, any>) => Promise<Record<string, any>>;
      restart: () => void;
      requestMicrophone: () => Promise<boolean>;
      openMicrophoneSettings: () => void;
    };
  }
}

// Live 3D preview — same model, same lighting rig as the floating mascot
// window's own Three.js scene (see renderer-entry.ts), but with real
// orbit-drag controls instead of a fixed camera: this window exists to let
// you actually look the character over, not just glance at it in a corner.
const canvas = document.getElementById('preview') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, -10, 2.45);

const root = new THREE.Group();
root.rotation.y = Math.PI;
scene.add(root);
scene.add(new THREE.HemisphereLight(0xffead5, 0x2a1710, 2.4));
const key = new THREE.DirectionalLight(0xfff1dc, 3.2);
key.position.set(-3, -5, 6);
scene.add(key);

// Orbits around the same point the fixed mascot-window camera looks at, so
// the preview opens on the familiar framing before you ever drag.
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 1.45);
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 16;
controls.enableDamping = true;
controls.dampingFactor = 0.08;
camera.lookAt(controls.target);

let ready = false;
new GLTFLoader().load(
  'assets/capybara.glb',
  (gltf) => {
    root.add(gltf.scene);
    ready = true;
  },
  undefined,
  (error) => console.warn('[settings] capybara preview unavailable', error)
);

function resize() {
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function loop() {
  controls.update();
  if (ready) {
    // A small idle sway so it doesn't look frozen while you're deciding
    // whether to drag — subtle enough not to fight the orbit controls.
    const t = clock.getElapsedTime();
    root.position.y = Math.sin(t * 2.1) * 0.035;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── Everything below is the settings form itself — unchanged from the
// previous plain-script version, just moved into this bundle. ──

const localVoice = document.getElementById('local-voice') as HTMLInputElement;
const localLLM = document.getElementById('local-llm') as HTMLInputElement;
const alwaysOnTop = document.getElementById('always-on-top') as HTMLInputElement;
const launchLogin = document.getElementById('launch-login') as HTMLInputElement;
const positionX = document.getElementById('position-x') as HTMLElement;
const positionY = document.getElementById('position-y') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const avatarX = document.getElementById('avatar-x') as HTMLInputElement;
const avatarY = document.getElementById('avatar-y') as HTMLInputElement;
const avatarZ = document.getElementById('avatar-z') as HTMLInputElement;
const outfit = document.getElementById('outfit') as HTMLSelectElement;
const defaultMood = document.getElementById('default-mood') as HTMLSelectElement;
const workHelmet = document.getElementById('work-helmet') as HTMLInputElement;
const watsonVoice = document.getElementById('watson-voice') as HTMLSelectElement;

function showStatus(message: string) {
  status.textContent = message;
  window.setTimeout(() => {
    if (status.textContent === message) status.textContent = '';
  }, 1600);
}

function updateSliderLabels() {
  (document.getElementById('avatar-x-value') as HTMLElement).textContent = Number(avatarX.value).toFixed(2);
  (document.getElementById('avatar-y-value') as HTMLElement).textContent = Number(avatarY.value).toFixed(2);
  (document.getElementById('avatar-z-value') as HTMLElement).textContent = Number(avatarZ.value).toFixed(2);
}

async function load() {
  const settings = await window.mascotAPI.getSettings();
  localVoice.checked = settings.useLocalVoice;
  localLLM.checked = settings.useLocalLLM;
  alwaysOnTop.checked = settings.alwaysOnTop;
  launchLogin.checked = settings.launchAtLogin;
  avatarX.value = String(settings.avatarX);
  avatarY.value = String(settings.avatarY);
  avatarZ.value = String(settings.avatarZ);
  outfit.value = settings.outfit;
  defaultMood.value = settings.defaultMood;
  workHelmet.checked = settings.workHelmet;
  watsonVoice.value = settings.watsonVoice;
  updateSliderLabels();
  positionX.textContent = Number.isFinite(settings.windowX) ? String(settings.windowX) : 'Default';
  positionY.textContent = Number.isFinite(settings.windowY) ? String(settings.windowY) : 'Default';
}

localVoice.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ useLocalVoice: localVoice.checked });
  showStatus('Saved');
});
localLLM.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ useLocalLLM: localLLM.checked });
  showStatus('Saved');
});
alwaysOnTop.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ alwaysOnTop: alwaysOnTop.checked });
  showStatus('Saved');
});
launchLogin.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ launchAtLogin: launchLogin.checked });
  showStatus('Saved');
});

async function saveAvatarPosition() {
  updateSliderLabels();
  await window.mascotAPI.setSettings({
    avatarX: Number(avatarX.value),
    avatarY: Number(avatarY.value),
    avatarZ: Number(avatarZ.value),
  });
  showStatus('Saved');
}
avatarX.addEventListener('input', saveAvatarPosition);
avatarY.addEventListener('input', saveAvatarPosition);
avatarZ.addEventListener('input', saveAvatarPosition);

outfit.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ outfit: outfit.value });
  showStatus('Saved');
});
defaultMood.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ defaultMood: defaultMood.value });
  showStatus('Saved');
});
workHelmet.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ workHelmet: workHelmet.checked });
  showStatus('Saved');
});
watsonVoice.addEventListener('change', async () => {
  await window.mascotAPI.setSettings({ watsonVoice: watsonVoice.value });
  showStatus('Saved');
});
(document.getElementById('reset-position') as HTMLButtonElement).addEventListener('click', async () => {
  await window.mascotAPI.setSettings({ windowX: null, windowY: null });
  await load();
  showStatus('Position reset on next restart');
});
(document.getElementById('restart') as HTMLButtonElement).addEventListener('click', () => window.mascotAPI.restart());

(document.getElementById('test-microphone') as HTMLButtonElement).addEventListener('click', async () => {
  try {
    const allowed = await window.mascotAPI.requestMicrophone();
    if (!allowed) throw new Error('permission denied');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    showStatus('Microphone access granted');
  } catch {
    showStatus('Microphone access is blocked');
    window.mascotAPI.openMicrophoneSettings();
  }
});

load();
