/* WebRTC capture + sender guard. DSP stays in the injector / resilience layer. */
(() => {
  'use strict';
  if (window.__OmniCallGuard) return;

  const NativePC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  const NativeSender = window.RTCRtpSender;
  const nativeReplaceTrack = NativeSender?.prototype.replaceTrack;
  const peers = new Set();
  const senders = new WeakMap();
  const resolved = new WeakMap();
  const pending = new WeakMap();
  let engine = null;
  let state = null;
  let wantsAudio = () => false;
  let report = () => {};
  let recovering = false;
  let statsTimer = null;
  let metrics = { sentKbps: null, lossPercent: null, jitterMs: null };
  let lastBytes = new WeakMap();

  const live = track => track && track.readyState === 'live';
  const audioTrack = track => track && track.kind === 'audio';
  const tell = message => { try { report(message); } catch (_) {} };

  function connectionRank(value) {
    if (recovering) return 'recovering';
    if (value === 'failed') return 'failed';
    if (value === 'disconnected') return 'disconnected';
    if (value === 'connecting' || value === 'checking' || value === 'new') return 'connecting';
    if (value === 'connected' || value === 'completed') return 'connected';
    if (value === 'closed') return 'closed';
    return 'idle';
  }

  function peerState(pc) {
    try {
      const conn = pc.connectionState;
      if (conn && conn !== 'unknown') return connectionRank(conn);
      return connectionRank(pc.iceConnectionState);
    } catch (_) {
      return 'idle';
    }
  }

  function overallState() {
    if (recovering) return 'recovering';
    prunePeers();
    if (!peers.size) return engine?.chains?.length ? 'connecting' : 'idle';
    const ranks = ['failed', 'disconnected', 'connecting', 'connected', 'closed', 'idle'];
    const seen = new Set([...peers].map(peerState));
    return ranks.find(rank => seen.has(rank)) || 'idle';
  }

  function prunePeers() {
    for (const pc of peers) {
      try {
        if (pc.signalingState === 'closed' || pc.connectionState === 'closed') peers.delete(pc);
      } catch (_) {
        peers.delete(pc);
      }
    }
    if (!peers.size && statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
      metrics = { sentKbps: null, lossPercent: null, jitterMs: null };
    }
  }

  function watchPeer(pc) {
    if (!pc || peers.has(pc)) return pc;
    peers.add(pc);
    const refresh = () => {
      prunePeers();
      const status = overallState();
      if (status === 'failed') tell('CALL FAILED — TAP RECOVER AUDIO');
      else if (status === 'disconnected') tell('CALL INTERRUPTED — HOLD OR RECOVER');
      else if (status === 'connected') tell('SATURATED VOICE IN CALL');
    };
    pc.addEventListener('connectionstatechange', refresh);
    pc.addEventListener('iceconnectionstatechange', refresh);
    pc.addEventListener('signalingstatechange', prunePeers);
    if (!statsTimer) statsTimer = setInterval(collectStats, 1000);
    return pc;
  }

  function rememberSender(sender, source) {
    if (!sender) return sender;
    const record = senders.get(sender) || { source: null, processed: null };
    if (audioTrack(source) && !source.__omniLordProcessed) record.source = source;
    else if (audioTrack(source) && engine?.getSourceTrack) record.source = engine.getSourceTrack(source);
    if (audioTrack(source) && source.__omniLordProcessed) record.processed = source;
    senders.set(sender, record);
    return sender;
  }

  function cacheResolved(source, processed) {
    if (!audioTrack(source) || !audioTrack(processed)) return processed;
    resolved.set(source, processed);
    if (processed !== source) resolved.set(processed, processed);
    return processed;
  }

  function outgoingSync(track) {
    if (!audioTrack(track)) return track;
    if (track.__omniLordProcessed && live(track)) return track;
    const mapped = resolved.get(track);
    if (mapped && live(mapped) && (!engine?.isUsableTrack || engine.isUsableTrack(mapped))) return mapped;
    return track;
  }

  function processLater(track, onReady) {
    if (!audioTrack(track) || !engine?.processTrack) {
      onReady?.(track);
      return track;
    }
    const immediate = outgoingSync(track);
    if (immediate !== track && live(immediate)) {
      onReady?.(immediate);
      return immediate;
    }
    if (track.__omniLordProcessed) {
      onReady?.(track);
      return track;
    }
    if (pending.has(track)) {
      pending.get(track).then(onReady);
      return immediate;
    }
    const work = Promise.resolve(engine.processTrack(track)).then(processed => {
      const next = live(processed) ? cacheResolved(track, processed) : track;
      onReady?.(next);
      return next;
    }).catch(() => {
      onReady?.(track);
      return track;
    }).finally(() => pending.delete(track));
    pending.set(track, work);
    return immediate;
  }

  function upgradeSender(sender, processed) {
    if (!sender || !live(processed)) return;
    const current = sender.track;
    if (current === processed) {
      rememberSender(sender, processed);
      return;
    }
    if (current && current.__omniLordProcessed && live(current) && engine?.isUsableTrack?.(current)) return;
    if (typeof nativeReplaceTrack !== 'function') return;
    Promise.resolve(nativeReplaceTrack.call(sender, processed)).then(() => rememberSender(sender, processed)).catch(() => {});
  }

  async function interceptStream(constraints, stream) {
    if (!stream || !engine) return stream;
    try {
      const asked = !constraints || constraints === true || wantsAudio(constraints) || constraints.audio !== false;
      if (!asked) return stream;
      if (!stream.getAudioTracks?.().length) return stream;
      if (typeof engine.intercept === 'function') {
        const next = await engine.intercept(stream);
        for (const track of stream.getAudioTracks()) {
          const processed = next.getAudioTracks?.().find(item => item.__omniLordSourceTrackIds?.includes?.(track.id)) || outgoingSync(track);
          if (processed && processed !== track) cacheResolved(track, processed);
        }
        return next || stream;
      }
      const tracks = await Promise.all(stream.getTracks().map(track =>
        audioTrack(track) ? engine.processTrack(track) : track
      ));
      tracks.forEach((processed, i) => cacheResolved(stream.getTracks()[i], processed));
      return tracks.every((track, i) => track === stream.getTracks()[i]) ? stream : new MediaStream(tracks);
    } catch (_) {
      tell('MIC BYPASS — CALL GUARD UNAVAILABLE');
      return stream;
    }
  }

  function wrapGetUserMedia() {
    const proto = window.MediaDevices?.prototype;
    if (proto?.getUserMedia && !proto.getUserMedia.__omniCallGuard) {
      const original = proto.getUserMedia;
      proto.getUserMedia = function (constraints) {
        return original.call(this, constraints).then(stream => interceptStream(constraints, stream));
      };
      proto.getUserMedia.__omniCallGuard = true;
    }
    if (proto?.getDisplayMedia && !proto.getDisplayMedia.__omniCallGuard) {
      const original = proto.getDisplayMedia;
      proto.getDisplayMedia = function (constraints) {
        return original.call(this, constraints).then(stream => interceptStream(constraints, stream));
      };
      proto.getDisplayMedia.__omniCallGuard = true;
    }
    for (const key of ['getUserMedia', 'webkitGetUserMedia', 'mozGetUserMedia']) {
      const original = navigator[key];
      if (typeof original !== 'function' || original.__omniCallGuard) continue;
      navigator[key] = function (constraints, success, error) {
        if (typeof success !== 'function') {
          return Promise.resolve(original.call(this, constraints)).then(stream => interceptStream(constraints, stream));
        }
        return original.call(this, constraints, stream => {
          Promise.resolve(interceptStream(constraints, stream)).then(success, error);
        }, error);
      };
      navigator[key].__omniCallGuard = true;
    }
  }

  function wrapPeerConnection() {
    if (!NativePC || NativePC.__omniCallGuard) {
      wrapSender();
      return;
    }

    const originalAddTrack = NativePC.prototype.addTrack;
    if (typeof originalAddTrack === 'function') {
      NativePC.prototype.addTrack = function (track, ...streams) {
        watchPeer(this);
        const outgoing = outgoingSync(track);
        const sender = originalAddTrack.call(this, outgoing, ...streams);
        rememberSender(sender, track);
        processLater(track, processed => upgradeSender(sender, processed));
        return sender;
      };
    }

    const originalAddTransceiver = NativePC.prototype.addTransceiver;
    if (typeof originalAddTransceiver === 'function') {
      NativePC.prototype.addTransceiver = function (trackOrKind, init) {
        watchPeer(this);
        if (!audioTrack(trackOrKind)) return originalAddTransceiver.call(this, trackOrKind, init);
        const outgoing = outgoingSync(trackOrKind);
        const transceiver = originalAddTransceiver.call(this, outgoing, init);
        rememberSender(transceiver?.sender, trackOrKind);
        processLater(trackOrKind, processed => upgradeSender(transceiver?.sender, processed));
        return transceiver;
      };
    }

    const originalAddStream = NativePC.prototype.addStream;
    if (typeof originalAddStream === 'function') {
      NativePC.prototype.addStream = function (stream) {
        watchPeer(this);
        const result = originalAddStream.call(this, stream);
        for (const track of stream?.getAudioTracks?.() || []) {
          processLater(track, processed => {
            const sender = this.getSenders?.().find(item => item.track === track || item.track === processed || senders.get(item)?.source === track);
            if (sender) upgradeSender(sender, processed);
          });
        }
        return result;
      };
    }

    wrapSender();

    const Wrapped = function (...args) {
      const pc = new NativePC(...args);
      return watchPeer(pc);
    };
    Wrapped.prototype = NativePC.prototype;
    Object.setPrototypeOf(Wrapped, NativePC);
    Wrapped.__omniCallGuard = true;
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
  }

  function wrapSender() {
    if (!nativeReplaceTrack || NativeSender.prototype.replaceTrack.__omniCallGuard) return;
    const original = nativeReplaceTrack;
    NativeSender.prototype.replaceTrack = function (track) {
      if (!audioTrack(track)) {
        rememberSender(this, track);
        return original.call(this, track);
      }
      const outgoing = processLater(track, processed => upgradeSender(this, processed));
      rememberSender(this, track);
      return original.call(this, outgoing);
    };
    NativeSender.prototype.replaceTrack.__omniCallGuard = true;
  }

  async function collectStats() {
    prunePeers();
    let bytes = 0;
    let stamp = 0;
    let lost = 0;
    let received = 0;
    let jitter = 0;
    let jitterCount = 0;
    let previousBytes = 0;
    let previousStamp = 0;
    for (const pc of peers) {
      let reports;
      try { reports = await pc.getStats(); } catch (_) { continue; }
      const prior = lastBytes.get(pc) || { bytes: 0, stamp: 0 };
      previousBytes += prior.bytes;
      previousStamp = Math.max(previousStamp, prior.stamp);
      let localBytes = 0;
      let localStamp = 0;
      for (const report of reports.values()) {
        if (report.type === 'outbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
          localBytes += report.bytesSent || 0;
          localStamp = Math.max(localStamp, report.timestamp || 0);
        }
        if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
          lost += Math.max(0, report.packetsLost || 0);
          received += Math.max(0, report.packetsReceived || 0);
          if (typeof report.jitter === 'number') {
            jitter += report.jitter * 1000;
            jitterCount += 1;
          }
        }
      }
      bytes += localBytes;
      stamp = Math.max(stamp, localStamp);
      lastBytes.set(pc, { bytes: localBytes, stamp: localStamp });
    }
    const elapsed = stamp && previousStamp ? stamp - previousStamp : 0;
    metrics = {
      sentKbps: elapsed > 0 ? Math.max(0, (bytes - previousBytes) * 8 / elapsed) : metrics.sentKbps,
      lossPercent: received + lost > 0 ? (lost / (lost + received)) * 100 : null,
      jitterMs: jitterCount ? jitter / jitterCount : null
    };
  }

  async function recoverSenders() {
    const jobs = [];
    for (const pc of peers) {
      let list = [];
      try { list = pc.getSenders(); } catch (_) { continue; }
      for (const sender of list) {
        const record = senders.get(sender) || {};
        const current = sender.track;
        const source = record.source || (engine?.getSourceTrack && current ? engine.getSourceTrack(current) : current);
        if (!audioTrack(source) && !audioTrack(current)) continue;
        const usable = current && live(current) && (!engine?.isUsableTrack || engine.isUsableTrack(current));
        if (usable && current.__omniLordProcessed) continue;
        const origin = live(source) ? source : current;
        if (!live(origin)) continue;
        jobs.push(Promise.resolve(engine.processTrack(origin)).then(processed => {
          if (live(processed)) {
            cacheResolved(origin, processed);
            return upgradeSender(sender, processed);
          }
        }).catch(() => {}));
      }
      try { pc.restartIce?.(); } catch (_) {}
    }
    await Promise.all(jobs);
  }

  function snapshotMessage(status) {
    if (status === 'recovering') return 'Resuming audio context and restoring senders.';
    if (status === 'failed') return 'Connection failed. Recover requests ICE restart on the next negotiation.';
    if (status === 'disconnected') return 'ICE interrupted. Hold the call or tap Recover audio.';
    if (status === 'connecting') return 'Negotiating the call. Local processed audio will attach when senders appear.';
    if (status === 'closed') return 'Call closed. Rejoin to capture microphone audio again.';
    if (status === 'connected') return 'Local output and sent traffic. Receiver loudness may differ.';
    if (engine?.chains?.length) return 'Microphone graph is live. Waiting for a peer connection.';
    return 'Waiting for local call measurements.';
  }

  wrapGetUserMedia();
  wrapPeerConnection();

  window.__OmniCallGuard = {
    install(deps) {
      if (!deps) return this;
      engine = deps.AudioInterceptor || engine;
      state = deps.currentState || state;
      if (typeof deps.wantsAudio === 'function') wantsAudio = deps.wantsAudio;
      if (typeof deps.report === 'function') report = deps.report;
      wrapGetUserMedia();
      wrapPeerConnection();
      return this;
    },
    snapshot() {
      const status = overallState();
      return {
        state: status,
        sentKbps: metrics.sentKbps,
        lossPercent: metrics.lossPercent,
        jitterMs: metrics.jitterMs,
        message: snapshotMessage(status)
      };
    },
    async recover() {
      if (recovering) return { message: 'Recovery already in progress.' };
      recovering = true;
      tell('RECOVERING CALL AUDIO');
      try {
        const ctx = window.__OmniLordAudioCtx;
        if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
          try { await ctx.resume(); } catch (_) {}
        }
        const audio = typeof engine?.recover === 'function' ? await engine.recover() : null;
        await recoverSenders();
        await collectStats();
        const status = overallState();
        const chains = audio?.chains ?? engine?.chains?.length ?? 0;
        const message = status === 'failed'
          ? 'ICE restart requested. If audio stays down, rejoin the call.'
          : (chains ? 'Audio context resumed and senders refreshed. Check call audio.' : 'Audio resumed. Start or rejoin a call if senders are still empty.');
        tell(message);
        return { message, state: status, chains };
      } catch (_) {
        const message = 'Recovery unavailable. Try rejoining the call.';
        tell(message);
        return { message };
      } finally {
        recovering = false;
      }
    }
  };
})();
