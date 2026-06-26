import * as THREE from "../vendor/three.module.js";
import { EXPERIENCE } from "./experience.config.js";

const canvas = document.querySelector("#vr-canvas");
const startScreen = document.querySelector("#start-screen");
const enterVrButton = document.querySelector("#enter-vr");
const previewButton = document.querySelector("#preview-mode");
const supportNote = document.querySelector("#support-note");

window.__vrBoot = { stage: "module-start" };

const params = new URLSearchParams(window.location.search);
const requestedSpeed = Number(params.get("speed"));
const hasSpeedOverride = Number.isFinite(requestedSpeed) && requestedSpeed > 0;
const fastMode = params.has("fast") || hasSpeedOverride;
const timeScale = hasSpeedOverride ? requestedSpeed : (fastMode ? EXPERIENCE.fastModeMultiplier : 1);
const scaled = (seconds) => seconds / timeScale;

const GOLD = 0xf3c86a;
const SOFT_GOLD = 0xffde8f;
const WARM_WHITE = 0xf6f2e8;
const RED = 0xff725e;
const BLUE = 0x73b7ff;
const GREEN = 0x79e0a8;
const DIM_COLOR = new THREE.Color(0x27221b);
const ACTIVE_COLOR = new THREE.Color(0xffffff);
const NEXT_HINT_COLOR = new THREE.Color(0x9f8c6f);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  window.__vrBoot.stage = "renderer-ready";
} catch (error) {
  window.__vrBoot.stage = "renderer-error";
  window.__vrBoot.message = String(error?.message || error);
  if (supportNote) {
    supportNote.textContent = "Ten podglad nie uruchomil WebGL. Otworz w Meta Quest Browser albo Chromium.";
  }
  throw error;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.05,
  90,
);
camera.position.set(0, 1.58, 0);
scene.add(camera);

const textureLoader = new THREE.TextureLoader();
const raycaster = new THREE.Raycaster();
const clock = new THREE.Clock();
const cameraPosition = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const tmpColor = new THREE.Color();
const tweens = [];

let mode = "loading";
let activeSceneIndex = -1;
let sceneTimer = 0;
let awaitTimer = 0;
let closingTimer = 0;
let currentGazeTarget = null;
let currentGazeType = null;
let gazeTimer = 0;
let reflectionSearchActive = false;
let reflectionRevealed = false;
let desktopYaw = THREE.MathUtils.degToRad(EXPERIENCE.scenes[0].angleDeg);
let desktopPitch = 0;
let pointerLookActive = false;
let pointerStartX = 0;
let pointerStartY = 0;
let yawStart = 0;
let pitchStart = 0;
let immersiveVrSupported = null;
let fadeSphere;
let interactionArmed = false;

const panels = new Map();
const firedEvents = new Set();

class AudioDirector {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.sceneToken = 0;
    this.backgroundAudio = null;
    this.unlocked = false;
  }

  async unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.context = new AudioContextClass();
      }
    }

    if (this.context?.state === "suspended") {
      await this.context.resume();
    }

    if (this.context) {
      const source = this.context.createBufferSource();
      source.buffer = this.context.createBuffer(1, 1, 22050);
      source.connect(this.context.destination);
      source.start(0);
    }

    this.unlocked = true;
    await this.playBackground();
  }

  async playBackground() {
    if (!this.config.background || this.backgroundAudio) return;
    const audio = new Audio(`${this.config.basePath}${this.config.background}`);
    audio.loop = true;
    audio.volume = this.config.backgroundVolume;
    try {
      await audio.play();
      this.backgroundAudio = audio;
    } catch {
      this.backgroundAudio = null;
    }
  }

  stopScene() {
    this.sceneToken += 1;
  }

  playScene(cues) {
    const token = ++this.sceneToken;
    this.runCues(cues, token);
  }

  async runCues(cues, token) {
    if (!Array.isArray(cues)) return;

    for (const cue of cues) {
      if (token !== this.sceneToken) return;
      await this.playCue(cue, token);
      if (token !== this.sceneToken) return;
      await wait(scaled(cue.pauseAfter || 0));
    }
  }

  async playCue(cue, token) {
    if (fastMode || !this.unlocked) {
      await wait(scaled(cue.duration || 1));
      return;
    }

    const candidates = cue.file
      ? [cue.file]
      : this.config.extensionFallbacks.map((extension) => `${cue.id}.${extension}`);

    for (const filename of candidates) {
      const ok = await this.tryPlayAudio(`${this.config.basePath}${filename}`, token);
      if (ok) return;
    }

    await wait(scaled(cue.duration || 1));
  }

  tryPlayAudio(src, token) {
    return new Promise((resolve) => {
      const audio = new Audio(src);
      let settled = false;
      audio.volume = this.config.narrationVolume;

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        audio.pause();
        audio.src = "";
        resolve(ok);
      };

      const timer = window.setTimeout(() => finish(false), 1200);

      audio.addEventListener("canplaythrough", () => {
        if (token !== this.sceneToken) {
          finish(false);
          return;
        }
        window.clearTimeout(timer);
        audio
          .play()
          .then(() => {
            audio.addEventListener("ended", () => finish(true), { once: true });
            audio.addEventListener("error", () => finish(false), { once: true });
          })
          .catch(() => finish(false));
      }, { once: true });

      audio.addEventListener("error", () => {
        window.clearTimeout(timer);
        finish(false);
      }, { once: true });
    });
  }
}

const audioDirector = new AudioDirector(EXPERIENCE.audio);

init();

function init() {
  window.__vrBoot.stage = "init-start";
  createGalleryShell();
  createReticle();
  createPanels();
  createFadeSphere();
  resetExperience({ armed: false });
  bindUi();
  bindDesktopLook();
  updateSupportNote();

  window.__vrBoot.stage = "ready";
  renderer.setAnimationLoop(render);
  if (hasSpeedOverride) {
    window.setInterval(render, 1000 / 30);
  }
}

function createGalleryShell() {
  const bgTexture = textureLoader.load(EXPERIENCE.assets.background);
  bgTexture.colorSpace = THREE.SRGBColorSpace;
  bgTexture.minFilter = THREE.LinearFilter;
  bgTexture.magFilter = THREE.LinearFilter;

  const backgroundGeometry = new THREE.CylinderGeometry(
    9.2,
    9.2,
    3.25,
    96,
    1,
    true,
    THREE.MathUtils.degToRad(72),
    THREE.MathUtils.degToRad(216),
  );
  const backgroundMaterial = new THREE.MeshBasicMaterial({
    map: bgTexture,
    side: THREE.BackSide,
    color: 0x7f7568,
  });
  const background = new THREE.Mesh(backgroundGeometry, backgroundMaterial);
  background.position.y = 1.62;
  scene.add(background);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 22),
    new THREE.MeshBasicMaterial({ color: 0x070706, transparent: true, opacity: 0.92 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 22),
    new THREE.MeshBasicMaterial({ color: 0x030303, transparent: true, opacity: 0.84 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3.18;
  scene.add(ceiling);
}

function createReticle() {
  const reticleGroup = new THREE.Group();
  reticleGroup.name = "reticle";
  reticleGroup.position.set(0, 0, -1.35);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.017, 0.023, 48),
    new THREE.MeshBasicMaterial({
      color: WARM_WHITE,
      transparent: true,
      opacity: 0.34,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  ring.name = "reticle-ring";
  reticleGroup.add(ring);

  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.006, 32),
    new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  dot.name = "reticle-dot";
  reticleGroup.add(dot);
  camera.add(reticleGroup);
}

function createPanels() {
  for (const sceneConfig of EXPERIENCE.scenes) {
    const panel = createPanel(sceneConfig);
    panels.set(sceneConfig.id, panel);
    scene.add(panel.root);
  }

  const firstPanel = getPanel(0);
  const startRing = new THREE.Group();
  startRing.name = "start-target";

  const outer = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.19, 64),
    new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    }),
  );
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.045, 48),
    new THREE.MeshBasicMaterial({
      color: GOLD,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    }),
  );
  startRing.add(outer, inner);
  startRing.position.z = 0.075;
  firstPanel.overlayRoot.add(startRing);

  const hit = new THREE.Mesh(
    new THREE.CircleGeometry(0.36, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
  );
  hit.name = "start-hit-target";
  hit.position.z = 0.09;
  firstPanel.overlayRoot.add(hit);

  firstPanel.startRing = startRing;
  firstPanel.startHit = hit;
}

function createPanel(sceneConfig) {
  const root = new THREE.Group();
  root.name = sceneConfig.id;

  const angle = THREE.MathUtils.degToRad(sceneConfig.angleDeg);
  const radius = 5.65;
  root.position.set(Math.sin(angle) * radius, 1.58, -Math.cos(angle) * radius);
  root.rotation.y = -angle;

  const width = sceneConfig.width;
  const height = width / sceneConfig.aspect;
  const texture = textureLoader.load(EXPERIENCE.assets.images[sceneConfig.imageKey]);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const contentRoot = new THREE.Group();
  root.add(contentRoot);

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.14, height + 0.14),
    new THREE.MeshBasicMaterial({
      color: 0x090807,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
    }),
  );
  frame.position.z = -0.018;
  contentRoot.add(frame);

  const photoMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    color: DIM_COLOR.clone(),
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
  });
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(width, height), photoMaterial);
  photo.name = `${sceneConfig.id}-photo`;
  contentRoot.add(photo);

  const target = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.32, height + 0.32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    }),
  );
  target.name = `${sceneConfig.id}-gaze-target`;
  target.position.z = 0.065;
  root.add(target);

  const overlayRoot = new THREE.Group();
  overlayRoot.name = `${sceneConfig.id}-overlays`;
  overlayRoot.position.z = 0.055;
  root.add(overlayRoot);

  const introRoot = sceneConfig.introImageKey ? createIntroLayer(sceneConfig) : null;
  if (introRoot) {
    root.add(introRoot);
  }

  return {
    config: sceneConfig,
    root,
    contentRoot,
    frame,
    photo,
    target,
    overlayRoot,
    introRoot,
    texture,
    width,
    height,
    markers: [],
    triptych: null,
    zoom: null,
  };
}

function createIntroLayer(sceneConfig) {
  const introRoot = new THREE.Group();
  introRoot.name = `${sceneConfig.id}-intro`;
  introRoot.position.z = 0.105;

  const introWidth = sceneConfig.introWidth || 3.4;
  const introHeight = introWidth / (sceneConfig.introAspect || 1.25);
  const introTexture = textureLoader.load(EXPERIENCE.assets.images[sceneConfig.introImageKey]);
  introTexture.colorSpace = THREE.SRGBColorSpace;
  introTexture.minFilter = THREE.LinearFilter;
  introTexture.magFilter = THREE.LinearFilter;

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(introWidth + 0.11, introHeight + 0.11),
    new THREE.MeshBasicMaterial({
      color: 0x090807,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
  );
  frame.position.z = -0.018;
  introRoot.add(frame);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(introWidth, introHeight),
    new THREE.MeshBasicMaterial({
      map: introTexture,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    }),
  );
  introRoot.add(mesh);

  return introRoot;
}

function createFadeSphere() {
  fadeSphere = new THREE.Mesh(
    new THREE.SphereGeometry(20, 32, 16),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  fadeSphere.renderOrder = 1000;
  fadeSphere.position.set(0, 1.58, 0);
  scene.add(fadeSphere);
}

function bindUi() {
  enterVrButton.addEventListener("click", async () => {
    await startFromUserGesture(true);
  });

  previewButton.addEventListener("click", async () => {
    await startFromUserGesture(false);
  });

  window.addEventListener("resize", resize);
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      triggerCurrentTarget();
    }
    if (event.code === "KeyR") {
      resetExperience({ armed: startScreen.classList.contains("is-hidden") });
    }
  });
}

async function startFromUserGesture(tryVr) {
  const unlockPromise = audioDirector.unlock().catch(() => undefined);

  if (tryVr && navigator.xr && immersiveVrSupported !== false) {
    try {
      const session = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });
      await Promise.race([unlockPromise, wait(0.6)]);
      session.addEventListener("end", () => {
        startScreen.classList.remove("is-hidden");
        resetExperience({ armed: false });
      });
      await renderer.xr.setSession(session);
      startScreen.classList.add("is-hidden");
      resetExperience({ armed: true });
      return;
    } catch (error) {
      supportNote.textContent = "VR nie wystartowal. Otworz przez HTTPS w Meta Quest Browser.";
    }
  }

  await Promise.race([unlockPromise, wait(0.6)]);
  startScreen.classList.add("is-hidden");
  resetExperience({ armed: true });
}

function updateSupportNote() {
  if (!navigator.xr) {
    supportNote.textContent = "Na tym ekranie dziala podglad 2D. VR uruchomisz w Meta Quest Browser.";
    return;
  }
  if (!window.isSecureContext) {
    supportNote.textContent = "WebXR wymaga HTTPS. Localhost dziala tylko do testu.";
    return;
  }
  navigator.xr.isSessionSupported("immersive-vr").then((supported) => {
    immersiveVrSupported = supported;
    if (!supported) {
      supportNote.textContent = "Na tym urzadzeniu dziala podglad. VR uruchomisz w goglach.";
    } else if (fastMode) {
      supportNote.textContent = "Tryb szybkiego testu jest wlaczony.";
    }
  }).catch(() => {
    immersiveVrSupported = false;
  });
  supportNote.textContent = fastMode ? "Tryb szybkiego testu jest wlaczony." : "";
}

function bindDesktopLook() {
  canvas.addEventListener("pointerdown", (event) => {
    pointerLookActive = true;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    yawStart = desktopYaw;
    pitchStart = desktopPitch;
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!pointerLookActive || renderer.xr.isPresenting) return;
    desktopYaw = yawStart - (event.clientX - pointerStartX) * 0.004;
    desktopPitch = THREE.MathUtils.clamp(
      pitchStart - (event.clientY - pointerStartY) * 0.003,
      -0.58,
      0.58,
    );
  });

  canvas.addEventListener("pointerup", (event) => {
    pointerLookActive = false;
    canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener("click", () => {
    triggerCurrentTarget();
  });
}

function resetExperience({ armed = true } = {}) {
  interactionArmed = armed;
  activeSceneIndex = -1;
  sceneTimer = 0;
  awaitTimer = 0;
  closingTimer = 0;
  mode = interactionArmed ? "idle" : "standby";
  gazeTimer = 0;
  reflectionSearchActive = false;
  reflectionRevealed = false;
  currentGazeTarget = interactionArmed ? getPanel(0).startHit : null;
  currentGazeType = interactionArmed ? "start" : null;
  firedEvents.clear();
  audioDirector.stopScene();
  fadeSphere.material.opacity = 0;

  for (const panel of panels.values()) {
    setPanelVisual(panel, 0.16, 0);
    panel.photo.material.color.copy(DIM_COLOR);
    panel.contentRoot.scale.set(1, 1, 1);
    panel.texture.repeat.set(1, 1);
    panel.texture.offset.set(0, 0);
    clearPanelOverlays(panel);
    if (panel.introRoot) {
      setConcertIntro(panel, false);
    }
    panel.frame.material.color.setHex(0x090807);
  }

  const firstPanel = getPanel(0);
  if (firstPanel.startRing) {
    firstPanel.startRing.visible = true;
    setGroupOpacity(firstPanel.startRing, 1);
  }
}

function render() {
  const rawDelta = clock.getDelta();
  const animationDelta = Math.min(rawDelta, 0.05);
  const timelineDelta = Math.min(rawDelta, 1);
  if (!renderer.xr.isPresenting) {
    updateDesktopCamera();
  }

  updateTweens(animationDelta);
  updateMode(timelineDelta);
  updateGaze(animationDelta);
  updateReticle();
  window.__vrState = {
    mode,
    activeSceneIndex,
    sceneTimer: Number(sceneTimer.toFixed(2)),
    awaitTimer: Number(awaitTimer.toFixed(2)),
    currentGazeType,
    reflectionRevealed,
  };
  renderer.render(scene, camera);
}

function updateDesktopCamera() {
  camera.rotation.order = "YXZ";
  camera.rotation.y = desktopYaw;
  camera.rotation.x = desktopPitch;
}

function updateMode(delta) {
  if (mode === "playing") {
    sceneTimer += delta * timeScale;
    const sceneConfig = EXPERIENCE.scenes[activeSceneIndex];

    for (const eventConfig of sceneConfig.events) {
      const key = `${sceneConfig.id}:${eventConfig.action}`;
      if (sceneTimer >= eventConfig.at && !firedEvents.has(key)) {
        firedEvents.add(key);
        handleSceneEvent(eventConfig.action);
      }
    }

    if (sceneTimer >= sceneConfig.duration) {
      if (activeSceneIndex < EXPERIENCE.scenes.length - 1) {
        awaitNextScene(activeSceneIndex + 1);
      } else {
        startClosing();
      }
    }
  }

  if (mode === "await-next") {
    awaitTimer += delta * timeScale;
    const delay = EXPERIENCE.gaze.transitionSafetySeconds;
    if (delay > 0 && awaitTimer >= delay) {
      transitionToScene(activeSceneIndex + 1);
    }
  }

  if (mode === "closing") {
    closingTimer += delta * timeScale;
    if (closingTimer >= EXPERIENCE.closing.duration) {
      resetExperience({ armed: true });
    }
  }
}

function updateGaze(delta) {
  if (!currentGazeTarget) {
    gazeTimer = 0;
    return;
  }

  const hit = isLookingAt(currentGazeTarget);
  if (!hit) {
    gazeTimer = Math.max(0, gazeTimer - delta * 1.6);
    return;
  }

  const dwell = currentGazeType === "reflection"
    ? EXPERIENCE.gaze.sceneThreeDwellSeconds
    : EXPERIENCE.gaze.dwellSeconds;
  gazeTimer += delta;

  if (gazeTimer >= scaled(dwell)) {
    triggerCurrentTarget();
  }
}

function updateReticle() {
  const reticle = camera.getObjectByName("reticle");
  if (!reticle) return;

  const targetIsActive = Boolean(currentGazeTarget && isLookingAt(currentGazeTarget));
  const dwell = currentGazeType === "reflection"
    ? EXPERIENCE.gaze.sceneThreeDwellSeconds
    : EXPERIENCE.gaze.dwellSeconds;
  const progress = THREE.MathUtils.clamp(gazeTimer / scaled(dwell), 0, 1);

  const ring = reticle.getObjectByName("reticle-ring");
  const dot = reticle.getObjectByName("reticle-dot");
  ring.material.opacity = targetIsActive ? 0.4 + progress * 0.42 : 0.26;
  dot.material.opacity = targetIsActive ? 0.18 + progress * 0.52 : 0.12;
  dot.scale.setScalar(1 + progress * 2.4);
  ring.material.color.setHex(targetIsActive ? GOLD : WARM_WHITE);
}

function triggerCurrentTarget() {
  if (!currentGazeTarget) return;

  if (currentGazeType === "start") {
    transitionToScene(0);
    return;
  }

  if (currentGazeType === "next") {
    transitionToScene(activeSceneIndex + 1);
    return;
  }

  if (currentGazeType === "reflection") {
    revealReflection();
  }
}

function transitionToScene(index) {
  if (mode === "transition" || index < 0 || index >= EXPERIENCE.scenes.length) return;

  if (timeScale > 20) {
    fadeSphere.material.opacity = 0;
    startScene(index);
    return;
  }

  mode = "transition";
  currentGazeTarget = null;
  currentGazeType = null;
  gazeTimer = 0;

  tween(0.48, (t) => {
    fadeSphere.material.opacity = t;
  }, () => {
    startScene(index);
    tween(0.8, (t) => {
      fadeSphere.material.opacity = 1 - t;
    });
  });
}

function startScene(index) {
  activeSceneIndex = index;
  sceneTimer = 0;
  awaitTimer = 0;
  mode = "playing";
  reflectionSearchActive = false;
  reflectionRevealed = false;
  firedEvents.clear();
  currentGazeTarget = null;
  currentGazeType = null;
  gazeTimer = 0;

  const sceneConfig = EXPERIENCE.scenes[index];
  const activePanel = getPanel(index);
  if (activePanel.startRing) activePanel.startRing.visible = false;

  for (let i = 0; i < EXPERIENCE.scenes.length; i += 1) {
    const panel = getPanel(i);
    if (i !== index) {
      clearPanelOverlays(panel);
      if (panel.introRoot) {
        setGroupOpacity(panel.introRoot, 0);
        panel.introRoot.visible = false;
      }
    }
    const targetOpacity = i === index
      ? (panel.config.introImageKey ? 0.1 : 1)
      : 0.14;
    const targetColor = i === index ? ACTIVE_COLOR : DIM_COLOR;
    tween(0.75, (t) => {
      panel.photo.material.opacity = THREE.MathUtils.lerp(panel.photo.material.opacity, targetOpacity, t);
      panel.frame.material.opacity = THREE.MathUtils.lerp(panel.frame.material.opacity, i === index ? 0.92 : 0.48, t);
      panel.photo.material.color.copy(tmpColor.copy(panel.photo.material.color).lerp(targetColor, t));
    });
  }

  clearPanelOverlays(activePanel);
  if (sceneConfig.imageKey === "concert") {
    setConcertCrop(activePanel, 0);
    setConcertIntro(activePanel, Boolean(sceneConfig.introImageKey));
  }

  audioDirector.stopScene();
  audioDirector.playScene(sceneConfig.cues);
}

function awaitNextScene(nextIndex) {
  mode = "await-next";
  awaitTimer = 0;
  currentGazeTarget = getPanel(nextIndex).target;
  currentGazeType = "next";
  gazeTimer = 0;
  audioDirector.stopScene();

  const currentPanel = getPanel(activeSceneIndex);
  const nextPanel = getPanel(nextIndex);
  clearPanelOverlays(currentPanel);
  tween(1.1, (t) => {
    currentPanel.photo.material.opacity = THREE.MathUtils.lerp(currentPanel.photo.material.opacity, 0.34, t);
    currentPanel.photo.material.color.copy(tmpColor.copy(currentPanel.photo.material.color).lerp(DIM_COLOR, t));
    nextPanel.photo.material.opacity = THREE.MathUtils.lerp(nextPanel.photo.material.opacity, 0.38, t);
    nextPanel.frame.material.opacity = THREE.MathUtils.lerp(nextPanel.frame.material.opacity, 0.72, t);
    nextPanel.photo.material.color.copy(tmpColor.copy(nextPanel.photo.material.color).lerp(NEXT_HINT_COLOR, t));
  });
}

function startClosing() {
  mode = "closing";
  closingTimer = 0;
  currentGazeTarget = null;
  currentGazeType = null;
  gazeTimer = 0;
  audioDirector.stopScene();
  audioDirector.playScene(EXPERIENCE.closing.cues);

  tween(1.6, (t) => {
    fadeSphere.material.opacity = 0.78 * t;
    for (const panel of panels.values()) {
      panel.photo.material.opacity = THREE.MathUtils.lerp(panel.photo.material.opacity, 0.08, t);
      panel.frame.material.opacity = THREE.MathUtils.lerp(panel.frame.material.opacity, 0.28, t);
      setGroupOpacity(panel.overlayRoot, 1 - t);
    }
  });

  tween(EXPERIENCE.closing.duration - 1.4, () => {}, () => {
    tween(1.2, (t) => {
      fadeSphere.material.opacity = 0.78 * (1 - t);
    });
  });
}

function handleSceneEvent(action) {
  const panel = getPanel(activeSceneIndex);

  switch (action) {
    case "concertCropStart":
      setConcertCrop(panel, 0);
      setConcertIntro(panel, Boolean(panel.config.introImageKey));
      break;
    case "concertReveal":
      tween(
        4.2,
        (t) => setConcertReveal(panel, t),
        () => {
          if (panel.introRoot) {
            panel.introRoot.visible = false;
          }
        },
      );
      break;
    case "shadowSun":
      addCircleMarker(panel, { x: 0.81, y: 0.16, radius: 0.12, color: SOFT_GOLD });
      addArrow(panel, { x: 0.76, y: 0.22 }, { x: 0.88, y: 0.12 }, SOFT_GOLD);
      break;
    case "shadowPerson":
      addRectMarker(panel, { x: 0.30, y: 0.68, w: 0.28, h: 0.18, color: BLUE });
      addArrow(panel, { x: 0.50, y: 0.58 }, { x: 0.25, y: 0.84 }, BLUE);
      break;
    case "shadowTower":
      addRectMarker(panel, { x: 0.49, y: 0.17, w: 0.15, h: 0.34, color: GREEN, opacity: 0.12 });
      addArrow(panel, { x: 0.61, y: 0.29 }, { x: 0.52, y: 0.08 }, GREEN);
      break;
    case "shadowMissing":
      addPolygonMarker(panel, {
        color: RED,
        opacity: 0.2,
        points: [
          { x: 0.45, y: 0.39 },
          { x: 0.56, y: 0.39 },
          { x: 0.43, y: 0.8 },
          { x: 0.23, y: 0.79 },
        ],
      });
      addRectMarker(panel, { x: 0.36, y: 0.69, w: 0.34, h: 0.2, color: RED, opacity: 0.08 });
      addArrow(panel, { x: 0.51, y: 0.35 }, { x: 0.34, y: 0.73 }, RED);
      break;
    case "enableReflectionSearch":
      enableReflectionSearch(panel);
      break;
    case "reflectionSafetyReveal":
      if (!reflectionRevealed) revealReflection();
      break;
    case "sourceSearch":
      addRectMarker(panel, { x: 0.5, y: 0.54, w: 0.82, h: 0.66, color: SOFT_GOLD, opacity: 0.08 });
      break;
    case "sourceNoTrace":
      pulsePanelFrame(panel, SOFT_GOLD);
      break;
    case "sourceTriptych":
      showTriptych(panel);
      break;
    default:
      break;
  }
}

function setConcertCrop(panel, progress) {
  const eased = easeInOutCubic(progress);
  const crop = THREE.MathUtils.lerp(0.42, 1, eased);
  panel.contentRoot.scale.x = crop;
  panel.texture.repeat.x = crop;
  panel.texture.offset.x = (1 - crop) * 0.5;
}

function setConcertIntro(panel, visible) {
  if (!panel.introRoot) return;
  panel.introRoot.visible = visible;
  panel.introRoot.scale.setScalar(1);
  setGroupOpacity(panel.introRoot, visible ? 1 : 0);
}

function setConcertReveal(panel, progress) {
  const eased = easeOutCubic(progress);
  setConcertCrop(panel, progress);
  panel.photo.material.opacity = THREE.MathUtils.lerp(0.1, 1, eased);
  if (panel.introRoot) {
    setGroupOpacity(panel.introRoot, 1 - eased);
    panel.introRoot.scale.setScalar(1 + eased * 0.035);
  }
}

function enableReflectionSearch(panel) {
  if (reflectionSearchActive || reflectionRevealed) return;
  reflectionSearchActive = true;

  const hotspot = new THREE.Mesh(
    new THREE.PlaneGeometry(panel.width * 0.34, panel.height * 0.82),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    }),
  );
  const pos = normToLocal(panel, 0.78, 0.49);
  hotspot.position.set(pos.x, pos.y, 0.085);
  hotspot.name = "reflection-hotspot";
  panel.overlayRoot.add(hotspot);
  panel.reflectionHotspot = hotspot;
  currentGazeTarget = hotspot;
  currentGazeType = "reflection";
  gazeTimer = 0;
}

function revealReflection() {
  if (reflectionRevealed) return;
  reflectionRevealed = true;
  reflectionSearchActive = false;
  currentGazeTarget = null;
  currentGazeType = null;
  gazeTimer = 0;

  const panel = getPanel(2);
  addRectMarker(panel, { x: 0.78, y: 0.5, w: 0.34, h: 0.72, color: SOFT_GOLD, opacity: 0.18 });

  const reflectionCrop = { x: 0.66, y: 0.18, w: 0.28, h: 0.58 };
  const cropAspect = (reflectionCrop.w * panel.config.aspect) / reflectionCrop.h;
  const zoomWidth = 2.05;
  const zoom = createCropPlane(
    EXPERIENCE.assets.images.reflection,
    reflectionCrop,
    zoomWidth,
    zoomWidth / cropAspect,
  );
  zoom.name = "reflection-zoom";
  zoom.position.set(panel.width * 0.22, 0.02, 0.14);
  zoom.scale.setScalar(0.8);
  setGroupOpacity(zoom, 0);
  panel.overlayRoot.add(zoom);
  panel.zoom = zoom;

  addCircleMarker(panel, { x: 0.75, y: 0.62, radius: 0.018, color: RED, parent: zoom, crop: reflectionCrop });

  tween(1.2, (t) => {
    zoom.scale.setScalar(0.8 + easeOutCubic(t) * 0.2);
    setGroupOpacity(zoom, t);
  });
}

function showTriptych(panel) {
  if (panel.triptych) return;

  const triptych = new THREE.Group();
  triptych.name = "source-triptych";
  triptych.position.z = 0.11;
  setGroupOpacity(triptych, 0);

  const itemWidth = panel.width * 0.31;
  const itemHeight = itemWidth / panel.config.aspect;
  const gap = panel.width * 0.035;

  for (let i = 0; i < 3; i += 1) {
    const texture = textureLoader.load(EXPERIENCE.assets.images.source);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(itemWidth, itemHeight), material);
    mesh.position.x = (i - 1) * (itemWidth + gap);
    triptych.add(mesh);

    const frame = new THREE.Mesh(
      new THREE.PlaneGeometry(itemWidth + 0.055, itemHeight + 0.055),
      new THREE.MeshBasicMaterial({
        color: 0x090807,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    frame.position.set(mesh.position.x, 0, -0.018);
    triptych.add(frame);
  }

  panel.overlayRoot.add(triptych);
  panel.triptych = triptych;
  tween(1.5, (t) => {
    panel.photo.material.opacity = THREE.MathUtils.lerp(panel.photo.material.opacity, 0.18, t);
    setGroupOpacity(triptych, easeOutCubic(t));
  });
}

function createCropPlane(imageSrc, crop, width, height) {
  const group = new THREE.Group();
  const texture = textureLoader.load(imageSrc);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(crop.w, crop.h);
  texture.offset.set(crop.x, 1 - crop.y - crop.h);

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(width + 0.08, height + 0.08),
    new THREE.MeshBasicMaterial({
      color: 0x080706,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
  );
  frame.position.z = -0.014;
  group.add(frame);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
    }),
  );
  group.add(mesh);
  group.cropInfo = { crop, width, height };
  return group;
}

function addCircleMarker(panel, options) {
  const parent = options.parent || panel.overlayRoot;
  const local = options.crop
    ? cropNormToLocal(options.parent, options)
    : normToLocal(panel, options.x, options.y);
  const radius = options.crop
    ? options.radius * options.parent.cropInfo.width / options.crop.w
    : options.radius * panel.width;

  const group = new THREE.Group();
  group.position.set(local.x, local.y, 0.1);

  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 48),
    new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.9, radius, 64),
    new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(fill, ring);
  parent.add(group);
  fadeInGroup(group, 0.75);
  panel.markers.push(group);
  return group;
}

function addRectMarker(panel, options) {
  const parent = options.parent || panel.overlayRoot;
  const local = normToLocal(panel, options.x, options.y);
  const width = options.w * panel.width;
  const height = options.h * panel.height;

  const group = new THREE.Group();
  group.position.set(local.x, local.y, 0.095);

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: options.opacity ?? 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  const borderGeometry = new THREE.EdgesGeometry(new THREE.PlaneGeometry(width, height));
  const border = new THREE.LineSegments(
    borderGeometry,
    new THREE.LineBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    }),
  );
  border.position.z = 0.006;
  group.add(fill, border);
  parent.add(group);
  fadeInGroup(group, 0.75);
  panel.markers.push(group);
  return group;
}

function addPolygonMarker(panel, options) {
  const parent = options.parent || panel.overlayRoot;
  const localPoints = options.points.map((point) => normToLocal(panel, point.x, point.y));
  const shape = new THREE.Shape();
  shape.moveTo(localPoints[0].x, localPoints[0].y);
  for (let i = 1; i < localPoints.length; i += 1) {
    shape.lineTo(localPoints[i].x, localPoints[i].y);
  }
  shape.lineTo(localPoints[0].x, localPoints[0].y);

  const group = new THREE.Group();
  group.position.z = 0.105;

  const fillGeometry = new THREE.ShapeGeometry(shape);
  const fill = new THREE.Mesh(
    fillGeometry,
    new THREE.MeshBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: options.opacity ?? 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  group.add(fill);

  const outlinePoints = localPoints.map((point) => new THREE.Vector3(point.x, point.y, 0.008));
  outlinePoints.push(outlinePoints[0].clone());
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(outlinePoints),
    new THREE.LineBasicMaterial({
      color: options.color,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    }),
  );
  group.add(outline);

  parent.add(group);
  fadeInGroup(group, 0.75);
  panel.markers.push(group);
  return group;
}

function addArrow(panel, from, to, color) {
  const start = normToLocal(panel, from.x, from.y);
  const end = normToLocal(panel, to.x, to.y);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  const group = new THREE.Group();
  group.position.set((start.x + end.x) * 0.5, (start.y + end.y) * 0.5, 0.12);
  group.rotation.z = angle;

  const shaft = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(length - 0.16, 0.12), 0.035),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  shaft.position.x = -0.04;
  group.add(shaft);

  const shape = new THREE.Shape();
  shape.moveTo(0.1, 0);
  shape.lineTo(-0.07, 0.09);
  shape.lineTo(-0.07, -0.09);
  shape.lineTo(0.1, 0);
  const head = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  head.position.x = length * 0.5 - 0.05;
  group.add(head);

  panel.overlayRoot.add(group);
  fadeInGroup(group, 0.75);
  panel.markers.push(group);
  return group;
}

function pulsePanelFrame(panel, color) {
  const original = panel.frame.material.color.clone();
  const target = new THREE.Color(color);
  tween(1.4, (t) => {
    const up = t < 0.5 ? t * 2 : (1 - t) * 2;
    panel.frame.material.color.copy(tmpColor.copy(original).lerp(target, up));
    panel.frame.material.opacity = 0.82 + up * 0.14;
  });
}

function clearPanelOverlays(panel) {
  for (let i = panel.overlayRoot.children.length - 1; i >= 0; i -= 1) {
    const child = panel.overlayRoot.children[i];
    if (child === panel.startRing || child === panel.startHit) continue;
    panel.overlayRoot.remove(child);
  }
  panel.markers = [];
  panel.triptych = null;
  panel.zoom = null;
  panel.reflectionHotspot = null;
}

function setPanelVisual(panel, opacity, colorMix) {
  panel.photo.material.opacity = opacity;
  panel.frame.material.opacity = 0.48;
  panel.photo.material.color.copy(tmpColor.copy(DIM_COLOR).lerp(ACTIVE_COLOR, colorMix));
}

function getPanel(index) {
  return panels.get(EXPERIENCE.scenes[index].id);
}

function normToLocal(panel, x, y) {
  return {
    x: (x - 0.5) * panel.width,
    y: (0.5 - y) * panel.height,
  };
}

function cropNormToLocal(parent, options) {
  const { crop, width, height } = parent.cropInfo;
  const localX = ((options.x - crop.x) / crop.w - 0.5) * width;
  const localY = (0.5 - (options.y - crop.y) / crop.h) * height;
  return { x: localX, y: localY };
}

function isLookingAt(object) {
  const activeCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;
  activeCamera.getWorldPosition(cameraPosition);
  activeCamera.getWorldDirection(cameraDirection);
  raycaster.set(cameraPosition, cameraDirection);
  const intersections = raycaster.intersectObject(object, true);
  return intersections.length > 0;
}

function tween(duration, onUpdate, onComplete) {
  const item = {
    elapsed: 0,
    duration: Math.max(0.001, scaled(duration)),
    onUpdate,
    onComplete,
  };
  tweens.push(item);
  return item;
}

function updateTweens(delta) {
  for (let i = tweens.length - 1; i >= 0; i -= 1) {
    const item = tweens[i];
    item.elapsed += delta;
    const t = THREE.MathUtils.clamp(item.elapsed / item.duration, 0, 1);
    item.onUpdate(easeInOutCubic(t));
    if (t >= 1) {
      tweens.splice(i, 1);
      item.onComplete?.();
    }
  }
}

function fadeInGroup(group, duration) {
  setGroupOpacity(group, 0);
  tween(duration, (t) => setGroupOpacity(group, t));
}

function setGroupOpacity(group, opacity) {
  group.traverse((child) => {
    if (!child.material) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      material.transparent = true;
      if (material.userData.baseOpacity === undefined) {
        material.userData.baseOpacity = material.opacity;
      }
      material.opacity = material.userData.baseOpacity * opacity;
    }
  });
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function wait(seconds) {
  return new Promise((resolve) => window.setTimeout(resolve, seconds * 1000));
}

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOutCubic(x) {
  return 1 - Math.pow(1 - x, 3);
}
