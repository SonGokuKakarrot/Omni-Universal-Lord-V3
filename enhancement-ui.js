/* Companion interface. The original injector still owns all audio controls. */
(() => {
  'use strict';
  if (window.top !== window.self || window.__OmniEnhancedUI) return;
  window.__OmniEnhancedUI = true;

  let observer;
  let timer;
  let samples;
  let lastAnalyser;
  const validNumber = value => typeof value === 'number' && Number.isFinite(value);
  const db = value => value > 0 ? Math.max(-60, 20 * Math.log10(value)) : -60;
  const dbLabel = value => value <= -60 ? '≤ −60' : value.toFixed(1);

  function install() {
    const panel = document.getElementById('oul-panel');
    const body = document.getElementById('oul-body');
    if (!panel || !body) return false;
    observer?.disconnect();
    if (panel.classList.contains('oul-enhanced')) return true;
    panel.classList.add('oul-enhanced');
    panel.setAttribute('aria-label', 'Omni voice console');

    const brand = panel.querySelector('.oul-brand');
    if (brand) {
      const caption = document.createElement('span');
      caption.className = 'oul-enhance-caption';
      caption.textContent = 'SATURATED VOICE · CONNECTION GUARD';
      brand.appendChild(caption);
    }

    const health = document.createElement('section');
    health.id = 'oul-call-health';
    health.setAttribute('aria-label', 'Local audio and call diagnostics');
    health.innerHTML = `
      <div class="oul-health-heading">
        <span class="oul-health-eyebrow">CALL HEALTH</span>
        <span class="oul-health-state" data-state="idle"><i aria-hidden="true"></i><span>Waiting for call</span></span>
      </div>
      <div class="oul-meter-label"><span>LOCAL OUTPUT</span><span><b data-peak>—</b> <small>dBFS peak</small></span></div>
      <div class="oul-output-meter" role="meter" aria-label="Local output peak" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60" aria-valuetext="No audio measurement">
        <div class="oul-output-fill"></div><span class="oul-output-mark"></span>
      </div>
      <div class="oul-meter-scale"><span>−60</span><span data-rms>RMS — dBFS</span><span>0 dBFS</span></div>
      <div class="oul-network-stats">
        <div><span>LOCAL SEND</span><strong data-send>— <small>kb/s</small></strong></div>
        <div><span>REMOTE LOSS</span><strong data-loss>— <small>%</small></strong></div>
        <div><span>REMOTE JITTER</span><strong data-jitter>— <small>ms</small></strong></div>
      </div>
      <div class="oul-health-footer"><p data-note>Waiting for local call measurements.</p><button type="button" class="oul-recover" title="Resume the audio context and request recovery of eligible failed connections">Recover audio</button></div>
    `;
    body.prepend(health);

    // Keep the original elements and handlers, with less clutter above the mixer.
    const appearance = document.createElement('details');
    appearance.className = 'oul-appearance';
    const summary = document.createElement('summary');
    summary.textContent = 'Appearance';
    appearance.appendChild(summary);
    for (const selector of ['.oul-palette-box', '.oul-theme-box']) {
      const control = panel.querySelector(selector);
      if (control) appearance.appendChild(control);
    }
    if (appearance.children.length > 1) body.appendChild(appearance);

    const resolution = panel.querySelector('input[data-param="bitrate"]');
    const resolutionValue = document.getElementById('lbl-bitrate');
    if (resolution && resolutionValue?.parentElement) {
      resolutionValue.parentElement.replaceChildren(document.createTextNode('SIGNAL RESOLUTION '), resolutionValue);
      resolution.title = 'Lower values add digital distortion; this does not set network bitrate.';
    }
    panel.querySelectorAll('input[data-param]').forEach(input => {
      const label = document.getElementById(`lbl-${input.dataset.param}`)?.parentElement;
      if (label) {
        label.id ||= `oul-label-${input.dataset.param}`;
        input.setAttribute('aria-labelledby', label.id);
      }
    });
    for (const [id, label] of Object.entries({
      'oul-theme-dim': 'Theme visibility', 'oul-audio-upload': 'Add songs to call music library',
      'oul-seek': 'Music playback position', 'oul-theme-file': 'Choose a background image'
    })) document.getElementById(id)?.setAttribute('aria-label', label);

    const state = health.querySelector('.oul-health-state');
    const stateText = state.querySelector('span');
    const meter = health.querySelector('.oul-output-meter');
    const fill = health.querySelector('.oul-output-fill');
    const peakLabel = health.querySelector('[data-peak]');
    const rmsLabel = health.querySelector('[data-rms]');
    const send = health.querySelector('[data-send]');
    const loss = health.querySelector('[data-loss]');
    const jitter = health.querySelector('[data-jitter]');
    const note = health.querySelector('[data-note]');
    const recover = health.querySelector('.oul-recover');
    let recoveryMessage = '';
    let recoveryMessageUntil = 0;
    let recovering = false;

    const setMetric = (node, value, unit, places = 0) => {
      const text = validNumber(value) ? Math.max(0, value).toFixed(places) : '—';
      if (node.dataset.value !== text) {
        node.dataset.value = text;
        node.replaceChildren(document.createTextNode(`${text} `));
        const suffix = document.createElement('small');
        suffix.textContent = unit;
        node.appendChild(suffix);
      }
    };

    function render() {
      if (document.hidden || panel.classList.contains('oul-collapsed') || !panel.isConnected) return;
      const analyser = window.__OmniLordAnalyser;
      if (analyser && analyser.context?.state === 'running') {
        try {
          if (analyser !== lastAnalyser || samples?.length !== analyser.fftSize) {
            samples = new Float32Array(analyser.fftSize);
            lastAnalyser = analyser;
          }
          analyser.getFloatTimeDomainData(samples);
          let peak = 0;
          let energy = 0;
          for (const sample of samples) {
            if (!Number.isFinite(sample)) continue;
            peak = Math.max(peak, Math.abs(sample));
            energy += sample * sample;
          }
          const peakDb = db(peak);
          const rmsDb = db(Math.sqrt(energy / samples.length));
          peakLabel.textContent = dbLabel(peakDb);
          rmsLabel.textContent = `RMS ${dbLabel(rmsDb)} dBFS`;
          fill.style.width = `${Math.max(0, Math.min(100, (peakDb + 60) / 60 * 100))}%`;
          meter.setAttribute('aria-valuenow', Math.min(0, peakDb).toFixed(1));
          meter.setAttribute('aria-valuetext', `${dbLabel(peakDb)} dBFS peak`);
          meter.dataset.hot = String(peakDb >= -1);
        } catch (_) { resetMeter(); }
      } else resetMeter();

      let snapshot;
      try { snapshot = window.__OmniCallGuard?.snapshot(); } catch (_) { /* Guard still loading. */ }
      renderNetwork(snapshot);
      recover.disabled = recovering || typeof window.__OmniCallGuard?.recover !== 'function';
    }

    function resetMeter() {
      peakLabel.textContent = '—';
      rmsLabel.textContent = 'RMS — dBFS';
      fill.style.width = '0%';
      meter.dataset.hot = 'false';
      meter.setAttribute('aria-valuenow', '-60');
      meter.setAttribute('aria-valuetext', 'No audio measurement');
    }

    function renderNetwork(snapshot) {
      const connection = snapshot?.state || 'idle';
      const labels = {
        idle: 'Waiting for call', connected: 'Connected', connecting: 'Connecting',
        disconnected: 'Connection interrupted', failed: 'Connection failed',
        closed: 'Call closed', recovering: 'Recovering audio'
      };
      state.dataset.state = Object.hasOwn(labels, connection) ? connection : 'idle';
      stateText.textContent = labels[connection] || 'Waiting for call';
      setMetric(send, snapshot?.sentKbps, 'kb/s', 1);
      setMetric(loss, snapshot?.lossPercent, '%', 1);
      setMetric(jitter, snapshot?.jitterMs, 'ms', 0);
      note.textContent = recoveryMessageUntil > Date.now() ? recoveryMessage :
        snapshot?.message || 'Local output and sent traffic. Receiver loudness may differ.';
    }

    recover.addEventListener('click', async () => {
      if (recovering || typeof window.__OmniCallGuard?.recover !== 'function') return;
      recovering = true;
      recover.disabled = true;
      recover.textContent = 'Recovering…';
      try {
        const result = await window.__OmniCallGuard.recover();
        recoveryMessage = typeof result?.message === 'string' ? result.message : 'Recovery requested. Check call audio.';
      } catch (_) { recoveryMessage = 'Recovery unavailable. Try rejoining the call.'; }
      finally {
        recovering = false;
        recoveryMessageUntil = Date.now() + 6000;
        recover.textContent = 'Recover audio';
        render();
      }
    });

    function clampPanel() {
      if (!panel.isConnected) return;
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8));
      const top = Math.max(8, Math.min(bounds.top, window.innerHeight - bounds.height - 8));
      if (bounds.left !== left) panel.style.left = `${left}px`;
      if (bounds.top !== top) panel.style.top = `${top}px`;
    }
    window.addEventListener('resize', clampPanel, { passive: true });
    panel.querySelector('#btn-collapse')?.addEventListener('click', () => { clampPanel(); render(); });
    document.addEventListener('visibilitychange', render);
    window.addEventListener('pageshow', render);
    window.addEventListener('pagehide', () => clearInterval(timer));
    window.addEventListener('pageshow', () => {
      clearInterval(timer);
      timer = setInterval(render, 250);
    });
    clampPanel();
    // The original controller reapplies saved coordinates shortly after building.
    setTimeout(clampPanel, 150);
    render();
    timer = setInterval(render, 250);
    return true;
  }

  if (!install()) {
    observer = new MutationObserver(install);
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', install, { once: true });
  }
})();
