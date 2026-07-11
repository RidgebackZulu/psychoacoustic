"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type BeatMode = "binaural" | "monaural" | "isochronic";
type Waveform = OscillatorType;
type LayerKey = "beat" | "veil" | "pulse" | "drone";
type LayerState = Record<LayerKey, { gain: number; pan: number; muted: boolean; solo: boolean }>;

type AudioGraph = {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  oscillators: OscillatorNode[];
  sources: AudioBufferSourceNode[];
  layerGains: Record<LayerKey, GainNode>;
  layerPans: Record<LayerKey, StereoPannerNode>;
  carriers: { left?: OscillatorNode; right?: OscillatorNode; pulse?: OscillatorNode; drone?: OscillatorNode; isoLfo?: OscillatorNode; rhythmLfo?: OscillatorNode };
  pulseDepth?: GainNode;
  beatMode: BeatMode;
};

const initialLayers: LayerState = {
  beat: { gain: 0.44, pan: 0, muted: false, solo: false },
  veil: { gain: 0.16, pan: 0, muted: false, solo: false },
  pulse: { gain: 0.12, pan: 0, muted: false, solo: false },
  drone: { gain: 0.14, pan: 0, muted: false, solo: false },
};

const presets = {
  Focus: { carrier: 400, beat: 13, bpm: 72, noise: "PINK", layers: { beat: 0.46, veil: 0.1, pulse: 0.1, drone: 0.08 } },
  Unwind: { carrier: 320, beat: 7.5, bpm: 58, noise: "BROWN", layers: { beat: 0.38, veil: 0.19, pulse: 0.06, drone: 0.16 } },
  Sleep: { carrier: 220, beat: 3.2, bpm: 42, noise: "BROWN", layers: { beat: 0.31, veil: 0.23, pulse: 0.03, drone: 0.13 } },
  Perform: { carrier: 480, beat: 18, bpm: 88, noise: "PINK", layers: { beat: 0.42, veil: 0.08, pulse: 0.16, drone: 0.07 } },
} as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function Knob({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  size = "md",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  size?: "sm" | "md" | "lg";
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const ratio = (value - min) / (max - min);
  const degrees = -135 + ratio * 270;
  const set = (next: number) => onChange(Math.round(clamp(next, min, max) / step) * step);

  return (
    <div className={`knob-control knob-${size}`}>
      <div
        className="knob"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        style={{ "--angle": `${degrees}deg`, "--fill": `${ratio * 75}%` } as React.CSSProperties}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, value };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          set(drag.current.value + ((drag.current.y - event.clientY) / 160) * (max - min));
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(event) => {
          event.preventDefault();
          set(value + (event.deltaY < 0 ? step : -step));
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowRight"].includes(event.key)) set(value + step);
          if (["ArrowDown", "ArrowLeft"].includes(event.key)) set(value - step);
          if (event.key === "Home") set(min);
          if (event.key === "End") set(max);
        }}
      >
        <span className="knob-cap"><i /></span>
      </div>
      <output>{Number.isInteger(step) ? value.toFixed(0) : value.toFixed(step < 0.1 ? 2 : 1)}{unit}</output>
      <label>{label}</label>
    </div>
  );
}

function Toggle({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className={`toggle ${active ? "active" : ""}`} onClick={onClick}><span />{label}</button>;
}

function Spectrum({ analyser, running }: { analyser: AnalyserNode | null; running: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    const data = new Uint8Array(analyser?.frequencyBinCount || 1024);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = "rgba(77, 203, 196, .09)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += width / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
      for (let y = 0; y <= height; y += height / 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      if (analyser && running) analyser.getByteFrequencyData(data);
      else data.forEach((_, i) => data[i] = Math.max(0, 28 + Math.sin(i * .11 + performance.now() / 900) * 8 - i / 25));
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#8d5e25"); gradient.addColorStop(.22, "#e3a84d"); gradient.addColorStop(.68, "#60d9cf"); gradient.addColorStop(1, "#b8fff5");
      ctx.strokeStyle = gradient; ctx.shadowColor = "#4ed8ce"; ctx.shadowBlur = 9; ctx.lineWidth = 1.8;
      ctx.beginPath();
      const bins = Math.min(data.length, 420);
      for (let i = 0; i < bins; i++) {
        const x = (Math.log10(1 + i * 9) / Math.log10(1 + bins * 9)) * width;
        const y = height - (data[i] / 255) * height * .92 - 6;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(104, 227, 215, .055)"; ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.fill();
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyser, running]);
  return <canvas ref={canvasRef} className="spectrum-canvas" aria-label="Real-time frequency spectrum" />;
}

function Scope({ analyser, running }: { analyser: AnalyserNode | null; running: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    const data = new Uint8Array(analyser?.fftSize || 2048);
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (analyser && running) analyser.getByteTimeDomainData(data);
      ctx.strokeStyle = "rgba(87,220,210,.82)"; ctx.shadowColor = "#5ce1d6"; ctx.shadowBlur = 8; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let i = 0; i < data.length; i += 4) {
        const x = (i / (data.length - 1)) * w;
        const sample = analyser && running ? data[i] / 128 - 1 : Math.sin(i * .025 + performance.now() / 500) * .18;
        const y = h / 2 + sample * h * .42;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.shadowBlur = 0; frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, [analyser, running]);
  return <canvas ref={canvasRef} className="scope-canvas" aria-label="Waveform oscilloscope" />;
}

function VUMeter({ analyser, label, running }: { analyser: AnalyserNode | null; label: string; running: boolean }) {
  const [level, setLevel] = useState(-42);
  useEffect(() => {
    let frame = 0; let last = 0;
    const data = new Uint8Array(analyser?.fftSize || 2048);
    const tick = (now: number) => {
      if (now - last > 55) {
        let db = -42;
        if (analyser && running) {
          analyser.getByteTimeDomainData(data);
          let sum = 0; for (const v of data) { const n = v / 128 - 1; sum += n * n; }
          db = 20 * Math.log10(Math.max(0.0001, Math.sqrt(sum / data.length)));
        }
        setLevel(db); last = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [analyser, running]);
  const angle = clamp(((level + 42) / 42) * 86 - 43, -43, 43);
  return (
    <div className="vu-meter">
      <div className="vu-scale"><span>-20</span><span>-7</span><span>0</span><span>+3</span></div>
      <div className="vu-arc" />
      <div className="vu-needle" style={{ transform: `rotate(${angle}deg)` }} />
      <div className="vu-pivot" /><b>{label}</b><small>DECIBELS</small>
    </div>
  );
}

function Fader({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  return (
    <label className="fader">
      <span className="fader-scale">{[0, -6, -12, -24, -48].map((v) => <i key={v}>{v}</i>)}</span>
      <input aria-label={`${label} level`} type="range" min="0" max="1" step="0.01" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export default function Home() {
  const graphRef = useRef<AudioGraph | null>(null);
  const [running, setRunning] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  const [carrier, setCarrier] = useState(400);
  const [beat, setBeat] = useState(10);
  const [master, setMaster] = useState(0.52);
  const [bpm, setBpm] = useState(60);
  const [pulseDepth, setPulseDepth] = useState(0.42);
  const [mode, setMode] = useState<BeatMode>("binaural");
  const [waveform, setWaveform] = useState<Waveform>("sine");
  const [noiseColor, setNoiseColor] = useState("PINK");
  const [layers, setLayers] = useState<LayerState>(initialLayers);
  const [elapsed, setElapsed] = useState(0);
  const [sessionLength, setSessionLength] = useState(30);
  const [automation, setAutomation] = useState(true);
  const [drift, setDrift] = useState(0.18);
  const [preset, setPreset] = useState<keyof typeof presets>("Focus");
  const safeMode = true;
  const [selectedLane, setSelectedLane] = useState("Beat Frequency");

  const updateLayer = (key: LayerKey, patch: Partial<LayerState[LayerKey]>) => setLayers((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const stopAudio = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    graph.master.gain.cancelScheduledValues(now);
    graph.master.gain.setValueAtTime(graph.master.gain.value, now);
    graph.master.gain.linearRampToValueAtTime(0, now + .12);
    window.setTimeout(() => graph.ctx.close(), 150);
    graphRef.current = null; setRunning(false); setElapsed(0); setGraphVersion((v) => v + 1);
  }, []);

  const startAudio = useCallback(async () => {
    if (graphRef.current) { stopAudio(); return; }
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    await ctx.resume();
    const masterNode = ctx.createGain(); masterNode.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 1; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .16;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = .82;
    const splitter = ctx.createChannelSplitter(2); const analyserL = ctx.createAnalyser(); const analyserR = ctx.createAnalyser(); analyserL.fftSize = analyserR.fftSize = 2048;
    masterNode.connect(limiter).connect(analyser).connect(ctx.destination); analyser.connect(splitter); splitter.connect(analyserL, 0); splitter.connect(analyserR, 1);
    const layerGains = {} as Record<LayerKey, GainNode>; const layerPans = {} as Record<LayerKey, StereoPannerNode>;
    (["beat", "veil", "pulse", "drone"] as LayerKey[]).forEach((key) => { layerGains[key] = ctx.createGain(); layerPans[key] = ctx.createStereoPanner(); layerGains[key].connect(layerPans[key]).connect(masterNode); });
    const oscillators: OscillatorNode[] = []; const sources: AudioBufferSourceNode[] = [];
    const carriers: AudioGraph["carriers"] = {};
    if (mode === "binaural") {
      const left = ctx.createOscillator(), right = ctx.createOscillator(); left.type = right.type = waveform; left.frequency.value = carrier - beat / 2; right.frequency.value = carrier + beat / 2;
      const merger = ctx.createChannelMerger(2); left.connect(merger, 0, 0); right.connect(merger, 0, 1); merger.connect(layerGains.beat); left.start(); right.start(); oscillators.push(left, right); carriers.left = left; carriers.right = right;
    } else if (mode === "monaural") {
      const one = ctx.createOscillator(), two = ctx.createOscillator(); one.type = two.type = waveform; one.frequency.value = carrier - beat / 2; two.frequency.value = carrier + beat / 2;
      one.connect(layerGains.beat); two.connect(layerGains.beat); one.start(); two.start(); oscillators.push(one, two); carriers.left = one; carriers.right = two;
    } else {
      const iso = ctx.createOscillator(); iso.type = waveform; iso.frequency.value = carrier;
      const isoAmp = ctx.createGain(); isoAmp.gain.value = .5;
      const isoLfo = ctx.createOscillator(); isoLfo.type = "sine"; isoLfo.frequency.value = beat;
      const isoDepth = ctx.createGain(); isoDepth.gain.value = .48;
      isoLfo.connect(isoDepth).connect(isoAmp.gain); iso.connect(isoAmp).connect(layerGains.beat);
      iso.start(); isoLfo.start(); oscillators.push(iso, isoLfo); carriers.left = iso; carriers.isoLfo = isoLfo;
    }
    const pulse = ctx.createOscillator(); pulse.type = "sine"; pulse.frequency.value = carrier * .5;
    const pulseAmp = ctx.createGain(); pulseAmp.gain.value = .5; const pulseLfo = ctx.createOscillator(); pulseLfo.type = "square"; pulseLfo.frequency.value = (bpm / 60) * 2; const pulseDepthNode = ctx.createGain(); pulseDepthNode.gain.value = pulseDepth * .5;
    pulseLfo.connect(pulseDepthNode).connect(pulseAmp.gain); pulse.connect(pulseAmp).connect(layerGains.pulse); pulse.start(); pulseLfo.start(); oscillators.push(pulse, pulseLfo); carriers.pulse = pulse; carriers.rhythmLfo = pulseLfo;
    const drone = ctx.createOscillator(); drone.type = "triangle"; drone.frequency.value = carrier / 4; const droneFilter = ctx.createBiquadFilter(); droneFilter.type = "lowpass"; droneFilter.frequency.value = 680; drone.connect(droneFilter).connect(layerGains.drone); drone.start(); oscillators.push(drone); carriers.drone = drone;
    const buffer = ctx.createBuffer(2, ctx.sampleRate * 4, ctx.sampleRate); for (let ch = 0; ch < 2; ch++) { const data = buffer.getChannelData(ch); let brown = 0; for (let i = 0; i < data.length; i++) { const white = Math.random() * 2 - 1; brown = (brown + .02 * white) / 1.02; data[i] = noiseColor === "BROWN" ? brown * 3.4 : white; } }
    const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true; const noiseFilter = ctx.createBiquadFilter(); noiseFilter.type = noiseColor === "PINK" ? "lowpass" : "lowpass"; noiseFilter.frequency.value = noiseColor === "PINK" ? 4200 : 1200; noise.connect(noiseFilter).connect(layerGains.veil); noise.start(); sources.push(noise);
    const graph: AudioGraph = { ctx, master: masterNode, limiter, analyser, analyserL, analyserR, oscillators, sources, layerGains, layerPans, carriers, pulseDepth: pulseDepthNode, beatMode: mode };
    graphRef.current = graph; setRunning(true); setGraphVersion((v) => v + 1);
    const now = ctx.currentTime; masterNode.gain.setValueAtTime(0, now); masterNode.gain.linearRampToValueAtTime(master * .58, now + .8);
  }, [beat, bpm, carrier, master, mode, noiseColor, pulseDepth, stopAudio, waveform]);

  useEffect(() => () => { graphRef.current?.ctx.close(); }, []);

  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const now = graph.ctx.currentTime;
    graph.master.gain.setTargetAtTime(master * .58, now, .04);
    const soloed = Object.values(layers).some((l) => l.solo);
    (Object.keys(layers) as LayerKey[]).forEach((key) => {
      const layer = layers[key]; const target = layer.muted || (soloed && !layer.solo) ? 0 : layer.gain;
      graph.layerGains[key].gain.setTargetAtTime(target, now, .035); graph.layerPans[key].pan.setTargetAtTime(layer.pan, now, .04);
    });
  }, [layers, master, graphVersion]);

  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const now = graph.ctx.currentTime;
    const c = automation ? carrier + Math.sin(elapsed * .021) * drift * 8 : carrier;
    if (graph.beatMode === "isochronic") graph.carriers.left?.frequency.setTargetAtTime(c, now, .035);
    else { graph.carriers.left?.frequency.setTargetAtTime(c - beat / 2, now, .035); graph.carriers.right?.frequency.setTargetAtTime(c + beat / 2, now, .035); }
    graph.carriers.isoLfo?.frequency.setTargetAtTime(beat, now, .035);
    graph.carriers.rhythmLfo?.frequency.setTargetAtTime((bpm / 60) * 2, now, .035);
    graph.carriers.pulse?.frequency.setTargetAtTime(carrier * .5, now, .05); graph.carriers.drone?.frequency.setTargetAtTime(carrier / 4, now, .08);
    graph.pulseDepth?.gain.setTargetAtTime(pulseDepth * .5, now, .05);
  }, [automation, beat, bpm, carrier, drift, elapsed, pulseDepth]);

  useEffect(() => {
    if (!running) return; const start = performance.now() - elapsed * 1000;
    const timer = window.setInterval(() => { const next = (performance.now() - start) / 1000; setElapsed(next); if (next >= sessionLength * 60) stopAudio(); }, 100);
    return () => window.clearInterval(timer);
  }, [running, sessionLength, stopAudio]);

  const loadPreset = (name: keyof typeof presets) => {
    const next = presets[name]; setPreset(name); setCarrier(next.carrier); setBeat(next.beat); setBpm(next.bpm); setNoiseColor(next.noise);
    setLayers((current) => ({ ...current, beat: { ...current.beat, gain: next.layers.beat }, veil: { ...current.veil, gain: next.layers.veil }, pulse: { ...current.pulse, gain: next.layers.pulse }, drone: { ...current.drone, gain: next.layers.drone } }));
  };

  const band = beat < 4 ? "DELTA" : beat < 8 ? "THETA" : beat < 13 ? "ALPHA" : beat < 30 ? "BETA" : "EXPERIMENTAL";
  const graph = graphRef.current;
  const progress = clamp(elapsed / (sessionLength * 60), 0, 1);
  const channels = useMemo(() => [
    { key: "beat" as const, number: "I", name: "BINAURAL", detail: `${carrier.toFixed(0)}Hz · ${beat.toFixed(1)}Δ`, color: "amber" },
    { key: "veil" as const, number: "II", name: "NOISE VEIL", detail: noiseColor, color: "cyan" },
    { key: "pulse" as const, number: "III", name: "SYNC PULSE", detail: `${bpm} BPM`, color: "ruby" },
    { key: "drone" as const, number: "IV", name: "SUBSTRATE", detail: `${(carrier / 4).toFixed(0)}Hz`, color: "violet" },
  ], [beat, bpm, carrier, noiseColor]);

  return (
    <main className="app-shell">
      <div className="top-rail" />
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true"><span>✦</span></div>
        <div className="brand"><p>NOCTURNE LABORATORY</p><h1>Psychoacoustic Research Console</h1><div><span>THERMIONIC SERIES</span><i>•</i><span>INSTRUMENT № 01</span></div></div>
        <div className="session-status">
          <div><span className={`status-lamp ${running ? "lit" : ""}`} /><small>SYSTEM</small><b>{running ? "ACTIVE" : "STANDBY"}</b></div>
          <div><small>SESSION</small><b className="digital">{formatTime(elapsed)}</b></div>
          <div><small>OUTPUT</small><b>AIRPODS · STEREO</b></div>
        </div>
      </header>

      <nav className="preset-strip" aria-label="Session presets">
        <span>PROGRAM</span>
        {(Object.keys(presets) as (keyof typeof presets)[]).map((name) => <button key={name} className={preset === name ? "selected" : ""} onClick={() => loadPreset(name)}>{name}</button>)}
        <div className="strip-spacer" /><span>RESEARCH MODE</span><strong>{band}</strong><span className="calibration">CAL · 48kHz</span>
      </nav>

      <section className="console-grid">
        <article className="panel beat-panel">
          <PanelHeading roman="I" title="Auditory Beat Engine" subtitle="Protected stereo excitation" />
          <div className="mode-tabs">
            {(["binaural", "monaural", "isochronic"] as BeatMode[]).map((item) => <button key={item} disabled={running} title={running ? "Stop the session to change beat topology" : ""} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{item}</button>)}
          </div>
          <div className="frequency-readout"><small>INTERAURAL CONFIGURATION</small><div><span>L</span><b>{(carrier - beat / 2).toFixed(2)}</b><i>Hz</i></div><div><span>R</span><b>{(carrier + beat / 2).toFixed(2)}</b><i>Hz</i></div><em>Δ {beat.toFixed(2)} Hz</em></div>
          <div className="knob-row">
            <Knob label="CARRIER" value={carrier} min={80} max={1000} step={1} unit=" Hz" size="lg" onChange={setCarrier} />
            <Knob label="BEAT Δ" value={beat} min={0.5} max={40} step={0.1} unit=" Hz" size="lg" onChange={setBeat} />
          </div>
          <div className="switch-bank"><span>OSCILLATOR</span>{(["sine", "triangle", "sawtooth"] as Waveform[]).map((wave) => <button key={wave} className={waveform === wave ? "active" : ""} onClick={() => setWaveform(wave)}>{wave === "sine" ? "∿" : wave === "triangle" ? "△" : "⋀"}</button>)}</div>
          <div className="field-note"><span>HEADPHONES REQUIRED</span><p>Left and right carriers remain isolated through the protected signal path.</p></div>
        </article>

        <article className="panel analysis-panel">
          <PanelHeading roman="II" title="Spectral Observatory" subtitle="FFT · waveform · phase telemetry" />
          <div className="crt spectrum"><div className="crt-header"><span>20 Hz</span><b>REAL-TIME SPECTRAL FIELD</b><span>24 kHz</span></div><Spectrum analyser={graph?.analyser || null} running={running} /><div className="spectrum-labels"><span>60</span><span>250</span><span>1K</span><span>4K</span><span>16K</span></div></div>
          <div className="analysis-lower">
            <div className="crt small-scope"><Scope analyser={graph?.analyser || null} running={running} /><label>TIME DOMAIN</label></div>
            <div className="band-register"><span>DOMINANT BAND</span><strong>{band}</strong><div className="band-bar"><i style={{ width: `${clamp(beat / 40 * 100, 2, 100)}%` }} /></div><small>{beat.toFixed(2)} Hz perceptual difference</small></div>
            <div className="correlation"><span>STEREO FIELD</span><div className="gothic-orbit"><i /><i /><b>∞</b></div><small>{mode === "binaural" ? "ISOLATED" : "COHERENT"}</small></div>
          </div>
        </article>

        <article className="panel master-panel">
          <PanelHeading roman="III" title="Master Section" subtitle="Output & protection" />
          <div className="transport-well"><button className={`master-button ${running ? "stop" : ""}`} onClick={startAudio} aria-label={running ? "Stop session" : "Play session"}><span>{running ? "■" : "▶"}</span></button><b>{running ? "HALT SESSION" : "ENGAGE SESSION"}</b><small>{running ? "AUDIO CIRCUIT ENERGIZED" : "CLICK TO INITIALIZE AUDIO"}</small></div>
          <div className="master-knob"><Knob label="MASTER OUTPUT" value={master} min={0} max={1} step={0.01} unit="" size="lg" onChange={setMaster} /><div className="db-readout">{master <= .01 ? "−∞" : (20 * Math.log10(master * .58)).toFixed(1)} <span>dBFS</span></div></div>
          <div className="safety-row"><Toggle active={safeMode} label="PEAK GUARD" onClick={() => undefined} /><span><i className="on" />−1 dBTP</span></div>
          <div className="duration-control"><label>SESSION LENGTH <b>{sessionLength} MIN</b></label><input type="range" min="5" max="90" step="5" value={sessionLength} onChange={(e) => setSessionLength(Number(e.target.value))} /></div>
          <div className="output-note"><b>DIGITAL LEVEL ≠ EAR SPL</b><p>Keep device volume moderate. Stop if sound causes discomfort or ringing.</p></div>
        </article>

        <article className="panel mixer-panel">
          <PanelHeading roman="IV" title="Fourfold Layer Matrix" subtitle="Independent buses · gain · pan · isolation" />
          <div className="mixer-channels">
            {channels.map((channel) => {
              const state = layers[channel.key];
              return <div className={`channel channel-${channel.color}`} key={channel.key}>
                <div className="channel-head"><span>{channel.number}</span><div><b>{channel.name}</b><small>{channel.detail}</small></div><i className={!state.muted ? "on" : ""} /></div>
                <div className="channel-body">
                  <Knob label="PAN" value={state.pan} min={-1} max={1} step={0.05} size="sm" onChange={(pan) => updateLayer(channel.key, { pan })} />
                  <Fader label={channel.name} value={state.gain} onChange={(gain) => updateLayer(channel.key, { gain })} />
                  <div className="channel-buttons"><button className={state.muted ? "active" : ""} onClick={() => updateLayer(channel.key, { muted: !state.muted })}>M</button><button className={state.solo ? "active solo" : ""} onClick={() => updateLayer(channel.key, { solo: !state.solo })}>S</button></div>
                  <output>{(state.gain * 100).toFixed(0)}</output>
                </div>
              </div>;
            })}
          </div>
        </article>

        <article className="panel valves-panel">
          <PanelHeading roman="V" title="Thermionic Monitor" subtitle="Dual channel programme level" />
          <div className="vu-pair"><VUMeter analyser={graph?.analyserL || null} label="LEFT" running={running} /><VUMeter analyser={graph?.analyserR || null} label="RIGHT" running={running} /></div>
          <div className="tube-bank">{["ECC83", "12AU7", "6V6", "EL34"].map((tube, index) => <div key={tube} className={running ? "energized" : ""} style={{ animationDelay: `${index * .13}s` }}><span /><i /><b>{tube}</b></div>)}</div>
          <div className="hardware-stats"><span><small>LATENCY</small><b>{running && graph ? Math.round(graph.ctx.baseLatency * 1000) : 0} ms</b></span><span><small>ENGINE</small><b>WEB AUDIO</b></span><span><small>LIMITER</small><b>{safeMode ? "ARMED" : "BYPASS"}</b></span></div>
        </article>

        <article className="panel automation-panel">
          <PanelHeading roman="VI" title="Temporal Automation" subtitle="Session score · bounded variation" />
          <div className="automation-toolbar"><Toggle active={automation} label="AUTOMATION" onClick={() => setAutomation(!automation)} /><div className="bpm"><button onClick={() => setBpm(clamp(bpm - 1, 30, 180))}>−</button><b>{bpm}</b><span>BPM</span><button onClick={() => setBpm(clamp(bpm + 1, 30, 180))}>+</button></div><div className="drift"><label>ORGANIC DRIFT <b>{drift.toFixed(2)}</b></label><input type="range" min="0" max="1" step="0.01" value={drift} onChange={(e) => setDrift(Number(e.target.value))} /></div><button className="write-button">WRITE</button></div>
          <div className="timeline">
            <div className="timeline-labels">{["Beat Frequency", "Carrier Drift", "Noise Veil", "Pulse Depth"].map((lane) => <button key={lane} className={selectedLane === lane ? "active" : ""} onClick={() => setSelectedLane(lane)}><i />{lane}</button>)}</div>
            <div className="timeline-grid">
              <div className="ruler">{[0, 5, 10, 15, 20, 25, 30].map((n) => <span key={n}>{n}:00</span>)}</div>
              <div className="lane beat-curve"><i /><b /><i /><b /><i /></div>
              <div className="lane drift-curve"><i /><b /><i /><b /></div>
              <div className="lane noise-curve"><i /><b /><i /></div>
              <div className="lane pulse-curve"><i /><b /><i /><b /></div>
              <div className="playhead" style={{ left: `${progress * 100}%` }}><span>{formatTime(elapsed)}</span></div>
            </div>
          </div>
        </article>
      </section>

      <footer><span>NOCTURNE LABORATORY · CHICAGO</span><p>EXPERIMENTAL WELLNESS INSTRUMENT · FREQUENCY LABELS ARE COMPOSITIONAL, NOT MEDICAL CLAIMS</p><span>BUILD 01 · M2 / CHROME</span></footer>
    </main>
  );
}

function PanelHeading({ roman, title, subtitle }: { roman: string; title: string; subtitle: string }) {
  return <header className="panel-heading"><span>{roman}</span><div><h2>{title}</h2><p>{subtitle}</p></div><i>✦</i></header>;
}
