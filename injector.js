/* __omniUniversalLordAudioGuard: prevents duplicate audio graphs/retry loops without changing gain/settings */
(() => {
  if (globalThis.__omniUniversalLordAudioGuard) return;
  const state = { timer: null, lastRun: 0, running: false, inFlight: null };
  globalThis.__omniUniversalLordAudioGuard = state;
  globalThis.__omniUniversalLordSafeStart = (fn) => {
    const now = Date.now();
    if (state.running || now - state.lastRun < 1200) return state.inFlight;
    state.running = true;
    state.lastRun = now;
    try {
      const result = fn();
      state.inFlight = result && typeof result.then === "function" ? result : Promise.resolve(result);
      return state.inFlight;
    } catch (_) {
      return Promise.resolve(undefined);
    } finally {
      setTimeout(() => { state.running = false; }, 300);
    }
  };
  globalThis.__omniUniversalLordAutoRetry = (fn) => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => globalThis.__omniUniversalLordSafeStart(fn), 900);
  };
})();

(function () {
  'use strict';

  if (window.__OmniLordV2_loaded) return;
  window.__OmniLordV2_loaded = true;
  window.__OmniLordExtreme_loaded = true; // legacy flag compatibility
  window.__micMaxInjectorReady = true;

  const resumeCtx = () => {
    if (window.__OmniLordAudioCtx && window.__OmniLordAudioCtx.state === 'suspended') {
      window.__OmniLordAudioCtx.resume();
    }
  };
  window.addEventListener('click', resumeCtx, { once: true });
  window.addEventListener('touchstart', resumeCtx, { once: true });
  window.addEventListener('pointerdown', resumeCtx, { passive: true });
  window.addEventListener('keydown', resumeCtx);

  /* ============================ CONFIG ============================ */

  const DEFAULT_CONFIG = Object.freeze({
    clearGain: 320,
    masterGain: 3000,
    rageBoost: 2000,
    bitrate: 2500,
    stereoWidth: 1.2,
    eq1: 4, eq2: 3, eq3: 5, eq4: 6, eq5: 4, eq6: 2,
    noiseGate: 0, deEss: 0, bassBoost: 0, autoLevel: 0,
    musicBoost: 400, musicBass: 15, musicTreble: 10, musicMega: false,
    enabled: true,
    themeUrl: "",
    themeDim: 55,
    customColor: "#7cf7ff",
    turboActive: false,
    ultraTurboActive: false,
    muteActive: false,
    panelLocked: false,
    settingsLocked: false,
    collapsed: false,
    panelX: 20,
    panelY: 20,
    presetName: "custom",
    activeTab: "voice"
  });

  const currentState = Object.seal({ ...DEFAULT_CONFIG });

  const OVERLAY_PRESETS = {
    balanced: { clearGain: 160, masterGain: 900, rageBoost: 400, bitrate: 2500, stereoWidth: 1.0, noiseGate: 20, deEss: 15, bassBoost: 10, autoLevel: 20, eq1: 3, eq2: 2, eq3: 4, eq4: 5, eq5: 3, eq6: 1 },
    loud:     { clearGain: 320, masterGain: 4000, rageBoost: 3000, bitrate: 2500, stereoWidth: 1.2, noiseGate: 15, deEss: 20, bassBoost: 20, autoLevel: 30, eq1: 5, eq2: 4, eq3: 6, eq4: 7, eq5: 5, eq6: 3 },
    max:      { clearGain: 500, masterGain: 15000, rageBoost: 10000, bitrate: 2500, stereoWidth: 1.4, noiseGate: 10, deEss: 25, bassBoost: 30, autoLevel: 40, eq1: 6, eq2: 5, eq3: 7, eq4: 8, eq5: 6, eq6: 4 },
    ultra:    { clearGain: 700, masterGain: 80000, rageBoost: 60000, bitrate: 2500, stereoWidth: 1.6, noiseGate: 5, deEss: 30, bassBoost: 40, autoLevel: 50, eq1: 8, eq2: 6, eq3: 9, eq4: 10, eq5: 7, eq6: 5 },
    nuke:     { clearGain: 1000, masterGain: 200000, rageBoost: 200000, bitrate: 2500, stereoWidth: 1.8, noiseGate: 0, deEss: 10, bassBoost: 50, autoLevel: 60, eq1: 10, eq2: 8, eq3: 12, eq4: 14, eq5: 10, eq6: 8 }
  };

  const NUMERIC_RANGES = {
    clearGain: [1, 1000], masterGain: [1, 200000], rageBoost: [0, 200000],
    bitrate: [1, 2500], stereoWidth: [0, 2],
    eq1: [-24, 24], eq2: [-24, 24], eq3: [-24, 24], eq4: [-24, 24], eq5: [-24, 24], eq6: [-24, 24],
    noiseGate: [0, 100], deEss: [0, 100], bassBoost: [0, 100], autoLevel: [0, 100],
    musicBoost: [0, 5000], musicBass: [0, 100], musicTreble: [0, 100]
  };
  const clampNum = (v, [min, max]) => Math.min(max, Math.max(min, v));

  /* ==================== PERSISTENCE (hardened) ====================
     Writes go to localStorage AND sessionStorage simultaneously; if both
     are blocked, a cookie is used. Reads fall back through the same chain
     (plus the V1 legacy key). A flush is forced on tab close/refresh so a
     fast reload can never lose the last slider change. */

  const STATE_KEY = "omniLord-v2-state";
  const LEGACY_KEY = "omniLord-extreme-hybrid-state";

  function cookieGet(key) {
    try {
      const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + key + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function storageGet(key) {
    try { const v = localStorage.getItem(key); if (v) return v; } catch (e) {}
    try { const v = sessionStorage.getItem(key); if (v) return v; } catch (e) {}
    return cookieGet(key);
  }

  function storageSet(key, value) {
    let ok = false;
    try { localStorage.setItem(key, value); ok = true; } catch (e) {}
    try { sessionStorage.setItem(key, value); ok = true; } catch (e) {}
    if (!ok) {
      try { document.cookie = key + "=" + encodeURIComponent(value) + ";path=/;max-age=31536000;SameSite=Lax"; } catch (e) {}
    }
    return ok;
  }

  function parseSavedState(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (e) {}
    return null;
  }

  let saveTimer = null;
  function saveStateToLocalStorage() {
    try { storageSet(STATE_KEY, JSON.stringify(currentState)); } catch (e) {}
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; saveStateToLocalStorage(); }, 120);
  }
  const flushSave = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveStateToLocalStorage(); };
  window.addEventListener("pagehide", flushSave);
  window.addEventListener("beforeunload", flushSave);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });

  function loadStateFromLocalStorage() {
    let parsed = parseSavedState(storageGet(STATE_KEY));
    if (!parsed) parsed = parseSavedState(storageGet(LEGACY_KEY)); // V1 migration
    if (!parsed) return;
    Object.entries(NUMERIC_RANGES).forEach(([key, range]) => {
      if (typeof parsed[key] === "number" && Number.isFinite(parsed[key])) currentState[key] = clampNum(parsed[key], range);
    });
    if (typeof parsed.enabled === "boolean") currentState.enabled = parsed.enabled;
    if (typeof parsed.themeUrl === "string") currentState.themeUrl = parsed.themeUrl;
    if (typeof parsed.themeDim === "number") currentState.themeDim = clampNum(parsed.themeDim, [0, 100]);
    if (parsed.customColor) currentState.customColor = parsed.customColor;
    currentState.turboActive = Boolean(parsed.turboActive);
    currentState.ultraTurboActive = Boolean(parsed.ultraTurboActive);
    currentState.muteActive = Boolean(parsed.muteActive);
    currentState.panelLocked = Boolean(parsed.panelLocked);
    currentState.settingsLocked = Boolean(parsed.settingsLocked);
    currentState.collapsed = Boolean(parsed.collapsed);
    currentState.musicMega = Boolean(parsed.musicMega);
    if (typeof parsed.presetName === "string") currentState.presetName = parsed.presetName;
    if (typeof parsed.activeTab === "string" && ["voice", "music", "fx"].includes(parsed.activeTab)) currentState.activeTab = parsed.activeTab;
    if (typeof parsed.panelX === "number") currentState.panelX = Math.max(0, parsed.panelX);
    if (typeof parsed.panelY === "number") currentState.panelY = Math.max(0, parsed.panelY);
  }
  loadStateFromLocalStorage();

  function applyExternalConfig(config) {
    if (!config || typeof config !== "object") return;
    Object.entries(NUMERIC_RANGES).forEach(([key, range]) => {
      if (typeof config[key] === "number" && Number.isFinite(config[key])) currentState[key] = clampNum(config[key], range);
    });
    if (typeof config.turboActive === "boolean") currentState.turboActive = config.turboActive;
    if (typeof config.ultraTurboActive === "boolean") currentState.ultraTurboActive = config.ultraTurboActive;
    if (typeof config.muteActive === "boolean") currentState.muteActive = config.muteActive;
    if (typeof config.musicMega === "boolean") currentState.musicMega = config.musicMega;
    if (typeof config.enabled === "boolean") currentState.enabled = config.enabled;
    if (typeof config.themeUrl === "string") currentState.themeUrl = config.themeUrl;
    if (typeof config.themeDim === "number") currentState.themeDim = clampNum(config.themeDim, [0, 100]);
    if (typeof config.customColor === "string") currentState.customColor = config.customColor;
    if (typeof config.presetName === "string") currentState.presetName = config.presetName;
    PlayerEngine.musicBoost = currentState.musicBoost;
    PlayerEngine.musicBass = currentState.musicBass;
    PlayerEngine.musicTreble = currentState.musicTreble;
    PlayerEngine.mega = currentState.musicMega;
    PlayerEngine.applyAllMusicParams();
    saveStateToLocalStorage();
    syncStateToExtension();
    if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.applyFromState();
    AudioInterceptor.pushParamsFast();
  }

  let syncTimeout = null;
  function syncStateToExtension() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
      const snapshot = {};
      ["enabled", "clearGain", "masterGain", "rageBoost", "bitrate", "stereoWidth", "eq1", "eq2", "eq3", "eq4", "eq5", "eq6", "noiseGate", "deEss", "bassBoost", "autoLevel", "musicBoost", "musicBass", "musicTreble", "musicMega", "turboActive", "ultraTurboActive", "muteActive", "settingsLocked", "presetName"].forEach((k) => { snapshot[k] = currentState[k]; });
      window.postMessage({ source: "Omni-Universal-Lord", type: "OMNI_STATE_SYNC", state: snapshot }, "*");
    }, 300);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "Omni-Universal-Lord") return;
    if (event.data.type === "OMNI_CONFIG") applyExternalConfig(event.data.config);
    if (event.data.type === "OMNI_THEME" && typeof event.data.themeUrl === "string") {
      currentState.themeUrl = event.data.themeUrl;
      if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.applyTheme(event.data.themeUrl);
    }
    if (event.data.type === "OMNI_PLAYER_REQUEST") PlayerEngine.handleRequest(event.data);
  });

  /* ============================ AUDIO ENGINE ============================ */

  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
  let workletPromise = null;

  const workletCode = `
    class OmniLordV2Processor extends AudioWorkletProcessor {
      constructor() {
        super();
        this._prev = new Float32Array(8);
        this._gate = new Float32Array(8).fill(1);
        this._deEssEnv = 0;
        this._autoEnv = 0;
        this._bassPrev = new Float32Array(8);
        this._buf = new Float32Array(8);
      }
      static get parameterDescriptors() {
        return [
          { name: 'clearGain', defaultValue: 320, minValue: 1, maxValue: 1000 },
          { name: 'masterGain', defaultValue: 3000, minValue: 0, maxValue: 200000 },
          { name: 'rage', defaultValue: 0, minValue: 0, maxValue: 200000 },
          { name: 'bitrate', defaultValue: 2500, minValue: 1, maxValue: 2500 },
          { name: 'width', defaultValue: 1.0, minValue: 0, maxValue: 2 },
          { name: 'mute', defaultValue: 0, minValue: 0, maxValue: 1 },
          { name: 'noiseGate', defaultValue: 0, minValue: 0, maxValue: 100 },
          { name: 'deEss', defaultValue: 0, minValue: 0, maxValue: 100 },
          { name: 'bassBoost', defaultValue: 0, minValue: 0, maxValue: 100 },
          { name: 'autoLevel', defaultValue: 0, minValue: 0, maxValue: 100 }
        ];
      }
      process(inputs, outputs, params) {
        const input = inputs[0], output = outputs[0];
        if (!input || !input.length || !input[0].length) return true;
        const chN = Math.min(input.length, 8), len = input[0].length, stereo = chN >= 2;
        const buf = this._buf;
        const P = (p, i) => (p.length > 1 ? p[i] : p[0]);
        for (let i = 0; i < len; i++) {
          const g = P(params.clearGain, i), mg = P(params.masterGain, i), rg = P(params.rage, i);
          const br = P(params.bitrate, i), wd = P(params.width, i), mu = P(params.mute, i);
          const ng = P(params.noiseGate, i), de = P(params.deEss, i), bb = P(params.bassBoost, i), al = P(params.autoLevel, i);
          const mega = mg * (1 + rg / 50);
          const step = 1 / (br / 20);
          for (let ch = 0; ch < chN; ch++) {
            let s = input[ch][i];
            if (mu > 0.5) { buf[ch] = 0; continue; }
            if (ng > 0) {
              const th = ng / 100 * 0.015;
              if (Math.abs(s) > th) this._gate[ch] = Math.min(1, this._gate[ch] + 0.01);
              else this._gate[ch] = Math.max(0, this._gate[ch] - 0.08);
              s *= this._gate[ch];
            }
            if (bb > 0) {
              const amt = bb / 100;
              this._bassPrev[ch] += 0.15 * (s - this._bassPrev[ch]);
              s += this._bassPrev[ch] * amt * 2.0;
            }
            s *= g;
            if (br < 2500) s = Math.round(s / step) * step;
            s *= mega;
            s = Math.tanh(s);
            s = Math.tanh(s * 2.0) * 1.0373;
            if (de > 0) {
              const amt = de / 100;
              const hf = s - this._prev[ch];
              this._prev[ch] = s;
              this._deEssEnv = this._deEssEnv * 0.95 + Math.abs(hf) * 0.05;
              if (this._deEssEnv > 0.02) {
                const red = Math.min(0.8, (this._deEssEnv - 0.02) / 0.02 * amt);
                s *= (1.0 - red);
              }
            } else { this._prev[ch] = s; }
            if (al > 0) {
              const amt = al / 100;
              this._autoEnv = this._autoEnv * 0.995 + Math.abs(s) * 0.005;
              if (this._autoEnv > 0.001) {
                const corr = 1.0 + (0.5 - this._autoEnv) * amt;
                s *= Math.max(0.1, Math.min(3.0, corr));
              }
            }
            buf[ch] = s > 0.9999 ? 0.9999 : (s < -0.9999 ? -0.9999 : s);
          }
          if (stereo) {
            const L = buf[0], R = buf[1];
            const mid = (L + R) * 0.5, side = (L - R) * 0.5;
            buf[0] = Math.max(-0.9999, Math.min(0.9999, mid + side * wd));
            buf[1] = Math.max(-0.9999, Math.min(0.9999, mid - side * wd));
          }
          for (let ch = 0; ch < chN; ch++) output[ch][i] = buf[ch];
        }
        return true;
      }
    }
    registerProcessor('omniLord-processor', OmniLordV2Processor);
  `;

  function ensureProcessingContext() {
    if (window.__OmniLordAudioCtx && window.__OmniLordAudioCtx.state !== "closed") {
      return window.__OmniLordAudioCtx;
    }
    if (!NativeAudioContext) return null;
    let ctx;
    try {
      ctx = new NativeAudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    } catch (_) {
      ctx = new NativeAudioContext({ latencyHint: "interactive" });
    }
    window.__OmniLordAudioCtx = ctx;
    const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
    workletPromise = ctx.audioWorklet
      ? ctx.audioWorklet.addModule(blobUrl)
        .then(() => {
          URL.revokeObjectURL(blobUrl);
          if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus("OMNI V2 DSP ONLINE");
          return true;
        })
        .catch(() => {
          URL.revokeObjectURL(blobUrl);
          if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus("WORKLET FAIL");
          return false;
        })
      : Promise.resolve(false);
    return ctx;
  }
  ensureProcessingContext();

  function forceStereoOpusSDP(sdp) {
    if (!sdp) return sdp;
    const match = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
    if (!match) return sdp;
    const payloadType = match[1];
    const fmtpRegex = new RegExp(`a=fmtp:${payloadType} [^\\r\\n]+`);
    const customFmtp = `a=fmtp:${payloadType} minptime=10;useinbandfec=1;usedtx=0;stereo=1;maxaveragebitrate=510000;maxplaybackrate=48000;sprop-maxcapturerate=48000;cbr=1`;
    if (fmtpRegex.test(sdp)) {
      sdp = sdp.replace(fmtpRegex, customFmtp);
    } else {
      sdp = sdp.replace(new RegExp(`(a=rtpmap:${payloadType} opus\\/48000\\/2)`), `$1\r\n${customFmtp}`);
    }
    return sdp.replace(/b=AS:\d+/g, "b=AS:510");
  }

  function wantsAudio(constraints) {
    if (constraints === true) return true;
    if (!constraints || typeof constraints !== "object") return false;
    return Boolean(constraints.audio);
  }

  const AudioInterceptor = {
    chains: [],
    pushScheduled: false,
    interceptInFlight: 0,

    async intercept(mediaStream) {
      this.interceptInFlight += 1;
      const audioTracks = mediaStream && typeof mediaStream.getAudioTracks === "function"
        ? mediaStream.getAudioTracks()
        : [];
      const sourceIds = audioTracks.map((t) => t.id).join(",");
      const alreadyProcessed = audioTracks.length && audioTracks.every((track) => track.__omniLordProcessed);

      try {
        if (!currentState.enabled) return mediaStream;
        let audioCtx = ensureProcessingContext();
        if (!audioCtx) return mediaStream;
        if (audioCtx.state === "suspended") await audioCtx.resume();
        if (workletPromise) await workletPromise;
        if (!audioTracks.length || alreadyProcessed) return mediaStream;

        const existing = this.chains.find((chain) => chain.sourceIds === sourceIds);
        if (existing && existing.outStream) return existing.outStream;

        const source = audioCtx.createMediaStreamSource(mediaStream);
        const destination = audioCtx.createMediaStreamDestination();
        try { destination.channelCount = 2; } catch (_) {}

        try {
          const workletNode = new AudioWorkletNode(audioCtx, "omniLord-processor", {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 2, channelCountMode: "explicit"
          });
          const freqs = [100, 250, 1000, 3000, 6000, 12000];
          const types = ["lowshelf", "peaking", "peaking", "peaking", "peaking", "highshelf"];
          const eqNodes = freqs.map((freq, i) => {
            const filter = audioCtx.createBiquadFilter();
            filter.type = types[i];
            filter.frequency.value = freq;
            return filter;
          });
          const analyserNode = audioCtx.createAnalyser();
          const mixGain = audioCtx.createGain();
          mixGain.gain.value = 1;
          analyserNode.fftSize = 512;
          source.connect(workletNode);
          let lastNode = workletNode;
          for (const eqNode of eqNodes) {
            lastNode.connect(eqNode);
            lastNode = eqNode;
          }
          lastNode.connect(mixGain);
          mixGain.connect(analyserNode);
          analyserNode.connect(destination);

          destination.stream.getAudioTracks().forEach((track) => {
            track.__omniLordProcessed = true;
            track.__omniLordSourceTrackIds = sourceIds;
          });

          const outStream = new MediaStream([
            ...destination.stream.getAudioTracks(),
            ...mediaStream.getTracks().filter((track) => track.kind !== "audio")
          ]);

          const chain = { source, workletNode, eqNodes, analyserNode, mixGain, destination, sourceTracks: audioTracks, sourceIds, outStream, sender: null };
          this.chains.push(chain);
          window.__OmniLordAnalyser = analyserNode;

          PlayerEngine.connectToChain(chain);

          const cleanupChain = () => this.cleanupChain(chain);
          audioTracks.forEach((track) => track.addEventListener?.("ended", cleanupChain, { once: true }));
          this.pushParamsFast();
          return outStream;
        } catch (err) {
          try {
            const fallbackSource = audioCtx.createMediaStreamSource(mediaStream);
            const fallbackMix = audioCtx.createGain();
            const fallbackDestination = audioCtx.createMediaStreamDestination();
            fallbackMix.gain.value = 1;
            fallbackSource.connect(fallbackMix);
            fallbackMix.connect(fallbackDestination);
            fallbackDestination.stream.getAudioTracks().forEach((track) => {
              track.__omniLordProcessed = true;
              track.__omniLordSourceTrackIds = sourceIds;
            });
            const fallbackStream = new MediaStream([
              ...fallbackDestination.stream.getAudioTracks(),
              ...mediaStream.getTracks().filter((track) => track.kind !== "audio")
            ]);
            const fallbackChain = { source: fallbackSource, workletNode: null, eqNodes: [], analyserNode: null, mixGain: fallbackMix, destination: fallbackDestination, sourceTracks: audioTracks, sourceIds, outStream: fallbackStream, sender: null };
            this.chains.push(fallbackChain);
            PlayerEngine.connectToChain(fallbackChain);
            const cleanup = () => this.cleanupChain(fallbackChain);
            audioTracks.forEach((track) => track.addEventListener?.("ended", cleanup, { once: true }));
            if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus("CALL MIXER ACTIVE");
            return fallbackStream;
          } catch (_) {
            if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus("FALLBACK MIC");
            return mediaStream;
          }
        }
      } finally {
        this.interceptInFlight -= 1;
      }
    },

    cleanupChain(chain) {
      try { chain.source?.disconnect(); } catch (e) {}
      try { chain.workletNode?.disconnect(); } catch (e) {}
      try { chain.eqNodes?.forEach((n) => n.disconnect()); } catch (e) {}
      try { chain.analyserNode?.disconnect(); } catch (e) {}
      try { chain.mixGain?.disconnect(); } catch (e) {}
      try { PlayerEngine.disconnectFromChain(chain); } catch (e) {}
      if (!this.chains.filter((item) => item !== chain).length) PlayerEngine.handleCallEnded();
      this.chains = this.chains.filter((item) => item !== chain);
      window.__OmniLordAnalyser = this.chains.at(-1)?.analyserNode || null;
    },

    schedulePushParams() {
      if (this.pushScheduled) return;
      this.pushScheduled = true;
      requestAnimationFrame(() => {
        this.pushScheduled = false;
        this.pushParamsFast();
      });
    },

    pushParamsFast() {
      if (!this.chains.length || !window.__OmniLordAudioCtx) return;

      const now = window.__OmniLordAudioCtx.currentTime;
      const cGain = currentState.clearGain;
      const mGain = currentState.ultraTurboActive ? 200000 : (currentState.turboActive ? 100000 : currentState.masterGain);
      const rage = currentState.ultraTurboActive ? 200000 : (currentState.turboActive ? 100000 : currentState.rageBoost);

      let statusMsg = "OMNI V2 MAX LOUDNESS";
      if (currentState.muteActive) statusMsg = "MUTED";
      else if (currentState.settingsLocked) statusMsg = "LOCKED — " + statusMsg;
      else if (currentState.ultraTurboActive) statusMsg = "ULTRA TURBO — CEILING LOUD";
      else if (currentState.turboActive) statusMsg = "TURBO — EXTREME LOUD";

      for (const chain of this.chains) {
        if (!chain.workletNode) continue;
        const params = chain.workletNode.parameters;
        params.get("clearGain").setValueAtTime(cGain, now);
        params.get("masterGain").setValueAtTime(mGain, now);
        params.get("rage").setValueAtTime(rage, now);
        params.get("bitrate").setValueAtTime(currentState.bitrate, now);
        params.get("width").setValueAtTime(currentState.stereoWidth, now);
        params.get("mute").setValueAtTime(currentState.muteActive ? 1 : 0, now);
        params.get("noiseGate").setValueAtTime(currentState.noiseGate, now);
        params.get("deEss").setValueAtTime(currentState.deEss, now);
        params.get("bassBoost").setValueAtTime(currentState.bassBoost, now);
        params.get("autoLevel").setValueAtTime(currentState.autoLevel, now);
        if (chain.eqNodes.length === 6) {
          for (let i = 0; i < 6; i++) {
            chain.eqNodes[i].gain.setValueAtTime(currentState[`eq${i + 1}`], now);
          }
        }
      }

      if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus(statusMsg);
    },

    async processTrack(track, stream) {
      if (!track || track.kind !== "audio" || track.__omniLordProcessed) return track;
      const processedStream = await this.intercept(stream || new MediaStream([track]));
      return processedStream.getAudioTracks()[0] || track;
    }
  };

  /* ============================ MUSIC PLAYER ============================ */

  const PlayerEngine = {
    library: [], currentIndex: -1, audioEl: null, sourceNode: null,
    transmitGain: null, monitorGain: null,
    musicPreGain: null, musicBassFilter: null, musicTrebleFilter: null, musicPresence: null,
    musicSoftClip: null, musicLimiter: null, musicMakeup: null,
    musicBoost: currentState.musicBoost, musicBass: currentState.musicBass, musicTreble: currentState.musicTreble,
    mega: currentState.musicMega,
    playing: false, monitoring: true, resumeWhenCallStarts: false,
    objectUrls: new Map(), connectedChains: new WeakSet(),

    init() {
      this.audioEl = new Audio();
      this.audioEl.preload = "auto";
      this.audioEl.addEventListener("timeupdate", () => this.broadcastState());
      this.audioEl.addEventListener("play", () => { this.playing = true; this.broadcastState(); });
      this.audioEl.addEventListener("pause", () => { this.playing = false; this.broadcastState(); });
      this.audioEl.addEventListener("ended", () => { this.stop(); this.next(true); });
      this.audioEl.addEventListener("loadedmetadata", () => this.broadcastState());
      this.audioEl.addEventListener("error", () => this.broadcastState());
    },

    makeClipCurve(amount) {
      const n = 2048, curve = new Float32Array(n);
      const norm = 1 / Math.tanh(amount);
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * amount) * norm;
      }
      return curve;
    },

    ensureNodes() {
      const ctx = ensureProcessingContext();
      if (!ctx) return null;
      if (!this.sourceNode) {
        try {
          this.sourceNode = ctx.createMediaElementSource(this.audioEl);
          this.musicPreGain = ctx.createGain();
          this.musicBassFilter = ctx.createBiquadFilter();
          this.musicBassFilter.type = "lowshelf";
          this.musicBassFilter.frequency.value = 150;
          this.musicTrebleFilter = ctx.createBiquadFilter();
          this.musicTrebleFilter.type = "highshelf";
          this.musicTrebleFilter.frequency.value = 9000;
          this.musicPresence = ctx.createBiquadFilter();
          this.musicPresence.type = "peaking";
          this.musicPresence.frequency.value = 2800;
          this.musicPresence.Q.value = 0.9;
          this.musicPresence.gain.value = 2;
          this.musicSoftClip = ctx.createWaveShaper();
          this.musicSoftClip.oversample = "4x";
          this.musicSoftClip.curve = this.makeClipCurve(this.mega ? 6 : 2.2);
          this.musicLimiter = ctx.createDynamicsCompressor();
          this.musicLimiter.threshold.value = -2;
          this.musicLimiter.knee.value = 0;
          this.musicLimiter.ratio.value = 20;
          this.musicLimiter.attack.value = 0.002;
          this.musicLimiter.release.value = 0.12;
          this.musicMakeup = ctx.createGain();
          this.musicMakeup.gain.value = this.mega ? 1.8 : 1.3;
          this.transmitGain = ctx.createGain();
          this.monitorGain = ctx.createGain();
          this.transmitGain.gain.value = 1;
          this.monitorGain.gain.value = this.monitoring ? 1 : 0;

          this.sourceNode.connect(this.musicPreGain);
          this.musicPreGain.connect(this.musicBassFilter);
          this.musicBassFilter.connect(this.musicTrebleFilter);
          this.musicTrebleFilter.connect(this.musicPresence);
          this.musicPresence.connect(this.musicSoftClip);
          this.musicSoftClip.connect(this.musicLimiter);
          this.musicLimiter.connect(this.musicMakeup);
          this.musicMakeup.connect(this.transmitGain);
          this.musicMakeup.connect(this.monitorGain);
          this.monitorGain.connect(ctx.destination);
          this.applyAllMusicParams();
        } catch (_) { return null; }
      }
      return ctx;
    },

    applyAllMusicParams() {
      const ctx = ensureProcessingContext();
      if (!ctx) return;
      const t = ctx.currentTime;
      if (this.musicPreGain) this.musicPreGain.gain.setTargetAtTime(Math.max(0, this.musicBoost / 100), t, 0.01);
      if (this.musicBassFilter) this.musicBassFilter.gain.setTargetAtTime(this.musicBass * 0.18, t, 0.01);
      if (this.musicTrebleFilter) this.musicTrebleFilter.gain.setTargetAtTime(this.musicTreble * 0.15, t, 0.01);
      if (this.musicMakeup) this.musicMakeup.gain.setTargetAtTime(this.mega ? 1.8 : 1.3, t, 0.01);
      if (this.musicSoftClip) this.musicSoftClip.curve = this.makeClipCurve(this.mega ? 6 : 2.2);
      if (this.monitorGain) this.monitorGain.gain.setTargetAtTime(this.monitoring ? 1 : 0, t, 0.01);
    },

    connectToChain(chain) {
      if (!this.transmitGain || !chain || !chain.mixGain || this.connectedChains.has(chain)) return;
      try {
        this.transmitGain.connect(chain.mixGain);
        this.connectedChains.add(chain);
        if (this.resumeWhenCallStarts) {
          this.resumeWhenCallStarts = false;
          this.play();
        }
      } catch (_) {}
    },
    connectToAllChains() { AudioInterceptor.chains.forEach((chain) => this.connectToChain(chain)); },
    disconnectFromChain(chain) {
      if (!this.connectedChains.has(chain) || !this.transmitGain) return;
      try { this.transmitGain.disconnect(chain.mixGain); } catch (_) {}
      this.connectedChains.delete(chain);
    },

    handleRequest(req) {
      const action = req.action;
      if (action === "upload") this.addTrack(req.item, req.data);
      else if (action === "remove") this.removeTrack(req.id);
      else if (action === "select") this.select(req.id);
      else if (action === "play") this.play(req.id);
      else if (action === "restorePlay") this.restoreForCall(req.id);
      else if (action === "pause") this.pause();
      else if (action === "stop") this.stop();
      else if (action === "monitor") this.setMonitoring(Boolean(req.value));
      else if (action === "musicGain" || action === "musicBoost") this.setMusicBoost(req.value);
      else if (action === "musicBass") this.setMusicBass(req.value);
      else if (action === "musicTreble") this.setMusicTreble(req.value);
      else if (action === "mega") this.setMega(req.value);
      else if (action === "next") this.next();
      else if (action === "previous") this.previous();
      else if (action === "seek") this.seek(req.value);
      else if (action === "seekTime") this.seekTime(req.value);
      this.broadcastState();
    },

    addTrack(item, data) {
      if (!item || !item.id || !data) return;
      const oldUrl = this.objectUrls.get(item.id);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      const bytes = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
      const url = URL.createObjectURL(new Blob([bytes], { type: item.type || "audio/*" }));
      this.objectUrls.set(item.id, url);
      const track = { id: item.id, name: item.name || "Untitled track", artwork: item.artwork || "", url };
      const index = this.library.findIndex((entry) => entry.id === item.id);
      const wasCurrent = index === this.currentIndex;
      if (index >= 0) this.library.splice(index, 1, track); else this.library.push(track);
      if (this.currentIndex < 0) { this.currentIndex = 0; this.loadCurrent(); }
      else if (wasCurrent) { const resumeAt = this.audioEl.currentTime || 0; this.loadCurrent(resumeAt); }
    },
    removeTrack(id) {
      const index = this.library.findIndex((track) => track.id === id);
      if (index < 0) return;
      const wasCurrent = index === this.currentIndex;
      const url = this.objectUrls.get(id); if (url) URL.revokeObjectURL(url);
      this.objectUrls.delete(id); this.library.splice(index, 1);
      if (!this.library.length) { this.currentIndex = -1; this.stop(); this.audioEl.removeAttribute("src"); this.audioEl.load(); return; }
      if (wasCurrent) { this.currentIndex = Math.min(index, this.library.length - 1); this.loadCurrent(); }
      else if (index < this.currentIndex) this.currentIndex -= 1;
    },
    select(id) {
      const index = this.library.findIndex((track) => track.id === id);
      if (index < 0 || index === this.currentIndex) return;
      const shouldPlay = this.playing;
      this.audioEl.pause(); this.currentIndex = index; this.loadCurrent();
      if (shouldPlay) this.play();
    },
    loadCurrent(resumeAt) {
      const track = this.library[this.currentIndex]; if (!track) return;
      this.audioEl.src = track.url; this.audioEl.load();
      if (Number.isFinite(resumeAt) && resumeAt > 0) this.audioEl.addEventListener("loadedmetadata", () => { this.audioEl.currentTime = Math.min(resumeAt, this.audioEl.duration || resumeAt); }, { once: true });
    },
    async play(id) {
      const ctx = this.ensureNodes(); if (ctx?.state === "suspended") await ctx.resume();
      if (id) {
        const idx = this.library.findIndex((track) => track.id === id);
        if (idx >= 0 && idx !== this.currentIndex) this.select(id);
      }
      if (this.currentIndex < 0 && this.library.length) { this.currentIndex = 0; this.loadCurrent(); }
      if (this.currentIndex < 0) return;
      this.connectToAllChains();
      try { await this.audioEl.play(); } catch (_) {}
    },
    restoreForCall(id) {
      if (id) this.select(id);
      this.ensureNodes();
      this.connectToAllChains();
      if (AudioInterceptor.chains.length) this.play();
      else this.resumeWhenCallStarts = true;
    },
    pause() { this.resumeWhenCallStarts = false; this.audioEl.pause(); },
    stop() { this.audioEl.pause(); try { this.audioEl.currentTime = 0; } catch (_) {} this.playing = false; this.broadcastState(); },
    next(fromEnded) {
      if (!this.library.length) return;
      const shouldPlay = fromEnded || this.playing;
      this.audioEl.pause(); this.currentIndex = (this.currentIndex + 1) % this.library.length; this.loadCurrent();
      if (shouldPlay) this.play();
    },
    previous() {
      if (!this.library.length) return;
      const shouldPlay = this.playing;
      this.audioEl.pause(); this.currentIndex = (this.currentIndex - 1 + this.library.length) % this.library.length; this.loadCurrent();
      if (shouldPlay) this.play();
    },
    seek(fraction) { if (Number.isFinite(this.audioEl.duration)) this.audioEl.currentTime = Math.max(0, Math.min(1, fraction)) * this.audioEl.duration; },
    seekTime(seconds) {
      const apply = () => { this.audioEl.currentTime = Math.max(0, Math.min(Number(seconds) || 0, this.audioEl.duration || Number(seconds) || 0)); };
      if (Number.isFinite(this.audioEl.duration)) apply();
      else this.audioEl.addEventListener("loadedmetadata", apply, { once: true });
    },
    handleCallEnded() {
      if (this.playing) this.audioEl.pause();
      this.broadcastState();
    },
    setMusicBoost(percent) {
      this.musicBoost = Math.max(0, Math.min(5000, Number(percent) || 0));
      currentState.musicBoost = this.musicBoost;
      this.applyAllMusicParams();
    },
    setMusicBass(percent) {
      this.musicBass = Math.max(0, Math.min(100, Number(percent) || 0));
      currentState.musicBass = this.musicBass;
      this.applyAllMusicParams();
    },
    setMusicTreble(percent) {
      this.musicTreble = Math.max(0, Math.min(100, Number(percent) || 0));
      currentState.musicTreble = this.musicTreble;
      this.applyAllMusicParams();
    },
    setMega(on) {
      this.mega = Boolean(on);
      currentState.musicMega = this.mega;
      this.applyAllMusicParams();
    },
    setMonitoring(on) {
      this.monitoring = Boolean(on);
      this.applyAllMusicParams();
    },
    broadcastState() {
      const track = this.library[this.currentIndex];
      window.postMessage({ source: "Omni-Universal-Lord", type: "OMNI_PLAYER_STATE", state: {
        currentId: track ? track.id : null, playing: this.playing, currentTime: this.audioEl.currentTime || 0,
        duration: this.audioEl.duration || 0, trackCount: this.library.length, monitoring: this.monitoring,
        musicBoost: this.musicBoost, musicBass: this.musicBass, musicTreble: this.musicTreble, mega: this.mega,
        transmitting: Boolean(AudioInterceptor.chains.length && this.transmitGain)
      } }, "*");
    }
  };

  PlayerEngine.init();
  setInterval(() => { if (PlayerEngine.playing) PlayerEngine.broadcastState(); }, 1000);

  /* ============================ CALL RESILIENCE ============================ */
  // Extend the original saturated engine. The source snapshot is in original/.
  window.__OmniAudioResilience.enhance({
    AudioInterceptor, currentState, ensureProcessingContext, PlayerEngine,
    getWorkletReady: () => workletPromise
  });
  window.__OmniCallGuard.install({
    AudioInterceptor, currentState, ensureProcessingContext, wantsAudio, forceStereoOpusSDP,
    report: (message) => window.__OmniLordPanelReady?.setStatus(message)
  });

  /* ============================ UI CONTROLLER ============================ */

  const UIController = {
    bgParticles: [],

    init() {
      this.injectStyles();
      this.build();
      this.applyTheme(currentState.themeUrl);
      this.bind();
      this.enableDrag();
      this.initColorPalette();
      this.applyCustomColor(currentState.customColor || "#7cf7ff");
      this.applyFromState();
      this.setStatus(currentState.settingsLocked ? "LOCKED — SETTINGS SAVED" : "OMNI V2 MAX POWER");
      window.__OmniLordPanelReady = this;
      this.initBgParticles();
      this.startBgParticlesAnimation();
      this.startVisualizer();

      // Persisted-value re-enforcement: defeats anything that could reset the
      // inputs after build (site scripts, bfcache restores, late style passes).
      requestAnimationFrame(() => this.applyFromState());
      setTimeout(() => this.applyFromState(), 100);
      window.addEventListener("pageshow", () => this.applyFromState());
    },

    /* ---------- Collapse (panel truly shrinks + label flips MIN/MAX) ---------- */

    toggleCollapse() {
      currentState.collapsed = !currentState.collapsed;
      this.applyCollapse();
      saveStateToLocalStorage();
      syncStateToExtension();
    },

    applyCollapse() {
      const panel = document.getElementById("oul-panel");
      const body = document.getElementById("oul-body");
      const btn = document.getElementById("btn-collapse");
      if (panel) panel.classList.toggle("oul-collapsed", currentState.collapsed);
      if (body) body.style.display = currentState.collapsed ? "none" : "block";
      if (btn) {
        btn.textContent = currentState.collapsed ? "MAX" : "MIN";
        btn.title = currentState.collapsed ? "Expand panel" : "Collapse panel";
      }
      if (panel && !currentState.panelLocked) {
        const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
        const x = Math.min(Math.max(0, currentState.panelX), maxX);
        const y = Math.min(Math.max(0, currentState.panelY), maxY);
        panel.style.left = x + "px";
        panel.style.top = y + "px";
        currentState.panelX = x;
        currentState.panelY = y;
      }
    },

    /* ---------- Settings Lock (freezes sliders/presets; survives refresh) ---------- */

    toggleSettingsLock() {
      currentState.settingsLocked = !currentState.settingsLocked;
      this.applySettingsLock();
      saveStateToLocalStorage();
      syncStateToExtension();
      this.setStatus(currentState.settingsLocked ? "🔒 SETTINGS LOCKED — SAVED" : "SETTINGS UNLOCKED");
    },

    applySettingsLock() {
      const locked = Boolean(currentState.settingsLocked);
      const btn = document.getElementById("btn-setlock");
      if (btn) {
        btn.textContent = locked ? "LOCK ✓" : "LOCK";
        btn.classList.toggle("active", locked);
        btn.title = locked ? "Unlock settings" : "Lock current settings (survives refresh)";
      }
      document.querySelectorAll('#oul-panel input[type="range"][data-param]').forEach((el) => { el.disabled = locked; });
      document.querySelectorAll(".oul-preset-btn, #btn-turbo, #btn-ultra, #btn-reset").forEach((el) => { el.disabled = locked; });
    },

    showTab(name) {
      document.querySelectorAll(".oul-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
      document.querySelectorAll(".oul-tabpage").forEach((p) => { p.hidden = p.dataset.page !== name; });
    },

    resetToDefaults() {
      if (currentState.settingsLocked) return;
      ["clearGain", "masterGain", "rageBoost", "bitrate", "stereoWidth", "eq1", "eq2", "eq3", "eq4", "eq5", "eq6", "noiseGate", "deEss", "bassBoost", "autoLevel", "musicBoost", "musicBass", "musicTreble"].forEach((k) => { currentState[k] = DEFAULT_CONFIG[k]; });
      currentState.turboActive = false;
      currentState.ultraTurboActive = false;
      currentState.musicMega = false;
      currentState.presetName = "custom";
      PlayerEngine.musicBoost = currentState.musicBoost;
      PlayerEngine.musicBass = currentState.musicBass;
      PlayerEngine.musicTreble = currentState.musicTreble;
      PlayerEngine.mega = false;
      PlayerEngine.applyAllMusicParams();
      this.applyFromState();
      AudioInterceptor.pushParamsFast();
      saveStateToLocalStorage();
    },

    initBgParticles() {
      this.bgParticles = [];
      for (let i = 0; i < 40; i++) {
        this.bgParticles.push({
          x: Math.random() * 300, y: Math.random() * 560,
          r: Math.random() * 1.8 + 0.5, speed: Math.random() * 0.5 + 0.1,
          opacity: Math.random() * 0.6 + 0.2
        });
      }
    },

    startBgParticlesAnimation() {
      const canvas = document.getElementById("oul-bg-canvas");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      let lastFrame = 0;
      const renderBg = (timestamp = 0) => {
        requestAnimationFrame(renderBg);
        if (document.hidden || currentState.collapsed || timestamp - lastFrame < 50 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        lastFrame = timestamp;
        const panel = document.getElementById("oul-panel");
        if (!panel) return;
        const w = panel.offsetWidth || 300;
        const h = panel.offsetHeight || 560;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#ffffff";
        this.bgParticles.forEach((p) => {
          p.y -= p.speed;
          if (p.y < 0) p.y = h;
          ctx.globalAlpha = p.opacity;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 1.0;
      };
      renderBg();
    },

    startVisualizer() {
      const canvas = document.getElementById("oul-canvas");
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      let lastFrame = 0, dataArray;
      const render = (timestamp = 0) => {
        requestAnimationFrame(render);
        if (currentState.collapsed || document.hidden || timestamp - lastFrame < 50) return;
        lastFrame = timestamp;
        const width = canvas.offsetWidth || 280;
        const height = canvas.offsetHeight || 54;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        ctx.clearRect(0, 0, width, height);
        const analyser = window.__OmniLordAnalyser;
        if (analyser) {
          const bufferLength = analyser.frequencyBinCount;
          if (!dataArray || dataArray.length !== bufferLength) dataArray = new Uint8Array(bufferLength);
          analyser.getByteFrequencyData(dataArray);
          const barWidth = (width / bufferLength) * 2;
          let x = 0;
          for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * height;
            const grad = ctx.createLinearGradient(0, height - barHeight, 0, height);
            grad.addColorStop(0, currentState.customColor || "#7cf7ff");
            grad.addColorStop(1, "#ff4fd8");
            ctx.fillStyle = grad;
            ctx.fillRect(x, height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
          }
        } else {
          ctx.fillStyle = currentState.customColor || "#7cf7ff";
          ctx.fillRect(0, height / 2, width, 2);
        }
      };
      render();
    },

    setStatus(text) {
      const el = document.getElementById("oul-status");
      if (el) el.textContent = text;
    },

    applyTheme(themeUrl) {
      const panel = document.getElementById("oul-panel");
      if (!panel) return;
      const hasTheme = Boolean(themeUrl);
      currentState.themeUrl = hasTheme ? themeUrl : "";
      if (hasTheme) {
        panel.style.setProperty("--theme-gif", `url("${themeUrl.replace(/"/g, "")}")`);
        panel.classList.add("oul-themed");
        panel.style.setProperty("--scrim", ((1 - (currentState.themeDim ?? 55) / 100) * 0.9).toFixed(3));
      } else {
        panel.style.removeProperty("--theme-gif");
        panel.style.removeProperty("--scrim");
        panel.classList.remove("oul-themed");
      }
      const lbl = document.getElementById("lbl-themeState");
      if (lbl) lbl.textContent = hasTheme ? "ON" : "OFF";
      const dim = document.getElementById("oul-theme-dim");
      if (dim) {
        dim.value = String(currentState.themeDim ?? 55);
        const dl = document.getElementById("lbl-themeDim");
        if (dl) dl.textContent = (currentState.themeDim ?? 55) + "%";
      }
    },

    applyCustomColor(colorHex) {
      currentState.customColor = colorHex;
      const panel = document.getElementById("oul-panel");
      if (panel) {
        panel.style.setProperty("--accent", colorHex);
        panel.style.setProperty("--border", colorHex);
      }
      saveStateToLocalStorage();
    },

    initColorPalette() {
      const canvas = document.getElementById("oul-palette-canvas");
      const dot = document.getElementById("oul-color-dot");
      if (!canvas || !dot) return;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const w = canvas.width = 250;
      const h = canvas.height = 30;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "hsl(0, 100%, 50%)");
      grad.addColorStop(0.17, "hsl(60, 100%, 50%)");
      grad.addColorStop(0.33, "hsl(120, 100%, 50%)");
      grad.addColorStop(0.5, "hsl(180, 100%, 50%)");
      grad.addColorStop(0.67, "hsl(240, 100%, 50%)");
      grad.addColorStop(0.83, "hsl(300, 100%, 50%)");
      grad.addColorStop(1, "hsl(360, 100%, 50%)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      let isSelecting = false;
      const pickColor = (clientX) => {
        const rect = canvas.getBoundingClientRect();
        let x = Math.min(Math.max(0, clientX - rect.left), rect.width);
        const scaleX = w / rect.width;
        const pxX = Math.min(Math.max(0, Math.floor(x * scaleX)), w - 1);
        const pixel = ctx.getImageData(pxX, 15, 1, 1).data;
        const hex = "#" + ((1 << 24) + (pixel[0] << 16) + (pixel[1] << 8) + pixel[2]).toString(16).slice(1);
        dot.style.left = `${x}px`;
        this.applyCustomColor(hex);
      };
      const handleStart = (e) => { isSelecting = true; pickColor(e.touches ? e.touches[0].clientX : e.clientX); };
      const handleMove = (e) => { if (!isSelecting) return; if (e.cancelable) e.preventDefault(); pickColor(e.touches ? e.touches[0].clientX : e.clientX); };
      const handleEnd = () => { isSelecting = false; };
      canvas.parentElement.addEventListener("mousedown", handleStart);
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleEnd);
      canvas.parentElement.addEventListener("touchstart", handleStart, { passive: false });
      window.addEventListener("touchmove", handleMove, { passive: false });
      window.addEventListener("touchend", handleEnd);
    },

    updateValueLabel(key) {
      const lbl = document.getElementById("lbl-" + key);
      if (!lbl) return;
      let val = currentState[key];
      if (key === "clearGain" || key === "masterGain") val = Number(val).toFixed(0) + "x";
      else if (key === "rageBoost") val = val + "%";
      else if (key === "stereoWidth") val = Number(val).toFixed(2) + "x";
      else if (key.startsWith("eq")) val = (val > 0 ? "+" : "") + Number(val).toFixed(1) + "dB";
      else if (["noiseGate", "deEss", "bassBoost", "autoLevel", "musicBoost", "musicBass", "musicTreble"].includes(key)) val = val + "%";
      lbl.textContent = val;
    },

    applyFromState() {
      const panel = document.getElementById("oul-panel");
      if (panel) { panel.style.left = currentState.panelX + "px"; panel.style.top = currentState.panelY + "px"; }
      this.applyCollapse();
      this.applySettingsLock();

      const btnMute = document.getElementById("btn-mute");
      if (btnMute) { btnMute.textContent = currentState.muteActive ? "UNMUTE" : "MUTE"; btnMute.classList.toggle("active", currentState.muteActive); }
      const btnTurbo = document.getElementById("btn-turbo");
      if (btnTurbo) { btnTurbo.textContent = currentState.turboActive ? "TURBO (ON)" : "TURBO (OFF)"; btnTurbo.classList.toggle("active", currentState.turboActive); }
      const btnUltra = document.getElementById("btn-ultra");
      if (btnUltra) { btnUltra.textContent = currentState.ultraTurboActive ? "ULTRA (ON)" : "ULTRA (OFF)"; btnUltra.classList.toggle("active", currentState.ultraTurboActive); }
      const btnMega = document.getElementById("btn-mega");
      if (btnMega) { btnMega.textContent = PlayerEngine.mega ? "MEGA (ON)" : "MEGA (OFF)"; btnMega.classList.toggle("active", PlayerEngine.mega); }
      const monitor = document.getElementById("btn-monitor");
      if (monitor) { monitor.textContent = PlayerEngine.monitoring ? "PLAYBACK ON" : "PLAYBACK OFF"; }
      document.getElementById("btn-lock")?.classList.toggle("active", currentState.panelLocked);

      document.querySelectorAll(".oul-preset-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.preset === currentState.presetName);
      });

      this.showTab(currentState.activeTab || "voice");

      ["clearGain", "masterGain", "rageBoost", "bitrate", "stereoWidth", "eq1", "eq2", "eq3", "eq4", "eq5", "eq6", "noiseGate", "deEss", "bassBoost", "autoLevel", "musicBoost", "musicBass", "musicTreble"].forEach((key) => {
        const input = document.querySelector(`#oul-panel input[data-param="${key}"]`);
        if (input) input.value = String(currentState[key]);
        this.updateValueLabel(key);
      });
    },

    build() {
      const panel = document.createElement("aside");
      panel.id = "oul-panel";
      panel.innerHTML = `
        <canvas id="oul-bg-canvas"></canvas>
        <div class="oul-header" id="oul-header">
            <div class="oul-brand">
                <span class="oul-logo">◈</span>
                <span class="oul-title">OMNI UNIVERSAL LORD <b>V2</b></span>
            </div>
            <div class="oul-hdr-btns">
                <button id="btn-setlock" class="oul-icon-btn" title="Lock current settings (survives refresh)">LOCK</button>
                <button id="btn-lock" class="oul-icon-btn" title="Pin panel position">PIN</button>
                <button id="btn-collapse" class="oul-icon-btn" title="Collapse panel">MIN</button>
            </div>
        </div>

        <div id="oul-body">
            <div class="oul-visual"><canvas id="oul-canvas"></canvas></div>

            <div class="oul-bar">
                <span class="oul-dot"></span>
                <span id="oul-status">INITIALIZING</span>
            </div>

            <div class="oul-palette-box">
                <div class="oul-lbl">CUSTOM COLOR</div>
                <div class="oul-palette-container">
                    <canvas id="oul-palette-canvas"></canvas>
                    <div id="oul-color-dot"></div>
                </div>
            </div>

            <div class="oul-theme-box">
                <div class="oul-lbl">CHAT THEME (GIF/IMAGE) <span id="lbl-themeState">OFF</span></div>
                <div class="oul-theme-row">
                    <button id="btn-theme" class="oul-btn">📁 UPLOAD GIF</button>
                    <button id="btn-theme-clear" class="oul-btn reset">CLEAR</button>
                </div>
                <div class="oul-lbl" style="margin-top:6px">THEME VISIBILITY <span id="lbl-themeDim">55%</span></div>
                <input id="oul-theme-dim" type="range" min="0" max="100" step="1" value="55" style="width:100%">
                <input id="oul-theme-file" type="file" accept="image/*" style="display:none" />
            </div>

            <div class="oul-tabs">
                <button class="oul-tab active" data-tab="voice">🎤 VOICE</button>
                <button class="oul-tab" data-tab="music">🎵 MUSIC</button>
                <button class="oul-tab" data-tab="fx">🎛 FX</button>
            </div>

            <div class="oul-tabpage" data-page="voice">
                <div class="oul-field">
                    <div class="oul-lbl">VOICE GAIN <span id="lbl-clearGain">320x</span></div>
                    <input data-param="clearGain" type="range" min="1" max="1000" step="1" value="320">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">MASTER LOUDNESS <span id="lbl-masterGain">3000x</span></div>
                    <input data-param="masterGain" type="range" min="1" max="200000" step="500" value="3000">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">PRESENCE BOOST <span id="lbl-rageBoost">2000%</span></div>
                    <input data-param="rageBoost" type="range" min="0" max="200000" step="500" value="2000">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">CLARITY RATE <span id="lbl-bitrate">2500</span></div>
                    <input data-param="bitrate" type="range" min="1" max="2500" step="1" value="2500">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">STEREO WIDTH <span id="lbl-stereoWidth">1.20x</span></div>
                    <input data-param="stereoWidth" type="range" min="0" max="2" step="0.05" value="1.2">
                </div>

                <div class="oul-actions">
                    <button id="btn-ultra" class="oul-btn ultra">ULTRA (OFF)</button>
                    <button id="btn-turbo" class="oul-btn turbo">TURBO (OFF)</button>
                </div>
                <div class="oul-actions">
                    <button id="btn-mute" class="oul-btn">MUTE</button>
                    <button id="btn-reset" class="oul-btn reset">RESET</button>
                </div>
                <div class="oul-presets">
                    <button class="oul-preset-btn" data-preset="balanced">Calm</button>
                    <button class="oul-preset-btn" data-preset="loud">Loud</button>
                    <button class="oul-preset-btn" data-preset="max">Max</button>
                    <button class="oul-preset-btn" data-preset="ultra">Ultra</button>
                    <button class="oul-preset-btn nuke" data-preset="nuke">NUKE</button>
                </div>
            </div>

            <div class="oul-tabpage" data-page="music" hidden>
                <div class="oul-field">
                    <div class="oul-lbl">MUSIC VOLUME BOOSTER <span id="lbl-musicBoost">400%</span></div>
                    <input data-param="musicBoost" type="range" min="0" max="5000" step="10" value="400">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">MUSIC BASS <span id="lbl-musicBass">15%</span></div>
                    <input data-param="musicBass" type="range" min="0" max="100" step="1" value="15">
                </div>
                <div class="oul-field">
                    <div class="oul-lbl">MUSIC TREBLE <span id="lbl-musicTreble">10%</span></div>
                    <input data-param="musicTreble" type="range" min="0" max="100" step="1" value="10">
                </div>
                <div class="oul-actions">
                    <button id="btn-mega" class="oul-btn mega">MEGA (OFF)</button>
                    <button id="btn-monitor" class="oul-btn">PLAYBACK ON</button>
                </div>

                <div class="oul-player">
                    <div class="oul-lbl">CALL MUSIC LIBRARY <span id="lbl-playerTrack">0 / 30</span></div>
                    <input id="oul-audio-upload" type="file" accept="audio/*" multiple style="width:100%;font-size:10px;margin:4px 0" />
                    <div class="oul-player-controls">
                        <button id="btn-prev" class="oul-btn">PREV</button><button id="btn-play" class="oul-btn">PLAY</button><button id="btn-stop" class="oul-btn">STOP</button><button id="btn-next" class="oul-btn">NEXT</button>
                    </div>
                    <input id="oul-seek" type="range" min="0" max="1000" step="1" value="0" style="width:100%;margin-top:6px" />
                    <div class="oul-player-meta"><span id="lbl-playerTime">0:00 / 0:00</span><span id="lbl-playerStatus">Ready for call</span></div>
                    <div id="oul-track-list" role="listbox" aria-label="Uploaded songs" style="max-height:150px;overflow-y:auto;overflow-x:hidden;margin-top:6px;padding-right:3px"></div>
                </div>
            </div>

            <div class="oul-tabpage" data-page="fx" hidden>
                <div class="oul-enhanced-grid">
                    <div class="oul-field">
                        <div class="oul-lbl">NOISE GATE <span id="lbl-noiseGate">0%</span></div>
                        <input data-param="noiseGate" type="range" min="0" max="100" step="1" value="0">
                    </div>
                    <div class="oul-field">
                        <div class="oul-lbl">DE-ESSER <span id="lbl-deEss">0%</span></div>
                        <input data-param="deEss" type="range" min="0" max="100" step="1" value="0">
                    </div>
                    <div class="oul-field">
                        <div class="oul-lbl">BASS BOOST <span id="lbl-bassBoost">0%</span></div>
                        <input data-param="bassBoost" type="range" min="0" max="100" step="1" value="0">
                    </div>
                    <div class="oul-field">
                        <div class="oul-lbl">AUTO LEVEL <span id="lbl-autoLevel">0%</span></div>
                        <input data-param="autoLevel" type="range" min="0" max="100" step="1" value="0">
                    </div>
                </div>

                <div class="oul-eq-grid">
                    <div class="oul-field"><div class="oul-lbl">100Hz <span id="lbl-eq1">+4.0dB</span></div><input data-param="eq1" type="range" min="-24" max="24" step="0.5" value="4"></div>
                    <div class="oul-field"><div class="oul-lbl">250Hz <span id="lbl-eq2">+3.0dB</span></div><input data-param="eq2" type="range" min="-24" max="24" step="0.5" value="3"></div>
                    <div class="oul-field"><div class="oul-lbl">1kHz <span id="lbl-eq3">+5.0dB</span></div><input data-param="eq3" type="range" min="-24" max="24" step="0.5" value="5"></div>
                    <div class="oul-field"><div class="oul-lbl">3kHz <span id="lbl-eq4">+6.0dB</span></div><input data-param="eq4" type="range" min="-24" max="24" step="0.5" value="6"></div>
                    <div class="oul-field"><div class="oul-lbl">6kHz <span id="lbl-eq5">+4.0dB</span></div><input data-param="eq5" type="range" min="-24" max="24" step="0.5" value="4"></div>
                    <div class="oul-field"><div class="oul-lbl">12kHz <span id="lbl-eq6">+2.0dB</span></div><input data-param="eq6" type="range" min="-24" max="24" step="0.5" value="2"></div>
                </div>
            </div>
        </div>
      `;
      document.body.appendChild(panel);
    },

    bind() {
      const btnLock = document.getElementById("btn-lock");
      const btnTurbo = document.getElementById("btn-turbo");
      const btnUltra = document.getElementById("btn-ultra");
      const btnMute = document.getElementById("btn-mute");
      const btnReset = document.getElementById("btn-reset");
      const btnMega = document.getElementById("btn-mega");

      // Header buttons (MIN + LOCK) AND tab navigation via delegation on the
      // panel root: immune to any DOM/timing quirk that could break direct listeners.
      const panelRoot = document.getElementById("oul-panel");
      panelRoot.addEventListener("click", (e) => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        if (t.closest("#btn-collapse")) { this.toggleCollapse(); return; }
        if (t.closest("#btn-setlock")) { this.toggleSettingsLock(); return; }
        const tab = t.closest(".oul-tab");
        if (tab && tab.dataset.tab) {
          currentState.activeTab = tab.dataset.tab;
          this.showTab(currentState.activeTab);
          saveStateToLocalStorage();
          return;
        }
      });

      // Chat theme: upload / clear / visibility (Messenger-style clear GIF)
      const themeBtn = document.getElementById("btn-theme");
      const themeClear = document.getElementById("btn-theme-clear");
      const themeFile = document.getElementById("oul-theme-file");
      const themeDim = document.getElementById("oul-theme-dim");
      if (themeBtn && themeFile) {
        themeBtn.addEventListener("click", () => themeFile.click());
        themeFile.addEventListener("change", () => {
          const file = themeFile.files && themeFile.files[0];
          themeFile.value = "";
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            currentState.themeUrl = String(reader.result || "");
            this.applyTheme(currentState.themeUrl);
            saveStateToLocalStorage();
            this.setStatus("CHAT THEME APPLIED");
          };
          reader.readAsDataURL(file);
        });
      }
      if (themeClear) themeClear.addEventListener("click", () => {
        currentState.themeUrl = "";
        this.applyTheme("");
        saveStateToLocalStorage();
        this.setStatus("CHAT THEME CLEARED");
      });
      if (themeDim) themeDim.addEventListener("input", () => {
        currentState.themeDim = parseInt(themeDim.value, 10) || 0;
        const dl = document.getElementById("lbl-themeDim");
        if (dl) dl.textContent = currentState.themeDim + "%";
        const panelEl = document.getElementById("oul-panel");
        if (panelEl && currentState.themeUrl) {
          panelEl.style.setProperty("--scrim", ((1 - currentState.themeDim / 100) * 0.9).toFixed(3));
        }
        saveStateToLocalStorage();
      });

      btnLock.addEventListener("click", () => {
        currentState.panelLocked = !currentState.panelLocked;
        btnLock.classList.toggle("active", currentState.panelLocked);
        saveStateToLocalStorage();
        syncStateToExtension();
      });

      btnUltra.addEventListener("click", () => {
        if (currentState.settingsLocked) return;
        currentState.ultraTurboActive = !currentState.ultraTurboActive;
        if (currentState.ultraTurboActive) currentState.turboActive = false;
        btnUltra.textContent = currentState.ultraTurboActive ? "ULTRA (ON)" : "ULTRA (OFF)";
        btnUltra.classList.toggle("active", currentState.ultraTurboActive);
        btnTurbo.textContent = "TURBO (OFF)";
        btnTurbo.classList.remove("active");
        saveStateToLocalStorage();
        syncStateToExtension();
        AudioInterceptor.pushParamsFast();
      });

      btnTurbo.addEventListener("click", () => {
        if (currentState.settingsLocked) return;
        currentState.turboActive = !currentState.turboActive;
        if (currentState.turboActive) currentState.ultraTurboActive = false;
        btnTurbo.textContent = currentState.turboActive ? "TURBO (ON)" : "TURBO (OFF)";
        btnTurbo.classList.toggle("active", currentState.turboActive);
        btnUltra.textContent = "ULTRA (OFF)";
        btnUltra.classList.remove("active");
        saveStateToLocalStorage();
        syncStateToExtension();
        AudioInterceptor.pushParamsFast();
      });

      btnMute.addEventListener("click", () => {
        currentState.muteActive = !currentState.muteActive;
        btnMute.textContent = currentState.muteActive ? "UNMUTE" : "MUTE";
        btnMute.classList.toggle("active", currentState.muteActive);
        saveStateToLocalStorage();
        syncStateToExtension();
        AudioInterceptor.pushParamsFast();
      });

      btnMega.addEventListener("click", () => {
        PlayerEngine.setMega(!PlayerEngine.mega);
        btnMega.textContent = PlayerEngine.mega ? "MEGA (ON)" : "MEGA (OFF)";
        btnMega.classList.toggle("active", PlayerEngine.mega);
        saveStateToLocalStorage();
        syncStateToExtension();
      });

      btnReset.addEventListener("click", () => { this.resetToDefaults(); syncStateToExtension(); });

      document.querySelectorAll(".oul-preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (currentState.settingsLocked) return;
          const preset = OVERLAY_PRESETS[btn.dataset.preset];
          if (!preset) return;
          Object.keys(preset).forEach((k) => { currentState[k] = preset[k]; });
          currentState.presetName = btn.dataset.preset;
          this.applyFromState();
          AudioInterceptor.pushParamsFast();
          saveStateToLocalStorage();
          syncStateToExtension();
        });
      });

      const btnPlay = document.getElementById("btn-play");
      const btnPrev = document.getElementById("btn-prev");
      const btnNext = document.getElementById("btn-next");
      const seekBar = document.getElementById("oul-seek");
      if (btnPlay) btnPlay.addEventListener("click", () => { if (PlayerEngine.playing) PlayerEngine.pause(); else PlayerEngine.play(); });
      if (btnPrev) btnPrev.addEventListener("click", () => PlayerEngine.previous());
      if (btnNext) btnNext.addEventListener("click", () => PlayerEngine.next());
      if (seekBar) seekBar.addEventListener("change", () => PlayerEngine.seek(Number(seekBar.value) / 1000));
      const upload = document.getElementById("oul-audio-upload");
      const list = document.getElementById("oul-track-list");
      const monitor = document.getElementById("btn-monitor");
      const refreshTracks = () => {
        if (!list) return;
        document.getElementById("lbl-playerTrack").textContent = PlayerEngine.library.length + " / 30";
        list.innerHTML = "";
        PlayerEngine.library.forEach((track, index) => {
          const row = document.createElement("button"); row.className = "oul-btn oul-track-row";
          row.textContent = (index === PlayerEngine.currentIndex ? "▶ " : "  ") + track.name;
          row.onclick = () => { PlayerEngine.select(track.id); refreshTracks(); };
          list.appendChild(row);
        });
      };
      if (upload) upload.addEventListener("change", async () => {
        const slots = Math.max(0, 30 - PlayerEngine.library.length);
        for (const file of Array.from(upload.files || []).slice(0, slots)) {
          const data = Array.from(new Uint8Array(await file.arrayBuffer()));
          PlayerEngine.addTrack({ id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random(), name: file.name, type: file.type }, data);
        }
        upload.value = ""; refreshTracks();
      });
      if (monitor) monitor.addEventListener("click", () => {
        PlayerEngine.setMonitoring(!PlayerEngine.monitoring);
        monitor.textContent = PlayerEngine.monitoring ? "PLAYBACK ON" : "PLAYBACK OFF";
        saveStateToLocalStorage();
      });
      const stop = document.getElementById("btn-stop"); if (stop) stop.addEventListener("click", () => PlayerEngine.stop());
      refreshTracks();

      window.addEventListener("message", (event) => {
        if (event.source !== window || event.data?.source !== "Omni-Universal-Lord") return;
        if (event.data.type === "OMNI_PLAYER_STATE") {
          const s = event.data.state;
          const timeEl = document.getElementById("lbl-playerTime");
          const statusEl = document.getElementById("lbl-playerStatus");
          const playBtn = document.getElementById("btn-play");
          if (playBtn) playBtn.textContent = s.playing ? "PAUSE" : "PLAY";
          if (timeEl) {
            const fmt = (v) => { if (!Number.isFinite(v) || v < 0) return "0:00"; return Math.floor(v / 60) + ":" + String(Math.floor(v % 60)).padStart(2, "0"); };
            timeEl.textContent = fmt(s.currentTime) + " / " + fmt(s.duration);
          }
          if (statusEl) statusEl.textContent = s.playing ? (s.transmitting ? "▶ LIVE IN CALL" : "▶ PLAYING") : (s.currentId ? "Paused" : "Ready for call");
          if (seekBar && document.activeElement !== seekBar && s.duration > 0) {
            seekBar.value = String(Math.round((s.currentTime / s.duration) * 1000));
          }
        }
      });

      document.querySelectorAll('#oul-panel input[type="range"][data-param]').forEach((input) => {
        const preventScroll = (e) => e.stopPropagation();
        input.addEventListener("touchstart", preventScroll, { passive: true });
        input.addEventListener("touchmove", preventScroll, { passive: true });
        const updateVal = (e) => {
          const param = e.target.dataset.param;
          if (currentState.settingsLocked) {
            e.target.value = String(currentState[param]);
            this.updateValueLabel(param);
            return;
          }
          const val = parseFloat(e.target.value);
          currentState[param] = val;
          currentState.presetName = "custom";
          if (param === "musicBoost") PlayerEngine.setMusicBoost(val);
          else if (param === "musicBass") PlayerEngine.setMusicBass(val);
          else if (param === "musicTreble") PlayerEngine.setMusicTreble(val);
          else AudioInterceptor.schedulePushParams();
          this.updateValueLabel(param);
          scheduleSave();          // instant persist (trailing-throttled)
          syncStateToExtension();
        };
        input.addEventListener("input", updateVal);
        input.addEventListener("change", updateVal);
      });
    },

    enableDrag() {
      const panel = document.getElementById("oul-panel");
      const header = document.getElementById("oul-header");
      let isDragging = false, startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

      const onStart = (clientX, clientY, target) => {
        if (currentState.panelLocked) return;
        if (target.closest(".oul-hdr-btns") || target.tagName === "INPUT" || target.tagName === "BUTTON") return;
        isDragging = true; startX = clientX; startY = clientY;
        initialLeft = panel.offsetLeft; initialTop = panel.offsetTop;
      };
      const onMove = (clientX, clientY, e) => {
        if (!isDragging) return;
        if (e && e.cancelable) e.preventDefault();
        const dx = clientX - startX, dy = clientY - startY;
        const maxX = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxY = Math.max(0, window.innerHeight - panel.offsetHeight);
        const nextX = Math.min(Math.max(0, initialLeft + dx), maxX);
        const nextY = Math.min(Math.max(0, initialTop + dy), maxY);
        panel.style.left = nextX + "px"; panel.style.top = nextY + "px";
        currentState.panelX = nextX; currentState.panelY = nextY;
      };
      const onEnd = () => { if (isDragging) { isDragging = false; saveStateToLocalStorage(); } };

      header.addEventListener("mousedown", (e) => onStart(e.clientX, e.clientY, e.target));
      window.addEventListener("mousemove", (e) => onMove(e.clientX, e.clientY, e));
      window.addEventListener("mouseup", onEnd);
      header.addEventListener("touchstart", (e) => { if (e.touches.length === 1) onStart(e.touches[0].clientX, e.touches[0].clientY, e.target); }, { passive: false });
      window.addEventListener("touchmove", (e) => { if (isDragging && e.touches.length === 1) onMove(e.touches[0].clientX, e.touches[0].clientY, e); }, { passive: false });
      window.addEventListener("touchend", onEnd);
    },

    injectStyles() {
      const style = document.createElement("style");
      style.textContent = `
        #oul-panel {
          --accent: #7cf7ff;
          --accent2: #ff4fd8;
          --border: color-mix(in srgb, var(--accent) 55%, transparent);
          position: fixed; top: 20px; left: 20px;
          width: min(312px, calc(100vw - 16px));
          height: min(560px, calc(100vh - 16px));
          --scrim: 0.9;
          background-color: rgba(8, 11, 26, 0.92);
          background-image:
            linear-gradient(160deg, rgba(9,12,30,var(--scrim)), rgba(30,14,52,var(--scrim)) 55%, rgba(8,10,26,var(--scrim))),
            var(--theme-gif, linear-gradient(145deg, #16233a, #0a0d18));
          background-size: cover;
          background-position: center top;
          border: 1px solid var(--border);
          border-radius: 20px;
          box-shadow: 0 24px 70px rgba(0,0,0,.6), 0 0 34px color-mix(in srgb, var(--accent) 30%, transparent), inset 0 1px 0 rgba(255,255,255,.12);
          color: #fff; z-index: 2147483647;
          font-family: 'Segoe UI', system-ui, sans-serif;
          user-select: none; padding: 10px;
          backdrop-filter: blur(14px) saturate(1.35);
          overflow: hidden; touch-action: none;
          display: flex; flex-direction: column;
        }
        #oul-panel.oul-collapsed { height: auto; min-height: 0; }
        #oul-panel.oul-collapsed #oul-body { display: none !important; }
        #oul-bg-canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; border-radius: 20px; }
        #oul-panel.oul-themed { --scrim: 0.405; border-color: rgba(174, 235, 255, 0.7); }
        .oul-theme-box { margin-bottom: 10px; }
        .oul-theme-row { display: flex; gap: 6px; margin-top: 4px; }
        .oul-theme-row .oul-btn { padding: 6px 0; font-size: 9.5px; }
        .oul-header, #oul-body { position: relative; z-index: 1; }
        .oul-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,.1); padding-bottom: 8px; cursor: move; touch-action: none; }
        .oul-brand { display: flex; align-items: center; gap: 7px; }
        .oul-logo { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; font-size: 13px; color: #000; background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 60%, transparent); font-weight: 900; }
        .oul-title { font-size: 13px; font-weight: 800; letter-spacing: .4px; background: linear-gradient(90deg, var(--accent), #ffffff 55%, var(--accent2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
        .oul-title b { -webkit-text-fill-color: var(--accent2); }
        .oul-hdr-btns { display: flex; gap: 4px; }
        .oul-icon-btn { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); cursor: pointer; font-size: 9px; font-weight: 700; opacity: .85; color: #fff; padding: 3px 7px; border-radius: 8px; transition: .2s; white-space: nowrap; }
        .oul-icon-btn:hover { opacity: 1; border-color: var(--accent); }
        .oul-icon-btn.active { opacity: 1; background: var(--accent); color: #000; border-color: var(--accent); }
        #oul-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 4px 10px 0; scrollbar-width: thin; scrollbar-color: var(--accent) transparent; }
        #oul-body::-webkit-scrollbar, #oul-track-list::-webkit-scrollbar { width: 6px; }
        #oul-body::-webkit-scrollbar-track, #oul-track-list::-webkit-scrollbar-track { background: rgba(255,255,255,.04); border-radius: 99px; }
        #oul-body::-webkit-scrollbar-thumb, #oul-track-list::-webkit-scrollbar-thumb { background: linear-gradient(var(--accent), var(--accent2)); border-radius: 99px; }
        .oul-visual { height: 54px; background: rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.09); margin: 10px 0 6px 0; border-radius: 14px; overflow: hidden; position: relative; box-shadow: inset 0 0 18px rgba(0,0,0,.5); }
        #oul-canvas { width: 100%; height: 100%; display: block; }
        .oul-bar { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--accent); margin-bottom: 8px; font-weight: bold; letter-spacing: .5px; }
        .oul-dot { width: 7px; height: 7px; background: var(--accent); border-radius: 50%; box-shadow: 0 0 6px var(--accent); animation: oul-pulse 1.6s infinite; }
        @keyframes oul-pulse { 0%, 100% { box-shadow: 0 0 5px var(--accent); } 50% { box-shadow: 0 0 14px var(--accent); } }
        .oul-palette-box { margin-bottom: 10px; }
        .oul-palette-container { position: relative; height: 16px; border-radius: 8px; overflow: visible; margin-top: 4px; cursor: pointer; touch-action: none; }
        #oul-palette-canvas { width: 100%; height: 100%; border-radius: 8px; display: block; }
        #oul-color-dot { position: absolute; top: 50%; left: 10px; transform: translate(-50%, -50%); width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 2px solid #000; box-shadow: 0 0 6px #fff; pointer-events: none; }
        .oul-tabs { display: flex; gap: 4px; margin: 4px 0 8px 0; }
        .oul-tab { flex: 1; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); color: #9fb0c8; font-size: 10px; font-weight: 800; padding: 7px 0; border-radius: 11px; cursor: pointer; transition: .2s; letter-spacing: .4px; }
        .oul-tab:hover { color: #fff; border-color: var(--border); }
        .oul-tab.active { background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--accent2))); color: #000; border-color: var(--accent); box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 55%, transparent); }
        .oul-tabpage { animation: oul-fadein .25s ease; }
        @keyframes oul-fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .oul-field { margin-bottom: 7px; }
        .oul-lbl { display: flex; justify-content: space-between; font-size: 10px; color: #c3ccdd; margin-bottom: 3px; font-weight: 700; letter-spacing: .3px; }
        .oul-lbl span { color: var(--accent); text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent); }
        #oul-panel input[type="range"] { -webkit-appearance: none; appearance: none; width: 100%; height: 7px; background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 30%, transparent), color-mix(in srgb, var(--accent2) 30%, transparent)); border-radius: 999px; outline: none; cursor: pointer; touch-action: none; border: 1px solid rgba(255,255,255,.07); }
        #oul-panel input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 17px; height: 17px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff, var(--accent)); cursor: pointer; box-shadow: 0 0 10px var(--accent); border: 1px solid rgba(0,0,0,.35); transition: transform .15s; }
        #oul-panel input[type="range"]::-webkit-slider-thumb:hover { transform: scale(1.15); }
        #oul-panel input[type="range"]:disabled { opacity: .4; cursor: not-allowed; }
        #oul-panel input[type="range"]:disabled::-webkit-slider-thumb { background: #8b98a9; box-shadow: none; transform: none; }
        #oul-panel .oul-btn:disabled, #oul-panel .oul-preset-btn:disabled { opacity: .4; cursor: not-allowed; box-shadow: none !important; background: rgba(255,255,255,.03) !important; color: #7f8fa4 !important; border-color: rgba(255,255,255,.08) !important; }
        .oul-actions { display: flex; gap: 6px; margin-top: 8px; }
        .oul-btn { flex: 1; background: rgba(255,255,255,.04); border: 1px solid var(--border); color: var(--accent); font-weight: 800; font-size: 10.5px; padding: 8px 0; border-radius: 12px; cursor: pointer; transition: .2s; letter-spacing: .3px; }
        .oul-btn:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
        .oul-btn.active { background: var(--accent); color: #000; box-shadow: 0 0 12px var(--accent); }
        .oul-btn.ultra.active { background: linear-gradient(135deg, #ff4fd8, #b429ff); border-color: #ff4fd8; color: #fff; box-shadow: 0 0 16px #ff4fd8; }
        .oul-btn.turbo.active { background: linear-gradient(135deg, #ffaa00, #ff6a00); border-color: #ffaa00; color: #000; box-shadow: 0 0 14px #ffaa00; }
        .oul-btn.mega.active { background: linear-gradient(135deg, #ff3355, #ff0066); border-color: #ff3355; color: #fff; box-shadow: 0 0 16px #ff3355; }
        .oul-btn.reset:hover { border-color: #ff5555; color: #ff8080; }
        .oul-presets { display: flex; gap: 4px; margin-top: 10px; }
        .oul-preset-btn { flex: 1; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.12); color: var(--accent); font-size: 9px; font-weight: 800; padding: 6px 0; border-radius: 9px; cursor: pointer; transition: .2s; }
        .oul-preset-btn:hover { background: rgba(124,247,255,.12); }
        .oul-preset-btn.active { background: var(--accent); color: #000; border-color: var(--accent); box-shadow: 0 0 10px var(--accent); }
        .oul-preset-btn.nuke { color: #ff5577; border-color: rgba(255,85,119,.4); }
        .oul-preset-btn.nuke.active { background: linear-gradient(135deg, #ff3355, #ff0066); color: #fff; border-color: #ff3355; box-shadow: 0 0 14px #ff3355; }
        .oul-enhanced-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; padding-top: 2px; }
        .oul-eq-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; border-top: 1px dashed var(--border); padding-top: 10px; margin-top: 8px; }
        .oul-player { margin-top: 10px; border-top: 1px dashed var(--border); padding-top: 10px; }
        .oul-player-controls { display: flex; gap: 5px; margin-top: 6px; }
        .oul-player-controls .oul-btn { flex: 1; }
        .oul-track-row { display: block; width: 100%; min-height: 30px; margin: 3px 0; text-align: left; padding: 6px 8px !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px !important; }
        .oul-player-meta { display: flex; justify-content: space-between; font-size: 9px; color: #65788C; margin-top: 4px; }
      `;
      document.head.appendChild(style);
    }
  };

  if (window.top === window.self) {
    if (document.body) {
      UIController.init();
    } else {
      document.addEventListener("DOMContentLoaded", () => UIController.init());
    }
  }

  window.postMessage({ source: "Omni-Universal-Lord", type: "OMNI_INJECTOR_READY" }, "*");
})();
