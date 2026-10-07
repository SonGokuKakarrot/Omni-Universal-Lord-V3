/* Additive lifecycle guard for the original Omni V2 saturated DSP. */
(() => {
  'use strict';
  if (window.__OmniAudioResilience) return;

  function bounded(promise, ms, fallback) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })
    ]).finally(() => clearTimeout(timer));
  }

  window.__OmniAudioResilience = {
    enhance({ AudioInterceptor: engine, currentState: state, ensureProcessingContext, PlayerEngine: player, getWorkletReady }) {
      const pending = new WeakMap();
      const sources = new WeakMap();
      const outputs = new WeakMap();
      const rawMute = new WeakMap();
      const rawRecords = new Set();
      let lifecycleTimer = null;
      const ramp = (param, value, now) => {
        if (!param) return;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, 0.008);
      };
      const tell = message => {
        if (window.__OmniLordPanelReady) window.__OmniLordPanelReady.setStatus(message);
      };
      const disconnect = node => { try { node?.disconnect(); } catch (_) {} };
      const nativeStops = new WeakMap();

      function applyRawMute(record, track) {
        const enabled = record.desired && !state.muteActive;
        if (record.setter) record.setter.call(track, enabled);
        else record.value = enabled;
      }
      function trackRawMute(track) {
        if (rawMute.has(track)) return;
        let proto = track, descriptor;
        while (proto && !descriptor) {
          descriptor = Object.getOwnPropertyDescriptor(proto, 'enabled');
          proto = Object.getPrototypeOf(proto);
        }
        const record = { ref: new WeakRef(track), desired: track.enabled,
          getter: descriptor?.get, setter: descriptor?.set, value: track.enabled };
        // Preserve the app's requested mute separately from the extension's mute.
        Object.defineProperty(track, 'enabled', { configurable: true,
          get() { return record.getter ? record.getter.call(this) : record.value; },
          set(value) { record.desired = Boolean(value); applyRawMute(record, this); }
        });
        rawMute.set(track, record);
        rawRecords.add(record);
        applyRawMute(record, track);
      }
      function sweep() {
        for (const chain of engine.chains.slice()) {
          for (const output of chain.outputs) if (output.readyState === 'ended') chain.outputs.delete(output);
          if (chain.sourceTrack.readyState === 'ended') engine.cleanupChain(chain, true);
          else if (!chain.outputs.size) {
            engine.cleanupChain(chain);
            chain.sourceTrack.stop();
          }
        }
        for (const record of rawRecords) {
          const track = record.ref.deref();
          if (!track || track.readyState === 'ended') rawRecords.delete(record);
        }
      }

      function decorateOutput(track, chain) {
        outputs.set(track, chain);
        chain.outputs.add(track);
        track.__omniLordProcessed = true;
        track.__omniLordSourceTrackIds = chain.sourceTrack.id;
        const stop = track.stop.bind(track);
        nativeStops.set(track, stop);
        const clone = track.clone.bind(track);
        // A destination track otherwise has no relationship to the capture track.
        // Bridge its lifetime so stopping capture releases the physical microphone.
        Object.defineProperty(track, 'stop', { configurable: true, value() {
          stop();
          chain.outputs.delete(track);
          if (!chain.outputs.size) {
            engine.cleanupChain(chain);
            chain.sourceTrack.stop();
          }
        } });
        Object.defineProperty(track, 'clone', { configurable: true, value() {
          const copied = clone();
          if (copied.readyState === 'live' && !chain.cleaned) decorateOutput(copied, chain);
          return copied;
        } });
        for (const method of ['getSettings', 'getConstraints', 'getCapabilities', 'applyConstraints']) {
          if (typeof chain.sourceTrack[method] === 'function') {
            Object.defineProperty(track, method, { configurable: true, value: (...args) => chain.sourceTrack[method](...args) });
          }
        }
      }

      function fallback(chain) {
        if (chain.cleaned || chain.fallbackGain) return;
        // Rewire inside the same graph: the RTP sender keeps its existing track.
        disconnect(chain.source);
        disconnect(chain.workletNode);
        if (chain.workletNode?.port) chain.workletNode.port.close();
        chain.workletNode = null;
        const gain = chain.ctx.createGain();
        const clip = chain.ctx.createWaveShaper();
        const curve = new Float32Array(4097);
        for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 2048 - 1) * 2) * 1.0373;
        clip.curve = curve;
        chain.fallbackGain = gain;
        chain.fallbackClip = clip;
        chain.source.connect(chain.dryGain);
        chain.source.connect(gain);
        gain.connect(clip);
        clip.connect(chain.eqNodes[0]);
        engine.pushParamsFast();
        tell('SATURATION BACKUP ACTIVE');
      }

      async function buildTrack(track) {
        let chain;
        const allocated = [];
        let partialDestination;
        const keep = node => { allocated.push(node); return node; };
        try {
          const ctx = ensureProcessingContext();
          if (!ctx || ctx.state === 'closed') return track;
          if (ctx.state !== 'running') await bounded(ctx.resume(), 600, false);
          // Do not hand a silent, autoplay-blocked graph back to the calling app.
          if (ctx.state !== 'running' || track.readyState !== 'live') return track;
          const loaded = await bounded(getWorkletReady(), 1200, false);
          if (ctx.state !== 'running' || track.readyState !== 'live') return track;
          const stream = new MediaStream([track]);
          const source = keep(ctx.createMediaStreamSource(stream));
          const destination = partialDestination = keep(ctx.createMediaStreamDestination());
          const channels = track.getSettings?.().channelCount === 1 ? 1 : 2;
          destination.channelCount = channels;
          const eqNodes = [100, 250, 1000, 3000, 6000, 12000].map((hz, i) => {
            const node = keep(ctx.createBiquadFilter());
            node.type = i === 0 ? 'lowshelf' : (i === 5 ? 'highshelf' : 'peaking');
            node.frequency.value = hz;
            return node;
          });
          const dryGain = keep(ctx.createGain());
          const wetGain = keep(ctx.createGain());
          const mixGain = keep(ctx.createGain());
          const outputGain = keep(ctx.createGain());
          const ceiling = keep(ctx.createWaveShaper());
          // The old DSP already saturates. Bound EQ + music summation as well,
          // preventing invalid encoder samples while retaining the clipped sound.
          ceiling.curve = new Float32Array([-0.9999, 0, 0.9999]);
          const analyserNode = keep(ctx.createAnalyser());
          analyserNode.fftSize = 512;
          chain = { ctx, source, sourceTrack: track, sourceTracks: [track], sourceIds: track.id,
            destination, eqNodes, dryGain, wetGain, mixGain, outputGain, ceiling, analyserNode,
            workletNode: null, outputs: new Set(), cleaned: false, sender: null };
          for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
          eqNodes.at(-1).connect(wetGain);
          wetGain.connect(mixGain);
          source.connect(dryGain);
          dryGain.connect(mixGain);
          mixGain.connect(ceiling);
          ceiling.connect(outputGain);
          outputGain.connect(analyserNode);
          analyserNode.connect(destination);
          dryGain.gain.value = state.enabled ? 0 : 1;
          wetGain.gain.value = state.enabled ? 1 : 0;
          outputGain.gain.value = state.muteActive ? 0 : 1;
          if (loaded) {
            try {
              chain.workletNode = new AudioWorkletNode(ctx, 'omniLord-processor', {
                numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [channels],
                channelCount: channels, channelCountMode: 'explicit'
              });
              source.connect(chain.workletNode);
              chain.workletNode.connect(eqNodes[0]);
              chain.workletNode.addEventListener('processorerror', () => fallback(chain), { once: true });
            } catch (_) { fallback(chain); }
          } else fallback(chain);
          chain.outStream = destination.stream;
          for (const output of chain.outStream.getAudioTracks()) decorateOutput(output, chain);
          // stop() does not emit 'ended'; handle both app stop() and device loss.
          const sourceStop = track.stop.bind(track);
          chain.sourceStop = sourceStop;
          chain.sourceStopDescriptor = Object.getOwnPropertyDescriptor(track, 'stop');
          chain.sourceStopWrapper = function () { sourceStop(); engine.cleanupChain(chain); };
          Object.defineProperty(track, 'stop', { configurable: true, value: chain.sourceStopWrapper });
          chain.onEnded = () => engine.cleanupChain(chain, true);
          track.addEventListener('ended', chain.onEnded, { once: true });
          sources.set(track, chain);
          engine.chains.push(chain);
          if (!lifecycleTimer) lifecycleTimer = setInterval(sweep, 1000);
          player.connectToChain(chain);
          window.__OmniLordAnalyser = analyserNode;
          engine.pushParamsFast();
          return chain.outStream.getAudioTracks()[0] || track;
        } catch (_) {
          if (chain) engine.cleanupChain(chain);
          for (const node of allocated) disconnect(node);
          for (const output of partialDestination?.stream.getAudioTracks() || []) {
            try { (nativeStops.get(output) || output.stop.bind(output))(); } catch (_) {}
          }
          tell('MIC BYPASS — PROCESSING UNAVAILABLE');
          return track;
        }
      }

      engine.getSourceTrack = track => outputs.get(track)?.sourceTrack || track;
      engine.isUsableTrack = track => {
        const chain = outputs.get(track);
        return track?.readyState === 'live' && (!chain || (!chain.cleaned && chain.ctx.state === 'running'));
      };
      engine.processTrack = function (track) {
        if (!track || track.kind !== 'audio' || track.readyState !== 'live' || outputs.has(track) || track.__omniLordProcessed) return Promise.resolve(track);
        trackRawMute(track);
        if (!state.enabled) return Promise.resolve(track);
        const existing = sources.get(track);
        if (existing && !existing.cleaned && existing.ctx.state === 'running') {
          const output = Array.from(existing.outputs).find(t => t.readyState === 'live');
          if (output) return Promise.resolve(output);
        }
        if (existing && !existing.cleaned) return Promise.resolve(track);
        if (pending.has(track)) return pending.get(track);
        const work = buildTrack(track).finally(() => pending.delete(track));
        pending.set(track, work);
        return work;
      };
      engine.intercept = async function (stream) {
        if (!stream?.getAudioTracks || !stream.getAudioTracks().length) return stream;
        // Process each audio track separately and retain all camera/screen tracks.
        const tracks = await Promise.all(stream.getTracks().map(track => engine.processTrack(track)));
        return tracks.every((track, i) => track === stream.getTracks()[i]) ? stream : new MediaStream(tracks);
      };
      engine.cleanupChain = function (chain, notifyEnded = false) {
        if (!chain || chain.cleaned) return;
        chain.cleaned = true;
        player.disconnectFromChain(chain);
        for (const node of [chain.source, chain.workletNode, ...(chain.eqNodes || []), chain.dryGain,
          chain.wetGain, chain.mixGain, chain.outputGain, chain.ceiling, chain.analyserNode,
          chain.fallbackGain, chain.fallbackClip, chain.destination]) disconnect(node);
        try { chain.workletNode?.port?.close(); } catch (_) {}
        chain.sourceTrack.removeEventListener('ended', chain.onEnded);
        if (chain.sourceTrack.stop === chain.sourceStopWrapper) {
          if (chain.sourceStopDescriptor) Object.defineProperty(chain.sourceTrack, 'stop', chain.sourceStopDescriptor);
          else delete chain.sourceTrack.stop;
        }
        for (const output of chain.outputs) {
          try {
            nativeStops.get(output)?.();
            if (notifyEnded) output.dispatchEvent(new Event('ended'));
          } catch (_) {}
        }
        chain.outputs.clear();
        if (sources.get(chain.sourceTrack) === chain) sources.delete(chain.sourceTrack);
        engine.chains = engine.chains.filter(item => item !== chain);
        if (!engine.chains.length && lifecycleTimer) { clearInterval(lifecycleTimer); lifecycleTimer = null; }
        window.__OmniLordAnalyser = engine.chains.at(-1)?.analyserNode || null;
        if (!engine.chains.length) player.handleCallEnded();
      };
      engine.pushParamsFast = function () {
        for (const record of rawRecords) {
          const track = record.ref.deref();
          if (track && track.readyState === 'live') applyRawMute(record, track);
          else rawRecords.delete(record);
        }
        const master = state.ultraTurboActive ? 200000 : (state.turboActive ? 100000 : state.masterGain);
        const rage = state.ultraTurboActive ? 200000 : (state.turboActive ? 100000 : state.rageBoost);
        for (const chain of engine.chains) {
          if (chain.cleaned || chain.ctx.state === 'closed') continue;
          const now = chain.ctx.currentTime;
          // Mute occurs after the music mix and also works in the fallback path.
          chain.outputGain.gain.cancelScheduledValues(now);
          chain.outputGain.gain.setValueAtTime(state.muteActive ? 0 : 1, now);
          ramp(chain.wetGain.gain, state.enabled ? 1 : 0, now);
          ramp(chain.dryGain.gain, state.enabled ? 0 : 1, now);
          if (state.enabled) player.connectToChain(chain); else player.disconnectFromChain(chain);
          const values = { clearGain: state.clearGain, masterGain: master, rage,
            bitrate: state.bitrate, width: state.stereoWidth, mute: state.muteActive ? 1 : 0,
            noiseGate: state.noiseGate, deEss: state.deEss, bassBoost: state.bassBoost, autoLevel: state.autoLevel };
          if (chain.workletNode) {
            for (const [key, value] of Object.entries(values)) ramp(chain.workletNode.parameters.get(key), value, now);
          }
          if (chain.fallbackGain) ramp(chain.fallbackGain.gain, Math.min(1000000, state.clearGain * master * (1 + rage / 50)), now);
          chain.eqNodes.forEach((node, i) => ramp(node.gain, state['eq' + (i + 1)], now));
        }
        tell(state.muteActive ? 'MUTED' : (state.enabled ? 'SATURATED VOICE ACTIVE' : 'MIC BYPASS'));
      };
      engine.schedulePushParams = function () {
        if (engine.pushScheduled) return;
        engine.pushScheduled = true;
        setTimeout(() => { engine.pushScheduled = false; engine.pushParamsFast(); }, 16);
      };
      engine.recover = async function () {
        const ctx = window.__OmniLordAudioCtx;
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') await bounded(ctx.resume(), 600, false);
        // Closed contexts cannot be resumed. Leave capture live for sender bypass.
        sweep();
        engine.pushParamsFast();
        return { context: ctx?.state || 'idle', chains: engine.chains.length };
      };
    }
  };
})();
