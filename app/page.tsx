"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type BeatMode = "binaural" | "monaural" | "isochronic";
type Waveform = OscillatorType;
type LayerKey = "beat" | "veil" | "pulse" | "drone";
type LayerState = Record<LayerKey, { gain: number; pan: number; muted: boolean; solo: boolean }>;
type TubeKey = "ECC83" | "12AU7" | "6V6" | "EL34";
type AutomationParam = "carrier" | "beat" | "master" | "bpm" | "pulseDepth" | "drift" | "beatGain" | "veilGain" | "pulseGain" | "droneGain" | "beatPan" | "veilPan" | "pulsePan" | "dronePan";
type AutomationPoint = { id: string; time: number; value: number };
type AutomationTrack = { id: string; parameter: AutomationParam; points: AutomationPoint[]; selectedPointId?: string };

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
  tubeStages: WaveShaperNode[];
  beatMode: BeatMode;
};

const TUBE_KEYS: TubeKey[] = ["ECC83", "12AU7", "6V6", "EL34"];
const TUBE_DESCRIPTIONS: Record<TubeKey, string> = {
  ECC83: "Asymmetric preamp warmth",
  "12AU7": "Gentle even-harmonic bloom",
  "6V6": "Rounded power-stage compression",
  EL34: "Forward presence and edge",
};

const AUTOMATION_CONTROLS: { key: AutomationParam; label: string; min: number; max: number; step: number; unit: string }[] = [
  { key: "carrier", label: "Carrier frequency", min: 80, max: 1000, step: 1, unit: " Hz" },
  { key: "beat", label: "Beat difference", min: .5, max: 40, step: .1, unit: " Hz" },
  { key: "master", label: "Master output", min: 0, max: 1, step: .01, unit: "" },
  { key: "bpm", label: "Sync pulse tempo", min: 30, max: 180, step: 1, unit: " BPM" },
  { key: "pulseDepth", label: "Sync pulse depth", min: 0, max: 1, step: .01, unit: "" },
  { key: "drift", label: "Organic drift", min: 0, max: 1, step: .01, unit: "" },
  { key: "beatGain", label: "Binaural layer gain", min: 0, max: 1, step: .01, unit: "" },
  { key: "veilGain", label: "Noise veil gain", min: 0, max: 1, step: .01, unit: "" },
  { key: "pulseGain", label: "Sync pulse gain", min: 0, max: 1, step: .01, unit: "" },
  { key: "droneGain", label: "Substrate gain", min: 0, max: 1, step: .01, unit: "" },
  { key: "beatPan", label: "Binaural layer pan", min: -1, max: 1, step: .05, unit: "" },
  { key: "veilPan", label: "Noise veil pan", min: -1, max: 1, step: .05, unit: "" },
  { key: "pulsePan", label: "Sync pulse pan", min: -1, max: 1, step: .05, unit: "" },
  { key: "dronePan", label: "Substrate pan", min: -1, max: 1, step: .05, unit: "" },
];

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

function makeTubeCurve(kind: TubeKey, amount: number) {
  const size = 4096;
  const curve = new Float32Array(size);
  const drive = 1 + amount * (kind === "ECC83" ? 5.5 : kind === "12AU7" ? 3.2 : kind === "6V6" ? 4.3 : 6.6);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    let shaped = x;
    if (kind === "ECC83") shaped = (Math.tanh(drive * (x + amount * .055)) - Math.tanh(drive * amount * .055)) / Math.tanh(drive);
    if (kind === "12AU7") shaped = Math.tanh(drive * x) / Math.tanh(drive) + amount * .035 * (1 - x * x);
    if (kind === "6V6") shaped = Math.sin(Math.atan(drive * x)) / Math.sin(Math.atan(drive));
    if (kind === "EL34") shaped = Math.atan(drive * x) / Math.atan(drive) + amount * .025 * x * x * Math.sign(x);
    curve[i] = clamp(x * (1 - amount) + shaped * amount, -1, 1);
  }
  return curve;
}

function flatPoints(value: number): AutomationPoint[] {
  return [{ id: `p-${Date.now()}-a`, time: 0, value }, { id: `p-${Date.now()}-b`, time: 1, value }];
}

function sampleAutomation(points: AutomationPoint[], time: number) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0].value;
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;
  const index = Math.max(0, sorted.findIndex((point) => point.time >= time) - 1);
  const p0 = sorted[Math.max(0, index - 1)];
  const p1 = sorted[index];
  const p2 = sorted[Math.min(sorted.length - 1, index + 1)];
  const p3 = sorted[Math.min(sorted.length - 1, index + 2)];
  const local = (time - p1.time) / Math.max(.0001, p2.time - p1.time);
  const local2 = local * local, local3 = local2 * local;
  return clamp(.5 * ((2 * p1.value) + (-p0.value + p2.value) * local + (2 * p0.value - 5 * p1.value + 4 * p2.value - p3.value) * local2 + (-p0.value + 3 * p1.value - 3 * p2.value + p3.value) * local3), 0, 1);
}

function AutomationGraph({ points, selectedId, progress, onChange, onSelect }: { points: AutomationPoint[]; selectedId?: string; progress: number; onChange: (points: AutomationPoint[]) => void; onSelect: (id?: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1, width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = Math.max(1, width * dpr); canvas.height = Math.max(1, height * dpr); context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(80,140,132,.16)"; context.lineWidth = 1;
    for (let i = 0; i <= 8; i++) { context.beginPath(); context.moveTo((i / 8) * width, 0); context.lineTo((i / 8) * width, height); context.stroke(); }
    for (let i = 0; i <= 4; i++) { context.beginPath(); context.moveTo(0, (i / 4) * height); context.lineTo(width, (i / 4) * height); context.stroke(); }
    const sorted = [...points].sort((a, b) => a.time - b.time);
    const toX = (p: AutomationPoint) => p.time * width, toY = (p: AutomationPoint) => (1 - p.value) * (height - 16) + 8;
    context.beginPath(); context.moveTo(toX(sorted[0]), toY(sorted[0]));
    for (let i = 0; i < sorted.length - 1; i++) {
      const p0 = sorted[Math.max(0, i - 1)], p1 = sorted[i], p2 = sorted[i + 1], p3 = sorted[Math.min(sorted.length - 1, i + 2)];
      context.bezierCurveTo(toX(p1) + (toX(p2) - toX(p0)) / 6, toY(p1) + (toY(p2) - toY(p0)) / 6, toX(p2) - (toX(p3) - toX(p1)) / 6, toY(p2) - (toY(p3) - toY(p1)) / 6, toX(p2), toY(p2));
    }
    context.strokeStyle = "#68d9cf"; context.lineWidth = 2; context.shadowColor = "#54cfc5"; context.shadowBlur = 7; context.stroke(); context.shadowBlur = 0;
    for (const point of sorted) {
      context.beginPath(); context.arc(toX(point), toY(point), point.id === selectedId ? 6 : 4.5, 0, Math.PI * 2);
      context.fillStyle = point.id === selectedId ? "#f0bd68" : "#111917"; context.fill(); context.strokeStyle = point.id === selectedId ? "#ffe0a0" : "#c99a4d"; context.lineWidth = 1.5; context.stroke();
    }
    context.beginPath(); context.moveTo(progress * width, 0); context.lineTo(progress * width, height); context.strokeStyle = "#e75847"; context.lineWidth = 1; context.shadowColor = "#e75847"; context.shadowBlur = 5; context.stroke();
  }, [points, progress, selectedId]);

  const locate = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return { x: clamp((clientX - rect.left) / rect.width, 0, 1), y: clamp(1 - (clientY - rect.top - 8) / Math.max(1, rect.height - 16), 0, 1), width: rect.width, height: rect.height };
  };
  const nearest = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return points.find((point) => Math.hypot(point.time * rect.width - (clientX - rect.left), (1 - point.value) * (rect.height - 16) + 8 - (clientY - rect.top)) < 13);
  };

  return <canvas ref={canvasRef} className="automation-canvas" aria-label="Draggable automation spline" onPointerDown={(event) => { const point = nearest(event.clientX, event.clientY); dragging.current = point?.id || null; onSelect(point?.id); if (point) event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (!dragging.current) return; const pos = locate(event.clientX, event.clientY); const sorted = [...points].sort((a, b) => a.time - b.time); const index = sorted.findIndex((point) => point.id === dragging.current); const point = sorted[index]; const nextTime = index === 0 ? 0 : index === sorted.length - 1 ? 1 : clamp(pos.x, sorted[index - 1].time + .005, sorted[index + 1].time - .005); onChange(points.map((item) => item.id === point.id ? { ...item, time: nextTime, value: pos.y } : item).sort((a, b) => a.time - b.time)); }} onPointerUp={() => { dragging.current = null; }} onDoubleClick={(event) => { const point = nearest(event.clientX, event.clientY); if (point && point.time > 0 && point.time < 1) { onChange(points.filter((item) => item.id !== point.id)); onSelect(undefined); } }} />;
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
  const [tubeDrive, setTubeDrive] = useState<Record<TubeKey, number>>({ ECC83: .18, "12AU7": 0, "6V6": 0, EL34: 0 });
  const [automationTracks, setAutomationTracks] = useState<AutomationTrack[]>([
    { id: "track-carrier", parameter: "carrier", points: flatPoints((400 - 80) / (1000 - 80)) },
  ]);
  const progress = clamp(elapsed / (sessionLength * 60), 0, 1);

  const updateLayer = (key: LayerKey, patch: Partial<LayerState[LayerKey]>) => setLayers((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const currentControlValue = useCallback((parameter: AutomationParam) => {
    if (parameter === "carrier") return carrier;
    if (parameter === "beat") return beat;
    if (parameter === "master") return master;
    if (parameter === "bpm") return bpm;
    if (parameter === "pulseDepth") return pulseDepth;
    if (parameter === "drift") return drift;
    const [layerName, property] = parameter.replace("Gain", ":gain").replace("Pan", ":pan").split(":") as [LayerKey, "gain" | "pan"];
    return layers[layerName][property];
  }, [beat, bpm, carrier, drift, layers, master, pulseDepth]);

  const applyAutomatedValue = useCallback((parameter: AutomationParam, normalized: number) => {
    const spec = AUTOMATION_CONTROLS.find((control) => control.key === parameter)!;
    const raw = spec.min + normalized * (spec.max - spec.min);
    const value = Math.round(raw / spec.step) * spec.step;
    if (parameter === "carrier") setCarrier(value);
    else if (parameter === "beat") setBeat(value);
    else if (parameter === "master") setMaster(value);
    else if (parameter === "bpm") setBpm(value);
    else if (parameter === "pulseDepth") setPulseDepth(value);
    else if (parameter === "drift") setDrift(value);
    else {
      const [layerName, property] = parameter.replace("Gain", ":gain").replace("Pan", ":pan").split(":") as [LayerKey, "gain" | "pan"];
      setLayers((current) => ({ ...current, [layerName]: { ...current[layerName], [property]: value } }));
    }
  }, []);

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
    const tubeStages = TUBE_KEYS.map((key) => { const stage = ctx.createWaveShaper(); stage.curve = makeTubeCurve(key, tubeDrive[key]); stage.oversample = "4x"; return stage; });
    masterNode.connect(tubeStages[0]); tubeStages[0].connect(tubeStages[1]); tubeStages[1].connect(tubeStages[2]); tubeStages[2].connect(tubeStages[3]); tubeStages[3].connect(limiter).connect(analyser).connect(ctx.destination); analyser.connect(splitter); splitter.connect(analyserL, 0); splitter.connect(analyserR, 1);
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
    const graph: AudioGraph = { ctx, master: masterNode, limiter, analyser, analyserL, analyserR, oscillators, sources, layerGains, layerPans, carriers, pulseDepth: pulseDepthNode, tubeStages, beatMode: mode };
    graphRef.current = graph; setRunning(true); setGraphVersion((v) => v + 1);
    const now = ctx.currentTime; masterNode.gain.setValueAtTime(0, now); masterNode.gain.linearRampToValueAtTime(master * .58, now + .8);
  }, [beat, bpm, carrier, master, mode, noiseColor, pulseDepth, stopAudio, tubeDrive, waveform]);

  useEffect(() => () => { graphRef.current?.ctx.close(); }, []);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    graph.carriers.left && (graph.carriers.left.type = waveform);
    graph.carriers.right && (graph.carriers.right.type = waveform);
  }, [graphVersion, waveform]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    TUBE_KEYS.forEach((key, index) => { graph.tubeStages[index].curve = makeTubeCurve(key, tubeDrive[key]); });
  }, [graphVersion, tubeDrive]);

  useEffect(() => {
    if (!automation) return;
    automationTracks.forEach((track) => applyAutomatedValue(track.parameter, sampleAutomation(track.points, progress)));
  }, [applyAutomatedValue, automation, automationTracks, progress]);

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

  const changeTrackParameter = (trackId: string, parameter: AutomationParam) => {
    const spec = AUTOMATION_CONTROLS.find((control) => control.key === parameter)!;
    const normalized = clamp((currentControlValue(parameter) - spec.min) / (spec.max - spec.min), 0, 1);
    setAutomationTracks((tracks) => tracks.map((track) => track.id === trackId ? { ...track, parameter, points: flatPoints(normalized), selectedPointId: undefined } : track));
  };

  const addAutomationPoint = (trackId: string) => {
    setAutomationTracks((tracks) => tracks.map((track) => {
      if (track.id !== trackId) return track;
      const sorted = [...track.points].sort((a, b) => a.time - b.time);
      let gapIndex = 0;
      for (let i = 1; i < sorted.length - 1; i++) if (sorted[i + 1].time - sorted[i].time > sorted[gapIndex + 1].time - sorted[gapIndex].time) gapIndex = i;
      const time = (sorted[gapIndex].time + sorted[gapIndex + 1].time) / 2;
      const point = { id: `p-${Date.now()}-${Math.random().toString(16).slice(2)}`, time, value: sampleAutomation(sorted, time) };
      return { ...track, points: [...sorted, point].sort((a, b) => a.time - b.time), selectedPointId: point.id };
    }));
  };

  const deleteAutomationPoint = (trackId: string) => {
    setAutomationTracks((tracks) => tracks.map((track) => {
      if (track.id !== trackId || !track.selectedPointId) return track;
      const selected = track.points.find((point) => point.id === track.selectedPointId);
      if (!selected || selected.time === 0 || selected.time === 1) return track;
      return { ...track, points: track.points.filter((point) => point.id !== track.selectedPointId), selectedPointId: undefined };
    }));
  };

  const addAutomationTrack = () => {
    if (automationTracks.length >= 6) return;
    const used = new Set(automationTracks.map((track) => track.parameter));
    const parameter = AUTOMATION_CONTROLS.find((control) => !used.has(control.key))?.key || "carrier";
    const spec = AUTOMATION_CONTROLS.find((control) => control.key === parameter)!;
    const normalized = clamp((currentControlValue(parameter) - spec.min) / (spec.max - spec.min), 0, 1);
    setAutomationTracks((tracks) => [...tracks, { id: `track-${Date.now()}`, parameter, points: flatPoints(normalized) }]);
  };

  const formatAutomationValue = (parameter: AutomationParam) => {
    const spec = AUTOMATION_CONTROLS.find((control) => control.key === parameter)!;
    const value = currentControlValue(parameter);
    return `${value.toFixed(spec.step < .1 ? 2 : spec.step < 1 ? 1 : 0)}${spec.unit}`;
  };

  const band = beat < 4 ? "DELTA" : beat < 8 ? "THETA" : beat < 13 ? "ALPHA" : beat < 30 ? "BETA" : "EXPERIMENTAL";
  const graph = graphRef.current;
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
          <PanelHeading roman="V" title="Thermionic Monitor" subtitle="Metering & four-stage harmonic colour" />
          <div className="vu-pair"><VUMeter analyser={graph?.analyserL || null} label="LEFT" running={running} /><VUMeter analyser={graph?.analyserR || null} label="RIGHT" running={running} /></div>
          <div className="tube-bank">{TUBE_KEYS.map((tube, index) => <div key={tube} className={`tube-stage ${running && tubeDrive[tube] > 0 ? "energized" : ""}`} style={{ "--tube-drive": tubeDrive[tube], animationDelay: `${index * .13}s` } as React.CSSProperties} title={TUBE_DESCRIPTIONS[tube]}><button aria-label={`${tube} ${TUBE_DESCRIPTIONS[tube]}`} onClick={() => setTubeDrive((current) => ({ ...current, [tube]: current[tube] > 0 ? 0 : .3 }))}><span /><i /><b>{tube}</b></button><input aria-label={`${tube} drive`} type="range" min="0" max="1" step="0.01" value={tubeDrive[tube]} onChange={(event) => setTubeDrive((current) => ({ ...current, [tube]: Number(event.target.value) }))} /><small>{(tubeDrive[tube] * 100).toFixed(0)}%</small></div>)}</div>
          <div className="tube-legend"><span>PREAMP WARMTH</span><span>EVEN BLOOM</span><span>POWER SAG</span><span>PRESENCE</span></div>
          <div className="hardware-stats"><span><small>LATENCY</small><b>{running && graph ? Math.round(graph.ctx.baseLatency * 1000) : 0} ms</b></span><span><small>COLOUR</small><b>{TUBE_KEYS.filter((tube) => tubeDrive[tube] > 0).length} STAGES</b></span><span><small>LIMITER</small><b>{safeMode ? "ARMED" : "BYPASS"}</b></span></div>
        </article>

        <article className="panel automation-panel">
          <PanelHeading roman="VI" title="Temporal Automation" subtitle="Live parameter splines · no write pass required" />
          <div className="automation-toolbar"><Toggle active={automation} label="LIVE AUTOMATION" onClick={() => setAutomation(!automation)} /><div className="bpm"><button onClick={() => setBpm(clamp(bpm - 1, 30, 180))}>−</button><b>{bpm}</b><span>BPM</span><button onClick={() => setBpm(clamp(bpm + 1, 30, 180))}>+</button></div><div className="drift"><label>ORGANIC DRIFT <b>{drift.toFixed(2)}</b></label><input type="range" min="0" max="1" step="0.01" value={drift} onChange={(e) => setDrift(Number(e.target.value))} /></div><div className="drift"><label>PULSE DEPTH <b>{pulseDepth.toFixed(2)}</b></label><input type="range" min="0" max="1" step="0.01" value={pulseDepth} onChange={(e) => setPulseDepth(Number(e.target.value))} /></div><button className="add-track" disabled={automationTracks.length >= 6} onClick={addAutomationTrack}>＋ ADD CONTROL</button></div>
          <div className="automation-help"><span>SELECT A CONTROL</span><p>Lines begin flat. Add a handle, then drag it vertically for value and horizontally for time. Double-click an interior handle to delete it.</p><b>{automation ? `LIVE · ${formatTime(elapsed)}` : "BYPASSED"}</b></div>
          <div className="automation-ruler">{[0, .25, .5, .75, 1].map((value) => <span key={value}>{Math.round(value * sessionLength)}:00</span>)}</div>
          <div className="automation-tracks">
            {automationTracks.map((track) => <div className="automation-track" key={track.id}>
              <div className="track-controls">
                <select aria-label="Automated control" value={track.parameter} onChange={(event) => changeTrackParameter(track.id, event.target.value as AutomationParam)}>{AUTOMATION_CONTROLS.map((control) => <option key={control.key} value={control.key}>{control.label}</option>)}</select>
                <output>{formatAutomationValue(track.parameter)}</output>
                <button title="Add control handle" onClick={() => addAutomationPoint(track.id)}>＋ HANDLE</button>
                <button title="Delete selected handle" disabled={!track.selectedPointId || !!track.points.find((point) => point.id === track.selectedPointId && (point.time === 0 || point.time === 1))} onClick={() => deleteAutomationPoint(track.id)}>− HANDLE</button>
                <button className="remove-track" title="Remove automation track" disabled={automationTracks.length === 1} onClick={() => setAutomationTracks((tracks) => tracks.filter((item) => item.id !== track.id))}>×</button>
              </div>
              <AutomationGraph points={track.points} selectedId={track.selectedPointId} progress={progress} onSelect={(selectedPointId) => setAutomationTracks((tracks) => tracks.map((item) => item.id === track.id ? { ...item, selectedPointId } : item))} onChange={(points) => setAutomationTracks((tracks) => tracks.map((item) => item.id === track.id ? { ...item, points } : item))} />
            </div>)}
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
