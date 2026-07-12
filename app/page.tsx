"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { encodeFlacFromBuffer, downloadBytes } from "./flac";

type BeatMode = "binaural" | "monaural" | "isochronic";
type Waveform = OscillatorType;
type AmShape = "sine" | "triangle" | "square";
type NoiseColor = "WHITE" | "PINK" | "BROWN" | "BLUE" | "VIOLET" | "GREY";
type VeilType = "off" | "lowpass" | "highpass" | "bandpass" | "notch" | "peaking";
type LayerKey = "beat" | "veil" | "pulse" | "drone";
type LayerState = Record<LayerKey, { gain: number; pan: number; muted: boolean; solo: boolean }>;
type TubeKey = "ECC83" | "12AU7" | "6V6" | "EL34";
type AutomationParam = string;
type AutomationPoint = { id: string; time: number; value: number };
type AutomationTrack = { id: string; parameter: AutomationParam; points: AutomationPoint[]; selectedPointId?: string; snap?: boolean };

type BeatLayer = {
  oscillators: OscillatorNode[];
  carriers: { left?: OscillatorNode; right?: OscillatorNode };
};

type DronePart = { osc: OscillatorNode; mult: number };
type PulseEngine = { tone: OscillatorNode; sum: GainNode; amps: GainNode[]; gates: OscillatorNode[]; depths: GainNode[] };
type NoiseSource = { source: AudioBufferSourceNode; gain: GainNode };

type AudioGraph = {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  oscillators: OscillatorNode[];
  beatOscillators: OscillatorNode[];
  sources: AudioBufferSourceNode[];
  layerGains: Record<LayerKey, GainNode>;
  layerPans: Record<LayerKey, StereoPannerNode>;
  layerAnalysers: Record<LayerKey, AnalyserNode>;
  carriers: { left?: OscillatorNode; right?: OscillatorNode; pulse?: OscillatorNode; drone?: OscillatorNode };
  // #2 amplitude-modulation lab + #5 theta–gamma nesting
  beatAM: GainNode; beatAMLfo: OscillatorNode; beatAMDepth: GainNode; nestLfo: OscillatorNode; nestDepth: GainNode;
  // #7 noise laboratory (veil signal chain + multi-colour source bank)
  veilTiltLow: BiquadFilterNode; veilTiltHigh: BiquadFilterNode; veilShape: BiquadFilterNode; veilComod: GainNode; comodLfo: OscillatorNode; comodDepth: GainNode;
  veilSweepLfo: OscillatorNode; veilSweepDepth: GainNode; noiseSources: Record<NoiseColor, NoiseSource>;
  // #3 illusions (in the layer matrix)
  droneParts: DronePart[];
  pulse: PulseEngine;
  // #1 audible gamma engine (own bus)
  gammaCarrier: OscillatorNode; gammaAM: GainNode; gammaAMDepth: GainNode; gammaLfo: OscillatorNode; gammaBus: GainNode;
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

const LAYER_HUE: Record<LayerKey, string> = { beat: "var(--amber)", veil: "var(--cyan)", pulse: "var(--ruby)", drone: "var(--violet)" };
const NOISE_COLORS: NoiseColor[] = ["WHITE", "PINK", "BROWN", "BLUE", "VIOLET", "GREY"];
const MAX_PULSE_LAYERS = 5;

// Single registry of every automatable control: metadata + source panel/hue.
// Powers the automation dropdown, right-click-to-automate, and double-click defaults.
type ParamDef = { key: AutomationParam; label: string; min: number; max: number; step: number; unit: string; def: number; panel: string; group: string; hue: string };
const A = "var(--amber)", C = "var(--cyan)", R = "var(--ruby)", V = "var(--violet)", B = "var(--brass-hi)";
const PARAM_DEFS: ParamDef[] = [
  { key: "carrier", label: "Carrier frequency", min: 80, max: 1000, step: 1, unit: " Hz", def: 400, panel: "I", group: "Beat Engine", hue: A },
  { key: "beat", label: "Beat difference", min: .5, max: 40, step: .1, unit: " Hz", def: 10, panel: "I", group: "Beat Engine", hue: A },
  { key: "amDepth", label: "AM depth", min: 0, max: 1, step: .01, unit: "", def: 0, panel: "I", group: "Beat Engine", hue: A },
  { key: "thetaRate", label: "θ-nest rate", min: 2, max: 8, step: .1, unit: " Hz", def: 5, panel: "I", group: "Beat Engine", hue: A },
  { key: "nestOn", label: "θ–γ nest on/off", min: 0, max: 1, step: 1, unit: "", def: 0, panel: "I", group: "Beat Engine", hue: A },
  { key: "beatGain", label: "Binaural gain", min: 0, max: 1, step: .01, unit: "", def: .44, panel: "I", group: "Beat Engine", hue: A },
  { key: "beatPan", label: "Binaural pan", min: -1, max: 1, step: .05, unit: "", def: 0, panel: "I", group: "Beat Engine", hue: A },
  { key: "master", label: "Master output", min: 0, max: 1, step: .01, unit: "", def: .52, panel: "MST", group: "Master", hue: C },
  { key: "veilGain", label: "Noise veil gain", min: 0, max: 1, step: .01, unit: "", def: .16, panel: "II", group: "Noise Veil", hue: C },
  { key: "veilPan", label: "Noise veil pan", min: -1, max: 1, step: .05, unit: "", def: 0, panel: "II", group: "Noise Veil", hue: C },
  { key: "veilCenter", label: "Veil filter centre", min: 80, max: 10000, step: 10, unit: " Hz", def: 1000, panel: "VII", group: "Noise Lab", hue: C },
  { key: "veilQ", label: "Veil resonance", min: .3, max: 24, step: .3, unit: "", def: 6, panel: "VII", group: "Noise Lab", hue: C },
  { key: "veilGainDb", label: "Veil filter gain", min: -24, max: 24, step: 1, unit: " dB", def: 0, panel: "VII", group: "Noise Lab", hue: C },
  { key: "veilSweepRate", label: "Veil sweep rate", min: 0, max: 4, step: .05, unit: " Hz", def: 0, panel: "VII", group: "Noise Lab", hue: C },
  { key: "veilSweepDepth", label: "Veil sweep depth", min: 0, max: 1, step: .01, unit: "", def: 0, panel: "VII", group: "Noise Lab", hue: C },
  { key: "veilTilt", label: "Spectral tilt", min: -1, max: 1, step: .05, unit: "", def: 0, panel: "VII", group: "Noise Lab", hue: C },
  { key: "comodRate", label: "Comod rate", min: .2, max: 30, step: .1, unit: " Hz", def: 9, panel: "VII", group: "Noise Lab", hue: C },
  { key: "comodDepth", label: "Comod depth", min: 0, max: 1, step: .01, unit: "", def: .4, panel: "VII", group: "Noise Lab", hue: C },
  { key: "comodOn", label: "Comod on/off", min: 0, max: 1, step: 1, unit: "", def: 0, panel: "VII", group: "Noise Lab", hue: C },
  { key: "bpm", label: "Sync pulse tempo", min: 30, max: 180, step: 1, unit: " BPM", def: 60, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulseDepth", label: "Sync pulse depth", min: 0, max: 1, step: .01, unit: "", def: .42, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulseToneHz", label: "Pulse tone pitch", min: 40, max: 800, step: 1, unit: " Hz", def: 200, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulseDuty", label: "Pulse duty", min: .1, max: .9, step: .01, unit: "", def: .5, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulseSmooth", label: "Pulse smoothing", min: 0, max: 1, step: .01, unit: "", def: .5, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulseGain", label: "Sync pulse gain", min: 0, max: 1, step: .01, unit: "", def: .12, panel: "III", group: "Sync Pulse", hue: R },
  { key: "pulsePan", label: "Sync pulse pan", min: -1, max: 1, step: .05, unit: "", def: 0, panel: "III", group: "Sync Pulse", hue: R },
  { key: "rissetRate", label: "Risset drift", min: .005, max: .15, step: .005, unit: "", def: .04, panel: "III", group: "Sync Pulse", hue: R },
  { key: "rissetRatio", label: "Risset ratio", min: 1.5, max: 4, step: .1, unit: "", def: 2, panel: "III", group: "Sync Pulse", hue: R },
  { key: "rissetFocus", label: "Risset focus", min: .4, max: 1.6, step: .05, unit: "", def: .8, panel: "III", group: "Sync Pulse", hue: R },
  { key: "rissetLayers", label: "Risset layers", min: 2, max: 5, step: 1, unit: "", def: 3, panel: "III", group: "Sync Pulse", hue: R },
  { key: "rissetOn", label: "Risset on/off", min: 0, max: 1, step: 1, unit: "", def: 0, panel: "III", group: "Sync Pulse", hue: R },
  { key: "droneGain", label: "Substrate gain", min: 0, max: 1, step: .01, unit: "", def: .14, panel: "IV", group: "Substrate", hue: V },
  { key: "dronePan", label: "Substrate pan", min: -1, max: 1, step: .05, unit: "", def: 0, panel: "IV", group: "Substrate", hue: V },
  { key: "mfPartials", label: "Missing-f partials", min: 3, max: 7, step: 1, unit: "", def: 5, panel: "IV", group: "Substrate", hue: V },
  { key: "mfBrightness", label: "Missing-f brightness", min: 0, max: .9, step: .05, unit: "", def: .4, panel: "IV", group: "Substrate", hue: V },
  { key: "missingFund", label: "Missing-f on/off", min: 0, max: 1, step: 1, unit: "", def: 0, panel: "IV", group: "Substrate", hue: V },
  { key: "gammaRate", label: "Gamma rate", min: 30, max: 100, step: 1, unit: " Hz", def: 40, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaCarrierHz", label: "Gamma carrier", min: 80, max: 1000, step: 1, unit: " Hz", def: 220, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaDepth", label: "Gamma depth", min: 0, max: 1, step: .01, unit: "", def: .9, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaDuty", label: "Gamma duty", min: .05, max: .95, step: .01, unit: "", def: .5, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaEdge", label: "Gamma edge", min: 0, max: 1, step: .01, unit: "", def: .3, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaLevel", label: "Gamma level", min: 0, max: .8, step: .01, unit: "", def: .3, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "gammaOn", label: "Gamma on/off", min: 0, max: 1, step: 1, unit: "", def: 0, panel: "VII", group: "Gamma Engine", hue: A },
  { key: "drift", label: "Organic drift", min: 0, max: 1, step: .01, unit: "", def: .18, panel: "VI", group: "Automation", hue: B },
];
const PARAM_MAP: Record<string, ParamDef> = Object.fromEntries(PARAM_DEFS.map((p) => [p.key, p]));
const AUTOMATION_GROUPS = [...new Set(PARAM_DEFS.map((p) => p.group))];

// Double-click a control to reset it (reset), right-click to add it to automation (automate).
type ControlActions = { reset: (key: string, fallback?: number) => void; automate: (key: string) => void };
const ControlContext = createContext<ControlActions | null>(null);
const useControls = () => useContext(ControlContext);

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

// Build the binaural/monaural/isochronic beat oscillators into `dest`. Shared by
// initial start and live topology crossfade so the mode can change while running.
// The isochronic "gate" is now produced by the shared AM stage (#2), so this only
// generates the tone(s); a single carrier suffices for isochronic.
function buildBeatLayer(ctx: BaseAudioContext, dest: AudioNode, mode: BeatMode, waveform: Waveform, carrier: number, beat: number): BeatLayer {
  const oscillators: OscillatorNode[] = [];
  const carriers: BeatLayer["carriers"] = {};
  if (mode === "binaural") {
    const left = ctx.createOscillator(), right = ctx.createOscillator();
    left.type = right.type = waveform; left.frequency.value = carrier - beat / 2; right.frequency.value = carrier + beat / 2;
    const merger = ctx.createChannelMerger(2); left.connect(merger, 0, 0); right.connect(merger, 0, 1); merger.connect(dest);
    oscillators.push(left, right); carriers.left = left; carriers.right = right;
  } else if (mode === "monaural") {
    const one = ctx.createOscillator(), two = ctx.createOscillator();
    one.type = two.type = waveform; one.frequency.value = carrier - beat / 2; two.frequency.value = carrier + beat / 2;
    one.connect(dest); two.connect(dest);
    oscillators.push(one, two); carriers.left = one; carriers.right = two;
  } else {
    const iso = ctx.createOscillator(); iso.type = waveform; iso.frequency.value = carrier;
    iso.connect(dest);
    oscillators.push(iso); carriers.left = iso;
  }
  return { oscillators, carriers };
}

function gaussian(x: number, center: number, width: number) {
  const z = (x - center) / width;
  return Math.exp(-0.5 * z * z);
}

// #7 — spectrally-shaped noise. White/brown as before, plus pink (Paul Kellet),
// blue (+3 dB/oct), violet (+6 dB/oct), and a perceptually-flatter grey.
function makeNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor) {
  const len = Math.floor(ctx.sampleRate * 4);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    if (color === "BROWN") {
      let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = b * 3.4; }
    } else if (color === "PINK") {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
    } else if (color === "BLUE") {
      let prev = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; d[i] = (w - prev) * 0.5; prev = w; }
    } else if (color === "VIOLET") {
      let p0 = 0, p1 = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; const dd = w - p0; d[i] = (dd - p1) * 0.4; p1 = dd; p0 = w; }
    } else if (color === "GREY") {
      let m = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; m = 0.98 * m + 0.02 * w; d[i] = clamp((w - m) * 0.9 + w * 0.3, -1, 1); }
    } else {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
  }
  return buffer;
}

// #3 — substrate: normal low triangle, or a harmonic stack with no fundamental
// (missing-fundamental illusion). `partials` = how many harmonics; `brightness`
// tilts their rolloff so the timbre can go dark → bright.
function buildDrone(ctx: BaseAudioContext, dest: AudioNode, carrier: number, missingFund: boolean, partials: number, brightness: number): { oscillators: OscillatorNode[]; parts: DronePart[] } {
  const f = carrier / 4;
  if (missingFund) {
    const parts: DronePart[] = [];
    for (let k = 0; k < partials; k++) {
      const n = k + 2; // start at 2nd harmonic — the fundamental (n=1) is omitted
      const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = n * f;
      const g = ctx.createGain(); g.gain.value = (0.55 / Math.pow(n, 1.2 - brightness)); osc.connect(g).connect(dest);
      parts.push({ osc, mult: n });
    }
    return { oscillators: parts.map((p) => p.osc), parts };
  }
  const osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = f;
  const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 680; osc.connect(filter).connect(dest);
  return { oscillators: [osc], parts: [{ osc, mult: 1 }] };
}

// #3 — sync pulse as up to five gated layers. The gate is an edge-softened,
// band-limited pulse (raised-cosine-like) rather than a hard square, which removes
// the click at each pulse edge. `duty` sets the plateau width, `smooth` the ramp.
// With one layer active it is an isochronic gate; crossfading several yields Risset.
function buildPulse(ctx: BaseAudioContext, dest: AudioNode, toneHz: number, wave: Waveform, bpm: number, pulseDepth: number, duty: number, smooth: number): PulseEngine {
  const tone = ctx.createOscillator(); tone.type = wave; tone.frequency.value = toneHz;
  const sum = ctx.createGain(); sum.gain.value = 1; sum.connect(dest);
  const gateWave = makeGammaWave(ctx, duty, smooth);
  const amps: GainNode[] = [], gates: OscillatorNode[] = [], depths: GainNode[] = [];
  const base = (bpm / 60) * 2;
  for (let i = 0; i < MAX_PULSE_LAYERS; i++) {
    const d = i === 0 ? pulseDepth * 0.5 : 0;
    const amp = ctx.createGain(); amp.gain.value = d; tone.connect(amp).connect(sum);
    const gate = ctx.createOscillator(); gate.setPeriodicWave(gateWave); gate.frequency.value = base * Math.pow(2, i);
    const depth = ctx.createGain(); depth.gain.value = d; gate.connect(depth).connect(amp.gain);
    amps.push(amp); gates.push(gate); depths.push(depth);
  }
  return { tone, sum, amps, gates, depths };
}

// #1 — band-limited pulse wave for the gamma modulator. `duty` sets the on-fraction,
// `edge` softens the harmonics (0 = hard square/pulse, 1 = near-sine).
function makeGammaWave(ctx: BaseAudioContext, duty: number, edge: number) {
  const N = 48;
  const real = new Float32Array(N + 1); const imag = new Float32Array(N + 1);
  const d = clamp(duty, 0.03, 0.97);
  for (let n = 1; n <= N; n++) real[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * d) * Math.exp(-n * edge * 0.9);
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

// RMS level of an analyser, mapped to 0..1 over a roughly -48..0 dBFS window.
function analyserLevel(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) { const n = v / 128 - 1; sum += n * n; }
  const db = 20 * Math.log10(Math.max(0.0001, Math.sqrt(sum / data.length)));
  return clamp((db + 48) / 48, 0, 1);
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

function AutomationGraph({ points, selectedId, progress, snap, hue, onChange, onSelect, onSeek }: { points: AutomationPoint[]; selectedId?: string; progress: number; snap?: boolean; hue: string; onChange: (points: AutomationPoint[]) => void; onSelect: (id?: string) => void; onSeek: (progress: number) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<string | null>(null);
  const seeking = useRef(false);
  const stroke = hue.includes("cyan") ? "#68d9cf" : hue.includes("ruby") ? "#e2685c" : hue.includes("violet") ? "#c79bd8" : "#e6b45f";

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
    context.strokeStyle = stroke; context.lineWidth = 2; context.shadowColor = stroke; context.shadowBlur = 7; context.stroke(); context.shadowBlur = 0;
    for (const point of sorted) {
      context.beginPath(); context.arc(toX(point), toY(point), point.id === selectedId ? 6 : 4.5, 0, Math.PI * 2);
      context.fillStyle = point.id === selectedId ? "#f0bd68" : "#111917"; context.fill(); context.strokeStyle = point.id === selectedId ? "#ffe0a0" : "#c99a4d"; context.lineWidth = 1.5; context.stroke();
    }
    context.beginPath(); context.moveTo(progress * width, 0); context.lineTo(progress * width, height); context.strokeStyle = "#e75847"; context.lineWidth = 1.5; context.shadowColor = "#e75847"; context.shadowBlur = 6; context.stroke();
    context.beginPath(); context.moveTo(progress * width - 6, 0); context.lineTo(progress * width + 6, 0); context.lineTo(progress * width, 9); context.closePath(); context.fillStyle = "#e75847"; context.fill(); context.shadowBlur = 0;
  }, [points, progress, selectedId, stroke]);

  const quantize = (time: number) => snap ? Math.round(time * 16) / 16 : time;
  const locate = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return { x: clamp((clientX - rect.left) / rect.width, 0, 1), y: clamp(1 - (clientY - rect.top - 8) / Math.max(1, rect.height - 16), 0, 1), width: rect.width, height: rect.height };
  };
  const nearest = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current!; const rect = canvas.getBoundingClientRect();
    return points.find((point) => Math.hypot(point.time * rect.width - (clientX - rect.left), (1 - point.value) * (rect.height - 16) + 8 - (clientY - rect.top)) < 13);
  };

  return <canvas ref={canvasRef} className="automation-canvas" aria-label="Draggable automation spline and session playhead" onPointerDown={(event) => { const pos = locate(event.clientX, event.clientY); const rect = event.currentTarget.getBoundingClientRect(); if (Math.abs(pos.x - progress) * rect.width < 14) { seeking.current = true; dragging.current = null; onSelect(undefined); onSeek(pos.x); event.currentTarget.setPointerCapture(event.pointerId); return; } const point = nearest(event.clientX, event.clientY); dragging.current = point?.id || null; onSelect(point?.id); if (point) event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { const pos = locate(event.clientX, event.clientY); if (seeking.current) { onSeek(pos.x); return; } if (!dragging.current) { const rect = event.currentTarget.getBoundingClientRect(); event.currentTarget.style.cursor = Math.abs(pos.x - progress) * rect.width < 14 ? "ew-resize" : nearest(event.clientX, event.clientY) ? "grab" : "crosshair"; return; } const sorted = [...points].sort((a, b) => a.time - b.time); const index = sorted.findIndex((point) => point.id === dragging.current); const point = sorted[index]; const nextTime = index === 0 ? 0 : index === sorted.length - 1 ? 1 : clamp(quantize(pos.x), sorted[index - 1].time + .005, sorted[index + 1].time - .005); onChange(points.map((item) => item.id === point.id ? { ...item, time: nextTime, value: pos.y } : item).sort((a, b) => a.time - b.time)); }} onPointerUp={() => { dragging.current = null; seeking.current = false; }} onPointerCancel={() => { dragging.current = null; seeking.current = false; }} onDoubleClick={(event) => { const point = nearest(event.clientX, event.clientY); if (point && point.time > 0 && point.time < 1) { onChange(points.filter((item) => item.id !== point.id)); onSelect(undefined); } }} />;
}

function Knob({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  size = "md",
  paramKey,
  defaultValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  size?: "sm" | "md" | "lg";
  paramKey?: string;
  defaultValue?: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ y: number; value: number; moved: boolean } | null>(null);
  const controls = useControls();
  const ratio = (value - min) / (max - min);
  const degrees = -135 + ratio * 270;
  const set = (next: number) => onChange(Math.round(clamp(next, min, max) / step) * step);
  const display = `${Number.isInteger(step) ? value.toFixed(0) : value.toFixed(step < 0.1 ? 2 : 1)}${unit}`;
  const automatable = !!(paramKey && controls);

  return (
    <div className={`knob-control knob-${size}`}>
      <div
        className="knob"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        title={`${label}: ${display} — drag ↕ · scroll · double-click resets${automatable ? " · right-click automates" : ""}`}
        tabIndex={0}
        style={{ "--angle": `${degrees}deg`, "--fill": `${ratio * 75}%` } as React.CSSProperties}
        onPointerDown={(event) => {
          drag.current = { y: event.clientY, value, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.moved = true;
          set(drag.current.value + ((drag.current.y - event.clientY) / 160) * (max - min));
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(event) => {
          event.preventDefault();
          set(value + (event.deltaY < 0 ? step : -step));
        }}
        onDoubleClick={() => { if (paramKey && controls) controls.reset(paramKey, value); else onChange(defaultValue ?? min); }}
        onContextMenu={(event) => { if (automatable) { event.preventDefault(); controls!.automate(paramKey!); } }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowRight"].includes(event.key)) set(value + step);
          if (["ArrowDown", "ArrowLeft"].includes(event.key)) set(value - step);
          if (event.key === "Home") set(min);
          if (event.key === "End") set(max);
        }}
      >
        <span className="knob-cap"><i /></span>
        <span className="knob-hint" aria-hidden="true">↕</span>
      </div>
      <output>{display}</output>
      <label>{label}</label>
    </div>
  );
}

// Styled range slider with double-click reset and right-click automate.
function Slider({ value, min, max, step, onChange, paramKey, defaultValue, disabled, className, ariaLabel }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; paramKey?: string; defaultValue?: number; disabled?: boolean; className?: string; ariaLabel?: string }) {
  const controls = useControls();
  const automatable = !!(paramKey && controls);
  return (
    <input
      type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      className={className}
      aria-label={ariaLabel}
      title={`double-click resets${automatable ? " · right-click automates" : ""}`}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={() => { if (paramKey && controls) controls.reset(paramKey, value); else if (defaultValue !== undefined) onChange(defaultValue); }}
      onContextMenu={(e) => { if (automatable) { e.preventDefault(); controls!.automate(paramKey!); } }}
    />
  );
}

function Toggle({ active, label, onClick, paramKey }: { active: boolean; label: string; onClick: () => void; paramKey?: string }) {
  const controls = useControls();
  const automatable = !!(paramKey && controls);
  return <button className={`toggle ${active ? "active" : ""}`} onClick={onClick} title={automatable ? "double-click resets · right-click automates" : undefined}
    onDoubleClick={() => { if (paramKey && controls) controls.reset(paramKey, active ? 1 : 0); }}
    onContextMenu={(e) => { if (automatable) { e.preventDefault(); controls!.automate(paramKey!); } }}><span />{label}</button>;
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

// Vertical segmented level meter for a single mixer bus.
function ChannelMeter({ analyser, running, active }: { analyser: AnalyserNode | null; running: boolean; active: boolean }) {
  const segments = 14;
  const [lit, setLit] = useState(0);
  useEffect(() => {
    if (!analyser || !running || !active) { setLit(0); return; }
    let frame = 0, last = 0;
    const data = new Uint8Array(analyser.fftSize);
    const tick = (now: number) => {
      if (now - last > 50) { setLit(Math.round(analyserLevel(analyser, data) * segments)); last = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [analyser, running, active]);
  return (
    <div className="chan-meter" aria-hidden="true">
      {Array.from({ length: segments }).map((_, i) => {
        const idx = segments - 1 - i;
        const on = idx < lit;
        const zone = idx >= segments - 2 ? "r" : idx >= segments - 5 ? "a" : "g";
        return <i key={idx} className={on ? `on-${zone}` : ""} />;
      })}
    </div>
  );
}

// Stereo segmented output meter for the persistent transport rail.
function OutputMeter({ analyserL, analyserR, running }: { analyserL: AnalyserNode | null; analyserR: AnalyserNode | null; running: boolean }) {
  const segments = 11;
  const [levels, setLevels] = useState<[number, number]>([0, 0]);
  useEffect(() => {
    if (!running || !analyserL || !analyserR) { setLevels([0, 0]); return; }
    let frame = 0, last = 0;
    const dl = new Uint8Array(analyserL.fftSize), dr = new Uint8Array(analyserR.fftSize);
    const tick = (now: number) => {
      if (now - last > 50) { setLevels([Math.round(analyserLevel(analyserL, dl) * segments), Math.round(analyserLevel(analyserR, dr) * segments)]); last = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [analyserL, analyserR, running]);
  return (
    <div className="output-meter" aria-label="Output level meter">
      {(["L", "R"] as const).map((ch, row) => (
        <div className="om-row" key={ch}><span>{ch}</span><div className="om-leds">
          {Array.from({ length: segments }).map((_, i) => {
            const on = i < levels[row];
            const zone = i >= segments - 2 ? "r" : i >= segments - 4 ? "a" : "g";
            return <i key={i} className={on ? `on-${zone}` : ""} />;
          })}
        </div></div>
      ))}
    </div>
  );
}

// Live carrier topology for the Auditory Beat panel — fills the former void.
function TopologyDiagram({ carrier, beat, mode }: { carrier: number; beat: number; mode: BeatMode }) {
  const left = carrier - beat / 2, right = carrier + beat / 2;
  const spread = clamp(beat / 40, 0, 1);
  return (
    <div className="topology" aria-hidden="true">
      <div className="topo-label">CARRIER TOPOLOGY</div>
      <svg viewBox="0 0 240 74" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="node" cx="50%" cy="45%" r="60%"><stop offset="0%" stopColor="#f2c977" /><stop offset="100%" stopColor="#6b4d20" /></radialGradient>
        </defs>
        <line x1="46" y1="37" x2="194" y2="37" stroke="#3a4b47" strokeWidth="1" />
        {mode !== "isochronic" ? <>
          <circle cx={46 - spread * 6} cy="37" r="13" fill="url(#node)" stroke="#a3773e" />
          <circle cx={194 + spread * 6} cy="37" r="13" fill="url(#node)" stroke="#a3773e" />
          <text x="46" y="41" textAnchor="middle" fontSize="10" fill="#1a130a" fontFamily="Georgia,serif">L</text>
          <text x="194" y="41" textAnchor="middle" fontSize="10" fill="#1a130a" fontFamily="Georgia,serif">R</text>
          <text x="46" y="66" textAnchor="middle" fontSize="9" fill="#8de7df" fontFamily="monospace">{left.toFixed(1)}</text>
          <text x="194" y="66" textAnchor="middle" fontSize="9" fill="#8de7df" fontFamily="monospace">{right.toFixed(1)}</text>
          <ellipse className="topo-beat" cx="120" cy="37" rx="24" ry="16" fill="none" stroke="#e0a34a" strokeWidth="1.2" style={{ animationDuration: `${clamp(1 / Math.max(beat, .5), .05, 2)}s` }} />
          <text x="120" y="16" textAnchor="middle" fontSize="8" fill="#d6a855" fontFamily="monospace">Δ {beat.toFixed(1)} Hz</text>
        </> : <>
          <circle cx="120" cy="37" r="15" fill="url(#node)" stroke="#a3773e" />
          <circle className="topo-gate" cx="120" cy="37" r="22" fill="none" stroke="#e0a34a" strokeWidth="1.2" style={{ animationDuration: `${clamp(1 / Math.max(beat, .5), .05, 2)}s` }} />
          <text x="120" y="41" textAnchor="middle" fontSize="10" fill="#1a130a" fontFamily="Georgia,serif">M</text>
          <text x="120" y="66" textAnchor="middle" fontSize="9" fill="#8de7df" fontFamily="monospace">{carrier.toFixed(0)} Hz · {beat.toFixed(1)} gate</text>
        </>}
      </svg>
    </div>
  );
}

// Relative-exposure indicator for the Master panel (compositional, not medical).
function ExposureMeter({ progress, master, running }: { progress: number; master: number; running: boolean }) {
  const dose = clamp(progress * (0.4 + master), 0, 1);
  const zone = dose > 0.82 ? "hot" : dose > 0.55 ? "warm" : "cool";
  return (
    <div className={`exposure exposure-${zone}`}>
      <div className="exp-head"><span>RELATIVE EXPOSURE</span><b>{running ? `${Math.round(dose * 100)}%` : "—"}</b></div>
      <div className="exp-track"><i style={{ width: `${dose * 100}%` }} /><em style={{ left: "82%" }} /></div>
      <div className="exp-foot"><small>SESSION DOSE</small><small>{running ? "MONITORING" : "IDLE"}</small></div>
    </div>
  );
}

function Fader({ value, onChange, label, paramKey }: { value: number; onChange: (n: number) => void; label: string; paramKey?: string }) {
  const controls = useControls();
  const automatable = !!(paramKey && controls);
  return (
    <label className="fader">
      <span className="fader-scale">{[0, -6, -12, -24, -48].map((v) => <i key={v}>{v}</i>)}</span>
      <input aria-label={`${label} level`} type="range" min="0" max="1" step="0.01" value={value}
        title={`double-click resets${automatable ? " · right-click automates" : ""}`}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => { if (paramKey && controls) controls.reset(paramKey, value); }}
        onContextMenu={(e) => { if (automatable) { e.preventDefault(); controls!.automate(paramKey!); } }} />
    </label>
  );
}

// Tweak 3 — the four thermionic stages as a vintage circuit: valve envelopes in
// series with animated current flow, glowing by drive. Clean knobs live below it.
function TubeCircuit({ running, tubeDrive }: { running: boolean; tubeDrive: Record<TubeKey, number> }) {
  const xs = [58, 148, 238, 328];
  const cy = 46;
  return (
    <svg viewBox="0 0 386 92" className={`tube-circuit ${running ? "running" : ""}`} preserveAspectRatio="xMidYMid meet" aria-label="Thermionic stage circuit">
      <g className="tc-wires">
        <path className={`tc-wire ${running ? "on" : ""}`} d={`M6,${cy} H${xs[0] - 20}`} />
        {xs.map((x, i) => i < xs.length - 1 && <path key={i} className={`tc-wire ${running && tubeDrive[TUBE_KEYS[i]] > 0 ? "on" : ""}`} d={`M${x + 20},${cy} H${xs[i + 1] - 20}`} />)}
        <path className={`tc-wire ${running ? "on" : ""}`} d={`M${xs[3] + 20},${cy} H380`} />
      </g>
      <circle cx="6" cy={cy} r="3" className="tc-term" /><text x="6" y={cy - 8} className="tc-io">IN</text>
      <circle cx="380" cy={cy} r="3" className="tc-term" /><text x="380" y={cy - 8} className="tc-io">OUT</text>
      {xs.map((x, i) => {
        const key = TUBE_KEYS[i]; const drive = tubeDrive[key]; const lit = running && drive > 0;
        return (
          <g key={key} className={`tc-tube ${lit ? "lit" : ""}`} style={{ "--drive": drive } as React.CSSProperties}>
            <path className="tc-glass" d={`M${x - 16},${cy + 20} v-24 a16,16 0 0 1 32,0 v24 z`} />
            <ellipse className="tc-glow" cx={x} cy={cy + 2} rx="9" ry="13" />
            <line className="tc-plate" x1={x} y1={cy - 14} x2={x} y2={cy + 12} />
            <path className="tc-filament" d={`M${x - 6},${cy + 10} q6,-14 0,-20 q-6,14 0,20`} />
            <rect x={x - 12} y={cy + 20} width="24" height="5" className="tc-base" />
            <line x1={x - 6} y1={cy + 25} x2={x - 6} y2={cy + 30} className="tc-pin" /><line x1={x + 6} y1={cy + 25} x2={x + 6} y2={cy + 30} className="tc-pin" />
            <text x={x} y={cy + 40} className="tc-name">{key}</text>
          </g>
        );
      })}
    </svg>
  );
}

function flowPath(x1: number, y1: number, x2: number, y2: number) {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

// Add-on — realtime signal-flow map of the whole instrument: generators → buses →
// master → thermionic stages → limiter → earbuds, with on/off, live levels, flow.
function SignalFlow({ running, graph, gammaOn, gammaLevel, rissetOn, missingFund, mode, layers, noiseCount, activeTubes }: { running: boolean; graph: AudioGraph | null; gammaOn: boolean; gammaLevel: number; rissetOn: boolean; missingFund: boolean; mode: BeatMode; layers: LayerState; noiseCount: number; activeTubes: number }) {
  const [lv, setLv] = useState({ beat: 0, veil: 0, pulse: 0, drone: 0, master: 0 });
  useEffect(() => {
    if (!running || !graph) { setLv({ beat: 0, veil: 0, pulse: 0, drone: 0, master: 0 }); return; }
    let frame = 0, last = 0;
    const lb = new Uint8Array(graph.layerAnalysers.beat.fftSize), lv2 = new Uint8Array(graph.layerAnalysers.veil.fftSize), lp = new Uint8Array(graph.layerAnalysers.pulse.fftSize), ld = new Uint8Array(graph.layerAnalysers.drone.fftSize), lm = new Uint8Array(graph.analyser.fftSize);
    const tick = (now: number) => {
      if (now - last > 60) { setLv({ beat: analyserLevel(graph.layerAnalysers.beat, lb), veil: analyserLevel(graph.layerAnalysers.veil, lv2), pulse: analyserLevel(graph.layerAnalysers.pulse, lp), drone: analyserLevel(graph.layerAnalysers.drone, ld), master: analyserLevel(graph.analyser, lm) }); last = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [running, graph]);

  const soloed = Object.values(layers).some((l) => l.solo);
  const audible = (k: LayerKey) => running && !layers[k].muted && (!soloed || layers[k].solo);
  const sources = [
    { key: "beat", name: mode.toUpperCase(), on: audible("beat"), hue: "#e6b45f", lvl: lv.beat, cy: 20 },
    { key: "gamma", name: "GAMMA 40Hz", on: running && gammaOn, hue: "#e6b45f", lvl: gammaOn ? Math.min(1, gammaLevel * 1.7) : 0, cy: 52 },
    { key: "pulse", name: rissetOn ? "PULSE · RISSET" : "SYNC PULSE", on: audible("pulse"), hue: "#e2685c", lvl: lv.pulse, cy: 84 },
    { key: "drone", name: missingFund ? "SUBSTRATE · ƒ₀" : "SUBSTRATE", on: audible("drone"), hue: "#c79bd8", lvl: lv.drone, cy: 116 },
    { key: "veil", name: `NOISE ×${noiseCount}`, on: audible("veil") && noiseCount > 0, hue: "#68d9cf", lvl: lv.veil, cy: 148 },
  ];
  const sw = 116, sh = 24, sx = 8, mx = 250, tubeX = [372, 446, 520, 594], limX = 686, outX = 792, midY = 84;
  const tubeNames = TUBE_KEYS;
  return (
    <svg viewBox="0 0 880 176" className={`signalflow ${running ? "running" : ""}`} preserveAspectRatio="xMidYMid meet" aria-label="Realtime signal-flow diagram">
      {/* wires */}
      <g className="wires">
        {sources.map((s) => <path key={s.key} className={`wire ${s.on ? "on" : ""}`} d={flowPath(sx + sw, s.cy, mx, midY)} style={{ "--hue": s.hue } as React.CSSProperties} />)}
        <path className={`wire ${running ? "on" : ""}`} d={flowPath(mx + 70, midY, tubeX[0], midY)} style={{ "--hue": "#d7a854" } as React.CSSProperties} />
        {tubeX.map((x, i) => i < tubeX.length - 1 && <path key={i} className={`wire ${running ? "on" : ""}`} d={flowPath(x + 16, midY, tubeX[i + 1] - 16, midY)} style={{ "--hue": "#d7a854" } as React.CSSProperties} />)}
        <path className={`wire ${running ? "on" : ""}`} d={flowPath(tubeX[3] + 16, midY, limX, midY)} style={{ "--hue": "#d7a854" } as React.CSSProperties} />
        <path className={`wire ${running ? "on" : ""}`} d={flowPath(limX + 56, midY, outX - 4, midY)} style={{ "--hue": "#68d9cf" } as React.CSSProperties} />
      </g>
      {/* source nodes */}
      {sources.map((s) => (
        <g key={s.key} className={`sf-node ${s.on ? "on" : "off"}`}>
          <rect x={sx} y={s.cy - sh / 2} width={sw} height={sh} rx="3" style={{ "--hue": s.hue } as React.CSSProperties} />
          <circle cx={sx + 9} cy={s.cy} r="3.2" className="sf-lamp" style={{ "--hue": s.hue } as React.CSSProperties} />
          <text x={sx + 18} y={s.cy - 2} className="sf-label">{s.name}</text>
          <rect x={sx + 18} y={s.cy + 3} width={(sw - 26) * s.lvl} height="3" className="sf-level" style={{ "--hue": s.hue } as React.CSSProperties} />
          <rect x={sx + 18} y={s.cy + 3} width={sw - 26} height="3" className="sf-level-bg" />
        </g>
      ))}
      {/* master */}
      <g className={`sf-node master ${running ? "on" : "off"}`}>
        <rect x={mx} y={midY - 22} width="70" height="44" rx="4" style={{ "--hue": "#d7a854" } as React.CSSProperties} />
        <text x={mx + 35} y={midY - 4} className="sf-label mid">MASTER</text>
        <rect x={mx + 10} y={midY + 6} width={50 * lv.master} height="4" className="sf-level" style={{ "--hue": "#e6b45f" } as React.CSSProperties} />
        <rect x={mx + 10} y={midY + 6} width="50" height="4" className="sf-level-bg" />
      </g>
      {/* thermionic stages */}
      {tubeX.map((x, i) => (
        <g key={i} className={`sf-node tube ${running && activeTubes > i ? "on" : "off"}`}>
          <circle cx={x} cy={midY} r="16" style={{ "--hue": "#f0a24a" } as React.CSSProperties} />
          <text x={x} y={midY + 3} className="sf-tube-label">{tubeNames[i]}</text>
        </g>
      ))}
      <text x={(tubeX[0] + tubeX[3]) / 2} y={midY - 26} className="sf-caption">THERMIONIC COLOUR</text>
      {/* limiter */}
      <g className={`sf-node lim ${running ? "on" : "off"}`}>
        <rect x={limX} y={midY - 17} width="56" height="34" rx="4" style={{ "--hue": "#63d8cf" } as React.CSSProperties} />
        <text x={limX + 28} y={midY + 3} className="sf-label mid">LIMIT</text>
      </g>
      {/* output */}
      <g className={`sf-node out ${running ? "on" : "off"}`}>
        <path d={`M${outX + 4},${midY - 6} a10,10 0 0 1 20,0 v10 a4,4 0 0 1 -8,0 v-6 a6,6 0 0 0 -4,-6 a6,6 0 0 0 -4,6 v6 a4,4 0 0 1 -8,0 v-10 z`} className="sf-buds" />
        <text x={outX + 14} y={midY + 26} className="sf-caption">EARBUDS</text>
      </g>
    </svg>
  );
}

// Feature 2 — offline (faster-than-realtime) synthesis of the whole session from a
// settings snapshot + automation tracks. Rebuilds the exact graph in an
// OfflineAudioContext, schedules automation across the timeline, and renders.
async function renderSession(snap: Record<string, any>, duration: number): Promise<AudioBuffer> {
  const sampleRate = 48000;
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);

  const master = ctx.createGain(); master.gain.value = snap.master * 0.58;
  const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 1; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .16;
  const tubes = TUBE_KEYS.map((k) => { const s = ctx.createWaveShaper(); s.curve = makeTubeCurve(k, snap.tubeDrive?.[k] ?? 0); s.oversample = "4x"; return s; });
  master.connect(tubes[0]); tubes[0].connect(tubes[1]); tubes[1].connect(tubes[2]); tubes[2].connect(tubes[3]); tubes[3].connect(limiter).connect(ctx.destination);

  const layerGains = {} as Record<LayerKey, GainNode>; const layerPans = {} as Record<LayerKey, StereoPannerNode>;
  const soloed = Object.values(snap.layers).some((l: any) => l.solo);
  (["beat", "veil", "pulse", "drone"] as LayerKey[]).forEach((key) => {
    layerGains[key] = ctx.createGain(); layerPans[key] = ctx.createStereoPanner();
    const ly = snap.layers[key]; layerGains[key].gain.value = ly.muted || (soloed && !ly.solo) ? 0 : ly.gain; layerPans[key].pan.value = ly.pan;
    layerGains[key].connect(layerPans[key]).connect(master);
  });

  const amHalf = snap.amDepth / 2;
  const beatAM = ctx.createGain(); beatAM.gain.value = 1 - amHalf;
  const beatAMDepth = ctx.createGain(); beatAMDepth.gain.value = snap.nestOn ? amHalf * .5 : amHalf;
  const beatAMLfo = ctx.createOscillator(); beatAMLfo.type = snap.amShape; beatAMLfo.frequency.value = snap.beat;
  const nestLfo = ctx.createOscillator(); nestLfo.type = "sine"; nestLfo.frequency.value = snap.thetaRate;
  const nestDepth = ctx.createGain(); nestDepth.gain.value = snap.nestOn ? amHalf * .5 : 0;
  beatAMLfo.connect(beatAMDepth).connect(beatAM.gain); nestLfo.connect(nestDepth).connect(beatAMDepth.gain);
  beatAM.connect(layerGains.beat); beatAMLfo.start(); nestLfo.start();
  const beatLayer = buildBeatLayer(ctx, beatAM, snap.mode, snap.waveform, snap.carrier, snap.beat); beatLayer.oscillators.forEach((o) => o.start());

  const pulse = buildPulse(ctx, layerGains.pulse, snap.pulseToneHz, snap.pulseWave, snap.bpm, snap.pulseDepth, snap.pulseDuty, snap.pulseSmooth);
  pulse.tone.start(); pulse.gates.forEach((g) => g.start());
  const drone = buildDrone(ctx, layerGains.drone, snap.carrier, snap.missingFund, snap.mfPartials, snap.mfBrightness); drone.oscillators.forEach((o) => o.start());

  const veilTiltLow = ctx.createBiquadFilter(); veilTiltLow.type = "lowshelf"; veilTiltLow.frequency.value = 250; veilTiltLow.gain.value = -snap.veilTilt * 8;
  const veilTiltHigh = ctx.createBiquadFilter(); veilTiltHigh.type = "highshelf"; veilTiltHigh.frequency.value = 4000; veilTiltHigh.gain.value = snap.veilTilt * 8;
  const veilShape = ctx.createBiquadFilter(); veilShape.type = snap.veilType === "off" ? "allpass" : snap.veilType; veilShape.frequency.value = snap.veilCenter; veilShape.Q.value = snap.veilQ; veilShape.gain.value = snap.veilGainDb;
  const veilSweepLfo = ctx.createOscillator(); veilSweepLfo.type = "sine"; veilSweepLfo.frequency.value = Math.max(.01, snap.veilSweepRate); const veilSweepDepth = ctx.createGain(); veilSweepDepth.gain.value = snap.veilSweepRate > 0 ? snap.veilSweepDepth * 2000 : 0; veilSweepLfo.connect(veilSweepDepth).connect(veilShape.frequency); veilSweepLfo.start();
  const veilComod = ctx.createGain(); veilComod.gain.value = snap.comodOn ? 1 - snap.comodDepth * .5 : 1;
  const comodLfo = ctx.createOscillator(); comodLfo.type = snap.comodShape; comodLfo.frequency.value = snap.comodRate; const comodDepth = ctx.createGain(); comodDepth.gain.value = snap.comodOn ? snap.comodDepth * .5 : 0; comodLfo.connect(comodDepth).connect(veilComod.gain); comodLfo.start();
  veilTiltLow.connect(veilTiltHigh).connect(veilShape).connect(veilComod).connect(layerGains.veil);
  NOISE_COLORS.forEach((color) => { if (!snap.noiseActive?.[color]) return; const src = ctx.createBufferSource(); src.buffer = makeNoiseBuffer(ctx, color); src.loop = true; const g = ctx.createGain(); g.gain.value = snap.noiseLevels?.[color] ?? 0.7; src.connect(g).connect(veilTiltLow); src.start(); });

  const gammaBus = ctx.createGain(); gammaBus.gain.value = snap.gammaOn ? snap.gammaLevel : 0; gammaBus.connect(master);
  const gammaCarrier = ctx.createOscillator(); gammaCarrier.type = snap.gammaWave; gammaCarrier.frequency.value = snap.gammaCarrierHz;
  const gammaAM = ctx.createGain(); gammaAM.gain.value = 1 - snap.gammaDepth / 2; const gammaAMDepth = ctx.createGain(); gammaAMDepth.gain.value = snap.gammaDepth / 2;
  const gammaLfo = ctx.createOscillator(); gammaLfo.setPeriodicWave(makeGammaWave(ctx, snap.gammaDuty, snap.gammaEdge)); gammaLfo.frequency.value = snap.gammaRate;
  gammaLfo.connect(gammaAMDepth).connect(gammaAM.gain); gammaCarrier.connect(gammaAM).connect(gammaBus); gammaCarrier.start(); gammaLfo.start();

  // -------- automation scheduling over the timeline --------
  const tracks = (snap.automation && Array.isArray(snap.automationTracks)) ? snap.automationTracks : [];
  const autoKeys = new Set<string>(tracks.map((t: any) => t.parameter));
  const beatDriven = autoKeys.has("carrier") || autoKeys.has("beat") || autoKeys.has("drift") || snap.drift > 0;
  const rissetLive = autoKeys.has("rissetOn") || snap.rissetOn;
  if (autoKeys.size || beatDriven || snap.rissetOn) {
    const dt = 1 / 20;
    let rissetPhase = 0;
    for (let t = 0; t <= duration + 1e-6; t += dt) {
      const prog = duration > 0 ? clamp(t / duration, 0, 1) : 0;
      const gv = (key: string, base: number) => { if (!autoKeys.has(key)) return base; const spec = PARAM_MAP[key]; const trk = tracks.find((x: any) => x.parameter === key); const n = sampleAutomation(trk.points, prog); return Math.round((spec.min + n * (spec.max - spec.min)) / spec.step) * spec.step; };
      if (beatDriven) {
        const cr = gv("carrier", snap.carrier), bt = gv("beat", snap.beat), dr = gv("drift", snap.drift);
        const c = cr + Math.sin(t * .021) * dr * 8;
        if (snap.mode === "isochronic") beatLayer.carriers.left?.frequency.setValueAtTime(c, t);
        else { beatLayer.carriers.left?.frequency.setValueAtTime(c - bt / 2, t); beatLayer.carriers.right?.frequency.setValueAtTime(c + bt / 2, t); }
        beatAMLfo.frequency.setValueAtTime(bt, t);
        drone.parts.forEach((pt) => pt.osc.frequency.setValueAtTime(pt.mult * cr / 4, t));
      }
      if (autoKeys.has("master")) master.gain.setValueAtTime(gv("master", snap.master) * 0.58, t);
      if (autoKeys.has("amDepth") || autoKeys.has("nestOn") || autoKeys.has("thetaRate")) { const ad = gv("amDepth", snap.amDepth); const nOn = autoKeys.has("nestOn") ? gv("nestOn", snap.nestOn ? 1 : 0) >= .5 : snap.nestOn; const h = ad / 2; beatAM.gain.setValueAtTime(1 - h, t); beatAMDepth.gain.setValueAtTime(nOn ? h * .5 : h, t); nestDepth.gain.setValueAtTime(nOn ? h * .5 : 0, t); nestLfo.frequency.setValueAtTime(gv("thetaRate", snap.thetaRate), t); }
      if (autoKeys.has("pulseToneHz")) pulse.tone.frequency.setValueAtTime(gv("pulseToneHz", snap.pulseToneHz), t);
      const rOn = autoKeys.has("rissetOn") ? gv("rissetOn", snap.rissetOn ? 1 : 0) >= .5 : snap.rissetOn;
      if (rOn) {
        const layersN = gv("rissetLayers", snap.rissetLayers), ratio = gv("rissetRatio", snap.rissetRatio), focus = gv("rissetFocus", snap.rissetFocus), rate = gv("rissetRate", snap.rissetRate), base = (gv("bpm", snap.bpm) / 60) * 2, pd = gv("pulseDepth", snap.pulseDepth), center = (layersN - 1) / 2;
        rissetPhase = (rissetPhase + dt * rate * snap.rissetDir * layersN + layersN * 100) % layersN;
        for (let j = 0; j < MAX_PULSE_LAYERS; j++) { if (j >= layersN) { pulse.amps[j].gain.setValueAtTime(0, t); pulse.depths[j].gain.setValueAtTime(0, t); continue; } const e = (j + rissetPhase) % layersN; pulse.gates[j].frequency.setValueAtTime(clamp(base * Math.pow(ratio, e - center), .05, 40), t); const w = gaussian(e, center, focus) * pd * 0.6; pulse.amps[j].gain.setValueAtTime(w, t); pulse.depths[j].gain.setValueAtTime(w, t); }
      } else if (autoKeys.has("bpm") || autoKeys.has("pulseDepth")) { const base = (gv("bpm", snap.bpm) / 60) * 2, d = gv("pulseDepth", snap.pulseDepth) * 0.5; pulse.gates[0].frequency.setValueAtTime(base, t); pulse.amps[0].gain.setValueAtTime(d, t); pulse.depths[0].gain.setValueAtTime(d, t); }
      if (autoKeys.has("gammaOn") || autoKeys.has("gammaLevel")) { const on = autoKeys.has("gammaOn") ? gv("gammaOn", snap.gammaOn ? 1 : 0) >= .5 : snap.gammaOn; gammaBus.gain.setValueAtTime(on ? gv("gammaLevel", snap.gammaLevel) : 0, t); }
      if (autoKeys.has("gammaRate")) gammaLfo.frequency.setValueAtTime(gv("gammaRate", snap.gammaRate), t);
      if (autoKeys.has("gammaCarrierHz")) gammaCarrier.frequency.setValueAtTime(gv("gammaCarrierHz", snap.gammaCarrierHz), t);
      if (autoKeys.has("gammaDepth")) { const gd = gv("gammaDepth", snap.gammaDepth); gammaAM.gain.setValueAtTime(1 - gd / 2, t); gammaAMDepth.gain.setValueAtTime(gd / 2, t); }
      if (autoKeys.has("veilCenter")) veilShape.frequency.setValueAtTime(gv("veilCenter", snap.veilCenter), t);
      if (autoKeys.has("veilQ")) veilShape.Q.setValueAtTime(gv("veilQ", snap.veilQ), t);
      if (autoKeys.has("veilGainDb")) veilShape.gain.setValueAtTime(gv("veilGainDb", snap.veilGainDb), t);
      if (autoKeys.has("veilTilt")) { const tl = gv("veilTilt", snap.veilTilt); veilTiltLow.gain.setValueAtTime(-tl * 8, t); veilTiltHigh.gain.setValueAtTime(tl * 8, t); }
      if (autoKeys.has("veilSweepRate")) veilSweepLfo.frequency.setValueAtTime(Math.max(.01, gv("veilSweepRate", snap.veilSweepRate)), t);
      if (autoKeys.has("veilSweepDepth") || autoKeys.has("veilSweepRate")) veilSweepDepth.gain.setValueAtTime(gv("veilSweepRate", snap.veilSweepRate) > 0 ? gv("veilSweepDepth", snap.veilSweepDepth) * 2000 : 0, t);
      if (autoKeys.has("comodRate")) comodLfo.frequency.setValueAtTime(gv("comodRate", snap.comodRate), t);
      if (autoKeys.has("comodDepth") || autoKeys.has("comodOn")) { const on = autoKeys.has("comodOn") ? gv("comodOn", snap.comodOn ? 1 : 0) >= .5 : snap.comodOn; const cd = gv("comodDepth", snap.comodDepth); veilComod.gain.setValueAtTime(on ? 1 - cd * .5 : 1, t); comodDepth.gain.setValueAtTime(on ? cd * .5 : 0, t); }
      (["beat", "veil", "pulse", "drone"] as LayerKey[]).forEach((k) => {
        if (autoKeys.has(`${k}Gain`)) { const ly = snap.layers[k]; const target = ly.muted || (soloed && !ly.solo) ? 0 : gv(`${k}Gain`, ly.gain); layerGains[k].gain.setValueAtTime(target, t); }
        if (autoKeys.has(`${k}Pan`)) layerPans[k].pan.setValueAtTime(gv(`${k}Pan`, snap.layers[k].pan), t);
      });
    }
  }

  return ctx.startRendering();
}

export default function Home() {
  const graphRef = useRef<AudioGraph | null>(null);
  const sessionOriginRef = useRef(0);
  const [running, setRunning] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  const [carrier, setCarrier] = useState(400);
  const [beat, setBeat] = useState(10);
  const [master, setMaster] = useState(0.52);
  const [bpm, setBpm] = useState(60);
  const [pulseDepth, setPulseDepth] = useState(0.42);
  // sync-pulse shaping — click-free isochronic gate
  const [pulseToneHz, setPulseToneHz] = useState(200);
  const [pulseWave, setPulseWave] = useState<Waveform>("sine");
  const [pulseDuty, setPulseDuty] = useState(0.5);
  const [pulseSmooth, setPulseSmooth] = useState(0.5);
  const [mode, setMode] = useState<BeatMode>("binaural");
  const [waveform, setWaveform] = useState<Waveform>("sine");
  // #2 amplitude-modulation lab
  const [amDepth, setAmDepth] = useState(0);
  const [amShape, setAmShape] = useState<AmShape>("sine");
  // #5 theta–gamma nesting
  const [nestOn, setNestOn] = useState(false);
  const [thetaRate, setThetaRate] = useState(5);
  // #3 Risset rhythm (sync pulse III) — expanded controls
  const [rissetOn, setRissetOn] = useState(false);
  const [rissetDir, setRissetDir] = useState(1);
  const [rissetRate, setRissetRate] = useState(0.04);
  const [rissetLayers, setRissetLayers] = useState(3);
  const [rissetRatio, setRissetRatio] = useState(2);
  const [rissetFocus, setRissetFocus] = useState(0.8);
  // #3 missing fundamental (substrate IV)
  const [missingFund, setMissingFund] = useState(false);
  const [mfPartials, setMfPartials] = useState(5);
  const [mfBrightness, setMfBrightness] = useState(0.4);
  // #1 audible gamma engine
  const [gammaOn, setGammaOn] = useState(false);
  const [gammaRate, setGammaRate] = useState(40);
  const [gammaCarrierHz, setGammaCarrierHz] = useState(220);
  const [gammaDepth, setGammaDepth] = useState(0.9);
  const [gammaDuty, setGammaDuty] = useState(0.5);
  const [gammaEdge, setGammaEdge] = useState(0.3);
  const [gammaLevel, setGammaLevel] = useState(0.3);
  const [gammaWave, setGammaWave] = useState<Waveform>("sine");
  // #7 noise laboratory — multi-colour source bank
  const [noiseActive, setNoiseActive] = useState<Record<NoiseColor, boolean>>({ WHITE: false, PINK: true, BROWN: false, BLUE: false, VIOLET: false, GREY: false });
  const [noiseLevels, setNoiseLevels] = useState<Record<NoiseColor, number>>({ WHITE: 0.7, PINK: 0.8, BROWN: 0.7, BLUE: 0.6, VIOLET: 0.6, GREY: 0.7 });
  // #7 veil filter — expanded
  const [veilType, setVeilType] = useState<VeilType>("off");
  const [veilCenter, setVeilCenter] = useState(1000);
  const [veilQ, setVeilQ] = useState(6);
  const [veilGainDb, setVeilGainDb] = useState(0);
  const [veilSweepRate, setVeilSweepRate] = useState(0);
  const [veilSweepDepth, setVeilSweepDepth] = useState(0);
  const [veilTilt, setVeilTilt] = useState(0);
  // #7 comodulation — expanded
  const [comodOn, setComodOn] = useState(false);
  const [comodRate, setComodRate] = useState(9);
  const [comodDepth, setComodDepth] = useState(0.4);
  const [comodShape, setComodShape] = useState<AmShape>("sine");
  const [layers, setLayers] = useState<LayerState>(initialLayers);
  const [elapsed, setElapsed] = useState(0);
  const [sessionLength, setSessionLength] = useState(30);
  const [automation, setAutomation] = useState(true);
  const [drift, setDrift] = useState(0.18);
  const [preset, setPreset] = useState<keyof typeof presets>("Focus");
  const [hintDismissed, setHintDismissed] = useState(false);
  const safeMode = true;
  const [tubeDrive, setTubeDrive] = useState<Record<TubeKey, number>>({ ECC83: .18, "12AU7": 0, "6V6": 0, EL34: 0 });
  const [automationTracks, setAutomationTracks] = useState<AutomationTrack[]>([
    { id: "track-carrier", parameter: "carrier", points: flatPoints((400 - 80) / (1000 - 80)) },
  ]);
  // Feature 1 — user-saved settings (localStorage)
  const [userPresets, setUserPresets] = useState<{ name: string; data: Record<string, unknown> }[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  // Feature 2 — offline render/export status
  const [exportStatus, setExportStatus] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: "" });
  const progress = clamp(elapsed / (sessionLength * 60), 0, 1);

  // Latest-value refs so the Shepard/Risset animation loop and live rebuilds read
  // current params without re-subscribing every frame.
  const carrierRef = useRef(carrier); carrierRef.current = carrier;
  const bpmRef = useRef(bpm); bpmRef.current = bpm;
  const pulseDepthRef = useRef(pulseDepth); pulseDepthRef.current = pulseDepth;
  const rissetRateRef = useRef(rissetRate); rissetRateRef.current = rissetRate;
  const rissetDirRef = useRef(rissetDir); rissetDirRef.current = rissetDir;
  const rissetLayersRef = useRef(rissetLayers); rissetLayersRef.current = rissetLayers;
  const rissetRatioRef = useRef(rissetRatio); rissetRatioRef.current = rissetRatio;
  const rissetFocusRef = useRef(rissetFocus); rissetFocusRef.current = rissetFocus;
  const rissetPhaseRef = useRef(0);

  const updateLayer = (key: LayerKey, patch: Partial<LayerState[LayerKey]>) => setLayers((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  // Read any registered parameter's current value (fresh each render).
  const readParam = (key: string): number => {
    switch (key) {
      case "carrier": return carrier; case "beat": return beat; case "master": return master; case "bpm": return bpm;
      case "pulseDepth": return pulseDepth; case "pulseToneHz": return pulseToneHz; case "pulseDuty": return pulseDuty; case "pulseSmooth": return pulseSmooth;
      case "drift": return drift; case "amDepth": return amDepth; case "thetaRate": return thetaRate;
      case "nestOn": return nestOn ? 1 : 0;
      case "gammaRate": return gammaRate; case "gammaCarrierHz": return gammaCarrierHz; case "gammaDepth": return gammaDepth;
      case "gammaDuty": return gammaDuty; case "gammaEdge": return gammaEdge; case "gammaLevel": return gammaLevel; case "gammaOn": return gammaOn ? 1 : 0;
      case "rissetRate": return rissetRate; case "rissetRatio": return rissetRatio; case "rissetFocus": return rissetFocus; case "rissetLayers": return rissetLayers; case "rissetOn": return rissetOn ? 1 : 0;
      case "mfPartials": return mfPartials; case "mfBrightness": return mfBrightness; case "missingFund": return missingFund ? 1 : 0;
      case "veilCenter": return veilCenter; case "veilQ": return veilQ; case "veilGainDb": return veilGainDb;
      case "veilSweepRate": return veilSweepRate; case "veilSweepDepth": return veilSweepDepth; case "veilTilt": return veilTilt;
      case "comodRate": return comodRate; case "comodDepth": return comodDepth; case "comodOn": return comodOn ? 1 : 0;
      case "beatGain": return layers.beat.gain; case "veilGain": return layers.veil.gain; case "pulseGain": return layers.pulse.gain; case "droneGain": return layers.drone.gain;
      case "beatPan": return layers.beat.pan; case "veilPan": return layers.veil.pan; case "pulsePan": return layers.pulse.pan; case "dronePan": return layers.drone.pan;
      default: return 0;
    }
  };

  // Write any registered parameter (stable — uses only setters).
  const writeParam = useCallback((key: string, v: number) => {
    const b = v >= 0.5;
    switch (key) {
      case "carrier": setCarrier(v); break; case "beat": setBeat(v); break; case "master": setMaster(v); break; case "bpm": setBpm(v); break;
      case "pulseDepth": setPulseDepth(v); break; case "pulseToneHz": setPulseToneHz(v); break; case "pulseDuty": setPulseDuty(v); break; case "pulseSmooth": setPulseSmooth(v); break;
      case "drift": setDrift(v); break; case "amDepth": setAmDepth(v); break; case "thetaRate": setThetaRate(v); break;
      case "nestOn": setNestOn(b); break;
      case "gammaRate": setGammaRate(v); break; case "gammaCarrierHz": setGammaCarrierHz(v); break; case "gammaDepth": setGammaDepth(v); break;
      case "gammaDuty": setGammaDuty(v); break; case "gammaEdge": setGammaEdge(v); break; case "gammaLevel": setGammaLevel(v); break; case "gammaOn": setGammaOn(b); break;
      case "rissetRate": setRissetRate(v); break; case "rissetRatio": setRissetRatio(v); break; case "rissetFocus": setRissetFocus(v); break; case "rissetLayers": setRissetLayers(v); break; case "rissetOn": setRissetOn(b); break;
      case "mfPartials": setMfPartials(v); break; case "mfBrightness": setMfBrightness(v); break; case "missingFund": setMissingFund(b); break;
      case "veilCenter": setVeilCenter(v); break; case "veilQ": setVeilQ(v); break; case "veilGainDb": setVeilGainDb(v); break;
      case "veilSweepRate": setVeilSweepRate(v); break; case "veilSweepDepth": setVeilSweepDepth(v); break; case "veilTilt": setVeilTilt(v); break;
      case "comodRate": setComodRate(v); break; case "comodDepth": setComodDepth(v); break; case "comodOn": setComodOn(b); break;
      case "beatGain": setLayers((c) => ({ ...c, beat: { ...c.beat, gain: v } })); break; case "veilGain": setLayers((c) => ({ ...c, veil: { ...c.veil, gain: v } })); break;
      case "pulseGain": setLayers((c) => ({ ...c, pulse: { ...c.pulse, gain: v } })); break; case "droneGain": setLayers((c) => ({ ...c, drone: { ...c.drone, gain: v } })); break;
      case "beatPan": setLayers((c) => ({ ...c, beat: { ...c.beat, pan: v } })); break; case "veilPan": setLayers((c) => ({ ...c, veil: { ...c.veil, pan: v } })); break;
      case "pulsePan": setLayers((c) => ({ ...c, pulse: { ...c.pulse, pan: v } })); break; case "dronePan": setLayers((c) => ({ ...c, drone: { ...c.drone, pan: v } })); break;
    }
  }, []);

  const currentControlValue = readParam;

  const applyAutomatedValue = useCallback((parameter: AutomationParam, normalized: number) => {
    const spec = PARAM_MAP[parameter]; if (!spec) return;
    writeParam(parameter, Math.round((spec.min + normalized * (spec.max - spec.min)) / spec.step) * spec.step);
  }, [writeParam]);

  const resetParam = useCallback((key: string, fallback?: number) => {
    const def = PARAM_MAP[key]?.def; writeParam(key, def !== undefined ? def : (fallback ?? 0));
  }, [writeParam]);

  const stopAudio = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const now = graph.ctx.currentTime;
    graph.master.gain.cancelScheduledValues(now);
    graph.master.gain.setValueAtTime(graph.master.gain.value, now);
    graph.master.gain.linearRampToValueAtTime(0, now + .12);
    window.setTimeout(() => graph.ctx.close(), 150);
    graphRef.current = null; sessionOriginRef.current = 0; setRunning(false); setElapsed(0); setGraphVersion((v) => v + 1);
  }, []);

  const startAudio = useCallback(async () => {
    if (graphRef.current) { stopAudio(); return; }
    setHintDismissed(true);
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    await ctx.resume();
    const masterNode = ctx.createGain(); masterNode.gain.value = 0;
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 1; limiter.ratio.value = 20; limiter.attack.value = .003; limiter.release.value = .16;
    const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = .82;
    const splitter = ctx.createChannelSplitter(2); const analyserL = ctx.createAnalyser(); const analyserR = ctx.createAnalyser(); analyserL.fftSize = analyserR.fftSize = 2048;
    const tubeStages = TUBE_KEYS.map((key) => { const stage = ctx.createWaveShaper(); stage.curve = makeTubeCurve(key, tubeDrive[key]); stage.oversample = "4x"; return stage; });
    masterNode.connect(tubeStages[0]); tubeStages[0].connect(tubeStages[1]); tubeStages[1].connect(tubeStages[2]); tubeStages[2].connect(tubeStages[3]); tubeStages[3].connect(limiter).connect(analyser).connect(ctx.destination); analyser.connect(splitter); splitter.connect(analyserL, 0); splitter.connect(analyserR, 1);
    const layerGains = {} as Record<LayerKey, GainNode>; const layerPans = {} as Record<LayerKey, StereoPannerNode>; const layerAnalysers = {} as Record<LayerKey, AnalyserNode>;
    (["beat", "veil", "pulse", "drone"] as LayerKey[]).forEach((key) => {
      layerGains[key] = ctx.createGain(); layerPans[key] = ctx.createStereoPanner();
      const la = ctx.createAnalyser(); la.fftSize = 1024; la.smoothingTimeConstant = .6; layerAnalysers[key] = la;
      layerGains[key].connect(layerPans[key]); layerPans[key].connect(masterNode); layerPans[key].connect(la);
    });
    const oscillators: OscillatorNode[] = []; const sources: AudioBufferSourceNode[] = [];
    const carriers: AudioGraph["carriers"] = {};

    // #2 shared amplitude-modulation stage on the beat layer (isochronic gate,
    // optional tremolo for binaural/monaural), with #5 theta-nested depth.
    const amHalf = amDepth / 2;
    const beatAM = ctx.createGain(); beatAM.gain.value = 1 - amHalf;
    const beatAMDepth = ctx.createGain(); beatAMDepth.gain.value = nestOn ? amHalf * 0.5 : amHalf;
    const beatAMLfo = ctx.createOscillator(); beatAMLfo.type = amShape; beatAMLfo.frequency.value = beat;
    const nestLfo = ctx.createOscillator(); nestLfo.type = "sine"; nestLfo.frequency.value = thetaRate;
    const nestDepth = ctx.createGain(); nestDepth.gain.value = nestOn ? amHalf * 0.5 : 0;
    beatAMLfo.connect(beatAMDepth).connect(beatAM.gain); nestLfo.connect(nestDepth).connect(beatAMDepth.gain);
    beatAM.connect(layerGains.beat); beatAMLfo.start(); nestLfo.start(); oscillators.push(beatAMLfo, nestLfo);

    const beatLayer = buildBeatLayer(ctx, beatAM, mode, waveform, carrier, beat);
    beatLayer.oscillators.forEach((o) => o.start());
    oscillators.push(...beatLayer.oscillators); Object.assign(carriers, beatLayer.carriers);
    const beatOscillators = [...beatLayer.oscillators];

    // #3 sync pulse (Risset-capable five-layer gate, edge-softened)
    const pulseEngine = buildPulse(ctx, layerGains.pulse, pulseToneHz, pulseWave, bpm, pulseDepth, pulseDuty, pulseSmooth);
    pulseEngine.tone.start(); pulseEngine.gates.forEach((g) => g.start());
    oscillators.push(pulseEngine.tone, ...pulseEngine.gates); carriers.pulse = pulseEngine.tone;

    // #3 substrate (missing-fundamental capable)
    const droneBuilt = buildDrone(ctx, layerGains.drone, carrier, missingFund, mfPartials, mfBrightness);
    droneBuilt.oscillators.forEach((o) => o.start()); oscillators.push(...droneBuilt.oscillators); carriers.drone = droneBuilt.parts[0].osc;

    // #7 noise veil: multi-colour source bank → tilt shelves → filter (swept) → comod → bus
    const veilTiltLow = ctx.createBiquadFilter(); veilTiltLow.type = "lowshelf"; veilTiltLow.frequency.value = 250; veilTiltLow.gain.value = -veilTilt * 8;
    const veilTiltHigh = ctx.createBiquadFilter(); veilTiltHigh.type = "highshelf"; veilTiltHigh.frequency.value = 4000; veilTiltHigh.gain.value = veilTilt * 8;
    const veilShape = ctx.createBiquadFilter(); veilShape.type = veilType === "off" ? "allpass" : veilType; veilShape.frequency.value = veilCenter; veilShape.Q.value = veilQ; veilShape.gain.value = veilGainDb;
    const veilSweepLfo = ctx.createOscillator(); veilSweepLfo.type = "sine"; veilSweepLfo.frequency.value = Math.max(0.01, veilSweepRate); const veilSweepDepthNode = ctx.createGain(); veilSweepDepthNode.gain.value = veilSweepDepth * 2000; veilSweepLfo.connect(veilSweepDepthNode).connect(veilShape.frequency); veilSweepLfo.start(); oscillators.push(veilSweepLfo);
    const veilComod = ctx.createGain(); veilComod.gain.value = comodOn ? 1 - comodDepth * 0.5 : 1;
    const comodLfo = ctx.createOscillator(); comodLfo.type = comodShape; comodLfo.frequency.value = comodRate; const comodDepthNode = ctx.createGain(); comodDepthNode.gain.value = comodOn ? comodDepth * 0.5 : 0; comodLfo.connect(comodDepthNode).connect(veilComod.gain); comodLfo.start(); oscillators.push(comodLfo);
    veilTiltLow.connect(veilTiltHigh).connect(veilShape).connect(veilComod).connect(layerGains.veil);
    const noiseSources = {} as Record<NoiseColor, NoiseSource>;
    NOISE_COLORS.forEach((color) => {
      const source = ctx.createBufferSource(); source.buffer = makeNoiseBuffer(ctx, color); source.loop = true;
      const gain = ctx.createGain(); gain.gain.value = noiseActive[color] ? noiseLevels[color] : 0;
      source.connect(gain).connect(veilTiltLow); source.start(); sources.push(source);
      noiseSources[color] = { source, gain };
    });

    // #1 audible gamma engine (carrier tone amplitude-modulated at ~40 Hz), own bus
    const gammaBus = ctx.createGain(); gammaBus.gain.value = gammaOn ? gammaLevel : 0; gammaBus.connect(masterNode);
    const gammaCarrier = ctx.createOscillator(); gammaCarrier.type = gammaWave; gammaCarrier.frequency.value = gammaCarrierHz;
    const gammaAM = ctx.createGain(); gammaAM.gain.value = 1 - gammaDepth / 2;
    const gammaAMDepth = ctx.createGain(); gammaAMDepth.gain.value = gammaDepth / 2;
    const gammaLfo = ctx.createOscillator(); gammaLfo.setPeriodicWave(makeGammaWave(ctx, gammaDuty, gammaEdge)); gammaLfo.frequency.value = gammaRate;
    gammaLfo.connect(gammaAMDepth).connect(gammaAM.gain); gammaCarrier.connect(gammaAM).connect(gammaBus);
    gammaCarrier.start(); gammaLfo.start(); oscillators.push(gammaCarrier, gammaLfo);

    const graph: AudioGraph = { ctx, master: masterNode, limiter, analyser, analyserL, analyserR, oscillators, beatOscillators, sources, layerGains, layerPans, layerAnalysers, carriers, beatAM, beatAMLfo, beatAMDepth, nestLfo, nestDepth, veilTiltLow, veilTiltHigh, veilShape, veilComod, comodLfo, comodDepth: comodDepthNode, veilSweepLfo, veilSweepDepth: veilSweepDepthNode, noiseSources, droneParts: droneBuilt.parts, pulse: pulseEngine, gammaCarrier, gammaAM, gammaAMDepth, gammaLfo, gammaBus, tubeStages, beatMode: mode };
    graphRef.current = graph; sessionOriginRef.current = performance.now() - elapsed * 1000; setRunning(true); setGraphVersion((v) => v + 1);
    const now = ctx.currentTime; masterNode.gain.setValueAtTime(0, now); masterNode.gain.linearRampToValueAtTime(master * .58, now + .8);
  }, [amDepth, amShape, beat, bpm, carrier, comodDepth, comodOn, comodRate, comodShape, elapsed, gammaCarrierHz, gammaDepth, gammaDuty, gammaEdge, gammaLevel, gammaOn, gammaRate, gammaWave, master, mfBrightness, mfPartials, missingFund, mode, nestOn, noiseActive, noiseLevels, pulseDepth, pulseDuty, pulseSmooth, pulseToneHz, pulseWave, stopAudio, thetaRate, tubeDrive, veilCenter, veilGainDb, veilQ, veilSweepDepth, veilSweepRate, veilTilt, veilType, waveform]);

  // Beat-mode requests are handled by the effect below. Keeping this callback
  // state-only also lets snapshots use the exact same live update path.
  const changeMode = useCallback((next: BeatMode) => {
    setMode(next);
    if (next === "isochronic" && amDepth < 0.2) setAmDepth(0.85);
  }, [amDepth]);

  // Live-safe beat topology change: equal-power crossfade whenever mode changes,
  // including changes applied by a saved snapshot.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graph.beatMode === mode) return;
    const now = graph.ctx.currentTime;
    graph.layerGains.beat.gain.cancelScheduledValues(now);
    graph.layerGains.beat.gain.setTargetAtTime(0, now, .045);
    window.setTimeout(() => {
      const g = graphRef.current;
      if (!g) return;
      g.beatOscillators.forEach((osc) => { try { osc.stop(); } catch { /* already stopped */ } });
      const rebuilt = buildBeatLayer(g.ctx, g.beatAM, mode, waveform, carrier, beat);
      rebuilt.oscillators.forEach((osc) => osc.start());
      g.beatOscillators = rebuilt.oscillators;
      g.carriers.left = rebuilt.carriers.left; g.carriers.right = rebuilt.carriers.right;
      g.beatMode = mode;
      const soloed = Object.values(layers).some((l) => l.solo);
      const target = layers.beat.muted || (soloed && !layers.beat.solo) ? 0 : layers.beat.gain;
      g.layerGains.beat.gain.setTargetAtTime(target, g.ctx.currentTime, .06);
    }, 180);
  }, [beat, carrier, layers, mode, waveform]);

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
    graph.beatAMLfo.frequency.setTargetAtTime(beat, now, .035);
    graph.droneParts.forEach((part) => part.osc.frequency.setTargetAtTime(part.mult * (carrier / 4), now, .08));
  }, [automation, beat, carrier, drift, elapsed]);

  // sync-pulse tone pitch/wave + click-free gate shape (duty + smoothing)
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    graph.pulse.tone.type = pulseWave;
    graph.pulse.tone.frequency.setTargetAtTime(pulseToneHz, t, .04);
    const wave = makeGammaWave(graph.ctx, pulseDuty, pulseSmooth);
    graph.pulse.gates.forEach((gate) => gate.setPeriodicWave(wave));
  }, [pulseToneHz, pulseWave, pulseDuty, pulseSmooth, graphVersion]);

  // #2/#5 — amplitude-modulation depth, envelope shape, and theta-nesting
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    graph.beatAMLfo.type = amShape;
    graph.nestLfo.frequency.setTargetAtTime(thetaRate, t, .05);
    const half = amDepth / 2;
    graph.beatAM.gain.setTargetAtTime(1 - half, t, .05);
    graph.beatAMDepth.gain.setTargetAtTime(nestOn ? half * 0.5 : half, t, .05);
    graph.nestDepth.gain.setTargetAtTime(nestOn ? half * 0.5 : 0, t, .05);
  }, [amDepth, amShape, nestOn, thetaRate, graphVersion]);

  // #3 — sync pulse when Risset is OFF (single-layer isochronic gate)
  useEffect(() => {
    const graph = graphRef.current; if (!graph || rissetOn) return; const t = graph.ctx.currentTime;
    const base = (bpm / 60) * 2, d = pulseDepth * 0.5;
    graph.pulse.gates[0].frequency.setTargetAtTime(base, t, .05);
    graph.pulse.amps[0].gain.setTargetAtTime(d, t, .05); graph.pulse.depths[0].gain.setTargetAtTime(d, t, .05);
    [1, 2].forEach((i) => { graph.pulse.amps[i].gain.setTargetAtTime(0, t, .05); graph.pulse.depths[i].gain.setTargetAtTime(0, t, .05); });
  }, [bpm, pulseDepth, rissetOn, graphVersion]);

  // #7 — veil filter (type/centre/Q/gain/sweep) and spectral tilt
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    graph.veilShape.type = veilType === "off" ? "allpass" : veilType;
    graph.veilShape.frequency.setTargetAtTime(veilCenter, t, .05); graph.veilShape.Q.setTargetAtTime(veilQ, t, .05); graph.veilShape.gain.setTargetAtTime(veilGainDb, t, .05);
    graph.veilSweepLfo.frequency.setTargetAtTime(Math.max(0.01, veilSweepRate), t, .05);
    graph.veilSweepDepth.gain.setTargetAtTime(veilSweepRate > 0 ? veilSweepDepth * 2000 : 0, t, .05);
    graph.veilTiltLow.gain.setTargetAtTime(-veilTilt * 8, t, .05); graph.veilTiltHigh.gain.setTargetAtTime(veilTilt * 8, t, .05);
  }, [veilType, veilCenter, veilQ, veilGainDb, veilSweepRate, veilSweepDepth, veilTilt, graphVersion]);

  // #7 — comodulation (coherent cross-band amplitude modulation of the veil)
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    graph.comodLfo.type = comodShape; graph.comodLfo.frequency.setTargetAtTime(comodRate, t, .05);
    graph.veilComod.gain.setTargetAtTime(comodOn ? 1 - comodDepth * 0.5 : 1, t, .05);
    graph.comodDepth.gain.setTargetAtTime(comodOn ? comodDepth * 0.5 : 0, t, .05);
  }, [comodOn, comodRate, comodDepth, comodShape, graphVersion]);

  // #7 — multi-colour noise bank: fade each source in/out in realtime
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    NOISE_COLORS.forEach((color) => graph.noiseSources[color].gain.gain.setTargetAtTime(noiseActive[color] ? noiseLevels[color] : 0, t, .06));
  }, [noiseActive, noiseLevels, graphVersion]);

  // #3 — rebuild substrate on missing-fundamental / partials / brightness change
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return;
    graph.droneParts.forEach((p) => { try { p.osc.stop(); } catch { /* already stopped */ } });
    const built = buildDrone(graph.ctx, graph.layerGains.drone, carrierRef.current, missingFund, mfPartials, mfBrightness);
    built.oscillators.forEach((o) => o.start()); graph.droneParts = built.parts; graph.carriers.drone = built.parts[0].osc;
  }, [missingFund, mfPartials, mfBrightness]);

  // #1 — audible gamma engine parameters
  useEffect(() => {
    const graph = graphRef.current; if (!graph) return; const t = graph.ctx.currentTime;
    graph.gammaBus.gain.setTargetAtTime(gammaOn ? gammaLevel : 0, t, .06);
    graph.gammaCarrier.type = gammaWave; graph.gammaCarrier.frequency.setTargetAtTime(gammaCarrierHz, t, .04);
    graph.gammaLfo.frequency.setTargetAtTime(gammaRate, t, .04);
    graph.gammaLfo.setPeriodicWave(makeGammaWave(graph.ctx, gammaDuty, gammaEdge));
    graph.gammaAM.gain.setTargetAtTime(1 - gammaDepth / 2, t, .05);
    graph.gammaAMDepth.gain.setTargetAtTime(gammaDepth / 2, t, .05);
  }, [gammaOn, gammaLevel, gammaWave, gammaCarrierHz, gammaRate, gammaDuty, gammaEdge, gammaDepth, graphVersion]);

  // #3 — animation loop driving the Risset rhythm (variable layers/ratio/focus)
  useEffect(() => {
    if (!running || !rissetOn) return;
    let frame = 0; let last = performance.now();
    const loop = (now: number) => {
      const graph = graphRef.current;
      if (graph) {
        const dt = Math.min(0.05, (now - last) / 1000); last = now; const t = graph.ctx.currentTime;
        const layersN = rissetLayersRef.current, ratio = rissetRatioRef.current, focus = rissetFocusRef.current;
        rissetPhaseRef.current = (rissetPhaseRef.current + dt * rissetRateRef.current * rissetDirRef.current * layersN + layersN * 100) % layersN;
        const q = rissetPhaseRef.current, base = (bpmRef.current / 60) * 2, pd = pulseDepthRef.current, center = (layersN - 1) / 2;
        graph.pulse.gates.forEach((gate, j) => {
          if (j >= layersN) { graph.pulse.amps[j].gain.setTargetAtTime(0, t, .03); graph.pulse.depths[j].gain.setTargetAtTime(0, t, .03); return; }
          const e = ((j + q) % layersN);
          gate.frequency.setTargetAtTime(clamp(base * Math.pow(ratio, e - center), 0.05, 40), t, .03);
          const w = gaussian(e, center, focus) * pd * 0.6;
          graph.pulse.amps[j].gain.setTargetAtTime(w, t, .03); graph.pulse.depths[j].gain.setTargetAtTime(w, t, .03);
        });
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [running, rissetOn]);

  useEffect(() => {
    if (!running) return;
    if (!sessionOriginRef.current) sessionOriginRef.current = performance.now() - elapsed * 1000;
    const timer = window.setInterval(() => { const next = (performance.now() - sessionOriginRef.current) / 1000; setElapsed(next); if (next >= sessionLength * 60) stopAudio(); }, 100);
    return () => window.clearInterval(timer);
  }, [running, sessionLength, stopAudio]);

  const seekSession = useCallback((nextProgress: number) => {
    const nextElapsed = clamp(nextProgress, 0, 1) * sessionLength * 60;
    setElapsed(nextElapsed);
    if (running) sessionOriginRef.current = performance.now() - nextElapsed * 1000;
  }, [running, sessionLength]);

  const toggleNoise = (color: NoiseColor) => setNoiseActive((current) => ({ ...current, [color]: !current[color] }));
  const setAllNoise = (on: boolean) => setNoiseActive({ WHITE: on, PINK: on, BROWN: on, BLUE: on, VIOLET: on, GREY: on });

  const loadPreset = (name: keyof typeof presets) => {
    const next = presets[name]; setPreset(name); setCarrier(next.carrier); setBeat(next.beat); setBpm(next.bpm);
    setNoiseActive({ WHITE: false, PINK: next.noise === "PINK", BROWN: next.noise === "BROWN", BLUE: false, VIOLET: false, GREY: false });
    setLayers((current) => ({ ...current, beat: { ...current.beat, gain: next.layers.beat }, veil: { ...current.veil, gain: next.layers.veil }, pulse: { ...current.pulse, gain: next.layers.pulse }, drone: { ...current.drone, gain: next.layers.drone } }));
  };

  // Feature 1 — a full snapshot of every control the instrument exposes.
  const collectSnapshot = (): Record<string, unknown> => ({
    carrier, beat, master, bpm, pulseDepth, pulseToneHz, pulseWave, pulseDuty, pulseSmooth, mode, waveform,
    amDepth, amShape, nestOn, thetaRate, rissetOn, rissetDir, rissetRate, rissetLayers, rissetRatio, rissetFocus,
    missingFund, mfPartials, mfBrightness, gammaOn, gammaRate, gammaCarrierHz, gammaDepth, gammaDuty, gammaEdge, gammaLevel, gammaWave,
    noiseActive, noiseLevels, veilType, veilCenter, veilQ, veilGainDb, veilSweepRate, veilSweepDepth, veilTilt,
    comodOn, comodRate, comodDepth, comodShape, layers, sessionLength, automation, drift, tubeDrive, automationTracks,
  });

  const applySnapshot = (d: Record<string, unknown>) => {
    const setters: Record<string, (v: unknown) => void> = {
      carrier: (v) => setCarrier(v as number), beat: (v) => setBeat(v as number), master: (v) => setMaster(v as number), bpm: (v) => setBpm(v as number),
      pulseDepth: (v) => setPulseDepth(v as number), pulseToneHz: (v) => setPulseToneHz(v as number), pulseWave: (v) => setPulseWave(v as Waveform), pulseDuty: (v) => setPulseDuty(v as number), pulseSmooth: (v) => setPulseSmooth(v as number),
      mode: (v) => setMode(v as BeatMode), waveform: (v) => setWaveform(v as Waveform), amDepth: (v) => setAmDepth(v as number), amShape: (v) => setAmShape(v as AmShape),
      nestOn: (v) => setNestOn(v as boolean), thetaRate: (v) => setThetaRate(v as number), rissetOn: (v) => setRissetOn(v as boolean), rissetDir: (v) => setRissetDir(v as number),
      rissetRate: (v) => setRissetRate(v as number), rissetLayers: (v) => setRissetLayers(v as number), rissetRatio: (v) => setRissetRatio(v as number), rissetFocus: (v) => setRissetFocus(v as number),
      missingFund: (v) => setMissingFund(v as boolean), mfPartials: (v) => setMfPartials(v as number), mfBrightness: (v) => setMfBrightness(v as number),
      gammaOn: (v) => setGammaOn(v as boolean), gammaRate: (v) => setGammaRate(v as number), gammaCarrierHz: (v) => setGammaCarrierHz(v as number), gammaDepth: (v) => setGammaDepth(v as number),
      gammaDuty: (v) => setGammaDuty(v as number), gammaEdge: (v) => setGammaEdge(v as number), gammaLevel: (v) => setGammaLevel(v as number), gammaWave: (v) => setGammaWave(v as Waveform),
      noiseActive: (v) => setNoiseActive(v as Record<NoiseColor, boolean>), noiseLevels: (v) => setNoiseLevels(v as Record<NoiseColor, number>), veilType: (v) => setVeilType(v as VeilType),
      veilCenter: (v) => setVeilCenter(v as number), veilQ: (v) => setVeilQ(v as number), veilGainDb: (v) => setVeilGainDb(v as number), veilSweepRate: (v) => setVeilSweepRate(v as number),
      veilSweepDepth: (v) => setVeilSweepDepth(v as number), veilTilt: (v) => setVeilTilt(v as number), comodOn: (v) => setComodOn(v as boolean), comodRate: (v) => setComodRate(v as number),
      comodDepth: (v) => setComodDepth(v as number), comodShape: (v) => setComodShape(v as AmShape), layers: (v) => setLayers(v as LayerState), sessionLength: (v) => setSessionLength(v as number),
      automation: (v) => setAutomation(v as boolean), drift: (v) => setDrift(v as number), tubeDrive: (v) => setTubeDrive(v as Record<TubeKey, number>), automationTracks: (v) => setAutomationTracks(v as AutomationTrack[]),
    };
    Object.keys(setters).forEach((k) => { if (d[k] !== undefined) setters[k](d[k]); });
  };

  const persistPresets = (list: { name: string; data: Record<string, unknown> }[]) => {
    setUserPresets(list);
    try { window.localStorage.setItem("nocturne.presets", JSON.stringify(list)); } catch { /* storage blocked */ }
  };

  const saveUserPreset = () => {
    const name = window.prompt("Save current settings as:", `Setting ${userPresets.length + 1}`)?.trim();
    if (!name) return;
    const list = [...userPresets.filter((p) => p.name !== name), { name, data: collectSnapshot() }].sort((a, b) => a.name.localeCompare(b.name));
    persistPresets(list); setSelectedPreset(name);
  };
  const loadUserPreset = (name: string) => {
    const found = userPresets.find((p) => p.name === name); if (found) { applySnapshot(found.data); setSelectedPreset(name); }
  };
  const deleteUserPreset = () => {
    if (!selectedPreset) return;
    if (!window.confirm(`Delete saved setting “${selectedPreset}”?`)) return;
    persistPresets(userPresets.filter((p) => p.name !== selectedPreset)); setSelectedPreset("");
  };

  useEffect(() => {
    try { const raw = window.localStorage.getItem("nocturne.presets"); if (raw) setUserPresets(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);

  // Feature 2 — offline-render the session to a FLAC file (no realtime playback).
  const exportFlac = useCallback(async () => {
    if (exportStatus.busy) return;
    const duration = sessionLength * 60;
    setExportStatus({ busy: true, msg: `Synthesizing ${sessionLength} min…` });
    try {
      await new Promise((r) => setTimeout(r, 30)); // let the UI paint the busy state
      const buffer = await renderSession(collectSnapshot(), duration);
      setExportStatus({ busy: true, msg: "Encoding FLAC…" });
      await new Promise((r) => setTimeout(r, 15));
      const bytes = encodeFlacFromBuffer(buffer);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      downloadBytes(bytes, `nocturne-${stamp}.flac`);
      setExportStatus({ busy: false, msg: `Saved · ${(bytes.length / 1e6).toFixed(1)} MB` });
      window.setTimeout(() => setExportStatus({ busy: false, msg: "" }), 5000);
    } catch (err) {
      console.error("FLAC export failed", err);
      setExportStatus({ busy: false, msg: "Render failed — try a shorter session" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportStatus.busy, sessionLength]);

  const changeTrackParameter = (trackId: string, parameter: AutomationParam) => {
    const spec = PARAM_MAP[parameter]; if (!spec) return;
    const normalized = clamp((currentControlValue(parameter) - spec.min) / (spec.max - spec.min), 0, 1);
    setAutomationTracks((tracks) => tracks.map((track) => track.id === trackId ? { ...track, parameter, points: flatPoints(normalized), selectedPointId: undefined } : track));
  };

  // Right-click a control → add (or focus) an automation lane for it.
  const automateParam = useCallback((key: string) => {
    const spec = PARAM_MAP[key]; if (!spec) return;
    setAutomationTracks((tracks) => {
      if (tracks.some((t) => t.parameter === key)) return tracks;
      if (tracks.length >= 12) return tracks;
      const normalized = clamp((readParam(key) - spec.min) / (spec.max - spec.min), 0, 1);
      return [...tracks, { id: `track-${Date.now()}-${key}`, parameter: key, points: flatPoints(normalized) }];
    });
    setAutomation(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const controlActions = useMemo<ControlActions>(() => ({ reset: resetParam, automate: automateParam }), [resetParam, automateParam]);

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
    if (automationTracks.length >= 12) return;
    const used = new Set(automationTracks.map((track) => track.parameter));
    const parameter = PARAM_DEFS.find((control) => !used.has(control.key))?.key || "carrier";
    const spec = PARAM_MAP[parameter];
    const normalized = clamp((currentControlValue(parameter) - spec.min) / (spec.max - spec.min), 0, 1);
    setAutomationTracks((tracks) => [...tracks, { id: `track-${Date.now()}`, parameter, points: flatPoints(normalized) }]);
  };

  const formatAutomationValue = (parameter: AutomationParam) => {
    const spec = PARAM_MAP[parameter]; if (!spec) return "";
    const value = currentControlValue(parameter);
    return `${value.toFixed(spec.step < .1 ? 2 : spec.step < 1 ? 1 : 0)}${spec.unit}`;
  };

  const band = beat < 4 ? "DELTA" : beat < 8 ? "THETA" : beat < 13 ? "ALPHA" : beat < 30 ? "BETA" : "EXPERIMENTAL";
  const graph = graphRef.current;
  const masterDb = master <= .01 ? "−∞" : (20 * Math.log10(master * .58)).toFixed(1);
  const activeNoise = NOISE_COLORS.filter((c) => noiseActive[c]);
  const noiseSummary = activeNoise.length === 0 ? "SILENT" : activeNoise.length === 1 ? activeNoise[0] : `${activeNoise.length}× MIX`;
  const channels = useMemo(() => [
    { key: "beat" as const, number: "I", name: "BINAURAL", detail: `${carrier.toFixed(0)}Hz · ${beat.toFixed(1)}Δ`, color: "amber" },
    { key: "veil" as const, number: "II", name: "NOISE VEIL", detail: noiseSummary, color: "cyan" },
    { key: "pulse" as const, number: "III", name: "SYNC PULSE", detail: rissetOn ? "RISSET" : `${bpm} BPM`, color: "ruby" },
    { key: "drone" as const, number: "IV", name: "SUBSTRATE", detail: missingFund ? "MISSING f₀" : `${(carrier / 4).toFixed(0)}Hz`, color: "violet" },
  ], [beat, bpm, carrier, noiseSummary, rissetOn, missingFund]);

  return (
    <ControlContext.Provider value={controlActions}>
    <main className="app-shell">
      <div className="top-rail" />
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true"><span>✦</span></div>
        <div className="brand"><p>NOCTURNE LABORATORY</p><h1>Psychoacoustic Research Console</h1><div><span>THERMIONIC SERIES</span><i>•</i><span>INSTRUMENT № 01</span></div></div>
        <div className="session-status">
          <div><span className={`status-lamp ${running ? "lit" : ""}`} /><small>SYSTEM</small><b>{running ? "ACTIVE" : "STANDBY"}</b></div>
          <div><small>OUTPUT</small><b>AIRPODS · STEREO</b></div>
        </div>
      </header>

      {/* Move I — persistent transport rail: play/stop, clock, master, meter, band, always in reach. */}
      <section className="transport-rail" aria-label="Master transport">
        <button className={`transport-play ${running ? "stop" : ""} ${!running && !hintDismissed ? "pulsing" : ""}`} onClick={startAudio} aria-label={running ? "Stop session" : "Play session"}><span>{running ? "■" : "▶"}</span></button>
        <div className="transport-clock"><small>SESSION</small><b className="digital">{formatTime(elapsed)}</b><em>{formatTime(sessionLength * 60)}</em></div>
        <div className="transport-sep" />
        <div className="transport-master">
          <div className="tm-top"><span>MASTER OUTPUT</span><b className="digital">{masterDb} dBFS</b></div>
          <Slider min={0} max={1} step={0.01} value={master} onChange={setMaster} paramKey="master" ariaLabel="Master output level" />
          <div className="tm-foot"><span>−∞</span><span className="guard"><i className="on" />PEAK GUARD · −1 dBTP</span><span>0</span></div>
        </div>
        <div className="transport-sep" />
        <OutputMeter analyserL={graph?.analyserL || null} analyserR={graph?.analyserR || null} running={running} />
        <div className="transport-band"><small>BAND</small><b>{band}</b></div>
        {!running && !hintDismissed && <div className="transport-hint" role="status"><b>Put on headphones</b>, then press Engage ▸<button onClick={() => setHintDismissed(true)} aria-label="Dismiss hint">×</button></div>}
      </section>

      <nav className="preset-strip" aria-label="Session presets">
        <span>PROGRAM</span>
        {(Object.keys(presets) as (keyof typeof presets)[]).map((name) => <button key={name} className={preset === name ? "selected" : ""} onClick={() => loadPreset(name)}>{name}</button>)}
        <div className="preset-sep" />
        <span>SAVED</span>
        <div className="user-presets">
          <select value="" onChange={(e) => e.target.value && loadUserPreset(e.target.value)} aria-label="Load saved setting" title="Load a saved setting">
            <option value="">{selectedPreset ? `Loaded: ${selectedPreset}` : "— select —"}</option>
            {userPresets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button onClick={saveUserPreset} title="Save current settings">＋ SAVE</button>
          <button className="preset-del" onClick={deleteUserPreset} disabled={!selectedPreset} title="Delete selected saved setting">🗑</button>
        </div>
        <div className="strip-spacer" /><span>RESEARCH MODE</span><strong>{band}</strong><span className="calibration">CAL · 48kHz</span>
      </nav>

      <section className="top-row">
        <article className="panel beat-panel">
          <PanelHeading roman="I" title="Auditory Beat Engine" subtitle="Protected stereo excitation" />
          <div className="mode-tabs">
            {(["binaural", "monaural", "isochronic"] as BeatMode[]).map((item) => <button key={item} title={running ? "Crossfades live into the new topology" : ""} className={mode === item ? "active" : ""} onClick={() => changeMode(item)} onDoubleClick={() => changeMode("binaural")}>{item}</button>)}
          </div>
          <div className="frequency-readout"><small>INTERAURAL CONFIGURATION</small><div><span>L</span><b>{(carrier - beat / 2).toFixed(2)}</b><i>Hz</i></div><div><span>R</span><b>{(carrier + beat / 2).toFixed(2)}</b><i>Hz</i></div><em>Δ {beat.toFixed(2)} Hz</em></div>
          <div className="knob-row">
            <Knob label="CARRIER" paramKey="carrier" value={carrier} min={80} max={1000} step={1} unit=" Hz" size="lg" onChange={setCarrier} />
            <Knob label="BEAT Δ" paramKey="beat" value={beat} min={0.5} max={40} step={0.1} unit=" Hz" size="lg" onChange={setBeat} />
          </div>
          <div className="switch-bank"><span>OSCILLATOR</span>{(["sine", "triangle", "sawtooth"] as Waveform[]).map((wave) => <button key={wave} className={waveform === wave ? "active" : ""} onClick={() => setWaveform(wave)} onDoubleClick={() => setWaveform("sine")}>{wave === "sine" ? "∿" : wave === "triangle" ? "△" : "⋀"}</button>)}</div>
          <div className="mod-lab">
            <div className="mod-head"><span>MODULATION LAB</span><em>rate = beat Δ {beat.toFixed(1)} Hz</em></div>
            <div className="mod-row">
              <Knob label="AM DEPTH" paramKey="amDepth" value={amDepth} min={0} max={1} step={0.01} size="sm" onChange={setAmDepth} />
              <div className="mod-shape"><span>ENVELOPE</span><div>{(["sine", "triangle", "square"] as AmShape[]).map((s) => <button key={s} className={amShape === s ? "active" : ""} title={s} onClick={() => setAmShape(s)} onDoubleClick={() => setAmShape("sine")}>{s === "sine" ? "∿" : s === "triangle" ? "△" : "⊓"}</button>)}</div></div>
              <div className="mod-nest"><Toggle active={nestOn} label="θ–γ NEST" paramKey="nestOn" onClick={() => setNestOn(!nestOn)} /><Knob label="θ RATE" paramKey="thetaRate" value={thetaRate} min={2} max={8} step={0.1} unit=" Hz" size="sm" onChange={setThetaRate} /></div>
            </div>
          </div>
          <TopologyDiagram carrier={carrier} beat={beat} mode={mode} />
          <div className="field-note"><span>HEADPHONES REQUIRED</span><p>Left and right carriers remain isolated through the protected signal path.</p></div>
        </article>

        <div className="obs-stack">
        <div className="obs-top">
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
          <PanelHeading roman="III" title="Master Section" subtitle="Output trim & protection" />
          <ExposureMeter progress={progress} master={master} running={running} />
          <div className="master-knob"><Knob label="MASTER TRIM" paramKey="master" value={master} min={0} max={1} step={0.01} unit="" size="lg" onChange={setMaster} /><div className="db-readout">{masterDb} <span>dBFS</span></div></div>
          <div className="safety-row"><Toggle active={safeMode} label="PEAK GUARD" onClick={() => undefined} /><span><i className="on" />−1 dBTP</span></div>
          <div className="duration-control"><label>SESSION LENGTH <b>{sessionLength} MIN</b></label><Slider min={5} max={90} step={5} value={sessionLength} onChange={setSessionLength} defaultValue={30} /></div>
          <div className="export-row">
            <button className={`export-btn ${exportStatus.busy ? "busy" : ""}`} onClick={exportFlac} disabled={exportStatus.busy} title="Offline-synthesize the full session (settings + automation) to a FLAC file">
              {exportStatus.busy ? "◍ RENDERING…" : "⬇ RENDER SESSION → FLAC"}
            </button>
            <small className="export-status">{exportStatus.msg || `${sessionLength} min · 48 kHz · lossless`}</small>
          </div>
          <div className="output-note"><b>DIGITAL LEVEL ≠ EAR SPL</b><p>Keep device volume moderate. Stop if sound causes discomfort or ringing.</p></div>
        </article>
        </div>
        <article className="panel signalflow-panel">
          <div className="sf-header"><span className="sf-diamond">✦</span><b>SIGNAL FLOW</b><em>generators → buses → master → thermionic → earbuds</em><span className={`sf-live ${running ? "on" : ""}`}>{running ? "● LIVE" : "○ IDLE"}</span></div>
          <SignalFlow running={running} graph={graph} gammaOn={gammaOn} gammaLevel={gammaLevel} rissetOn={rissetOn} missingFund={missingFund} mode={mode} layers={layers} noiseCount={activeNoise.length} activeTubes={TUBE_KEYS.filter((t) => tubeDrive[t] > 0).length} />
        </article>
        </div>
      </section>

      <section className="console-grid">
        <article className="panel mixer-panel">
          <PanelHeading roman="IV" title="Fourfold Layer Matrix" subtitle="Independent buses · gain · pan · isolation · metering" />
          <div className="mixer-channels">
            {channels.map((channel) => {
              const state = layers[channel.key];
              const soloed = Object.values(layers).some((l) => l.solo);
              const audible = running && !state.muted && (!soloed || state.solo);
              return <div className={`channel channel-${channel.color}`} key={channel.key}>
                <div className="channel-head"><span>{channel.number}</span><div><b>{channel.name}</b><small>{channel.detail}</small></div><i className={!state.muted ? "on" : ""} /></div>
                <div className="channel-body">
                  <Knob label="PAN" paramKey={`${channel.key}Pan`} value={state.pan} min={-1} max={1} step={0.05} size="sm" onChange={(pan) => updateLayer(channel.key, { pan })} />
                  <Fader label={channel.name} paramKey={`${channel.key}Gain`} value={state.gain} onChange={(gain) => updateLayer(channel.key, { gain })} />
                  <ChannelMeter analyser={graph?.layerAnalysers[channel.key] || null} running={running} active={audible} />
                  <div className="channel-buttons"><button className={state.muted ? "active" : ""} onClick={() => updateLayer(channel.key, { muted: !state.muted })}>M</button><button className={state.solo ? "active solo" : ""} onClick={() => updateLayer(channel.key, { solo: !state.solo })}>S</button></div>
                  <output>{(state.gain * 100).toFixed(0)}</output>
                </div>
              </div>;
            })}
          </div>
          <div className="matrix-advanced">
            <div className={`matrix-cell pulse-cell ${rissetOn ? "on" : ""}`}>
              <div className="mx-head"><span className="mx-chip" style={{ background: "var(--ruby)" }} /><b>III · SYNC PULSE</b><small>edge-softened isochronic gate</small></div>
              <div className="mx-body pulse-core">
                <Knob label="TEMPO" paramKey="bpm" value={bpm} min={30} max={180} step={1} unit=" BPM" size="sm" onChange={setBpm} />
                <Knob label="TONE" paramKey="pulseToneHz" value={pulseToneHz} min={40} max={800} step={1} unit=" Hz" size="sm" onChange={setPulseToneHz} />
                <div className="mod-shape pulse-wave"><span>WAVE</span><div>{(["sine", "triangle", "sawtooth", "square"] as Waveform[]).map((w) => <button key={w} className={pulseWave === w ? "active" : ""} title={w} onClick={() => setPulseWave(w)} onDoubleClick={() => setPulseWave("sine")}>{w === "sine" ? "∿" : w === "triangle" ? "△" : w === "sawtooth" ? "⋀" : "⊓"}</button>)}</div></div>
                <Knob label="DUTY" paramKey="pulseDuty" value={pulseDuty} min={0.1} max={0.9} step={0.01} size="sm" onChange={setPulseDuty} />
                <Knob label="SMOOTH" paramKey="pulseSmooth" value={pulseSmooth} min={0} max={1} step={0.01} size="sm" onChange={setPulseSmooth} />
                <Knob label="DEPTH" paramKey="pulseDepth" value={pulseDepth} min={0} max={1} step={0.01} size="sm" onChange={setPulseDepth} />
              </div>
              <div className="pulse-risset">
                <Toggle active={rissetOn} label="RISSET RHYTHM" paramKey="rissetOn" onClick={() => setRissetOn(!rissetOn)} />
                <div className="dir-toggle"><button className={rissetDir > 0 ? "active" : ""} onClick={() => setRissetDir(1)} onDoubleClick={() => setRissetDir(1)}>▲ FASTER</button><button className={rissetDir < 0 ? "active" : ""} onClick={() => setRissetDir(-1)}>▼ SLOWER</button></div>
                <Knob label="DRIFT" paramKey="rissetRate" value={rissetRate} min={0.005} max={0.15} step={0.005} size="sm" onChange={setRissetRate} />
                <Knob label="LAYERS" paramKey="rissetLayers" value={rissetLayers} min={2} max={5} step={1} onChange={setRissetLayers} size="sm" />
                <Knob label="RATIO" paramKey="rissetRatio" value={rissetRatio} min={1.5} max={4} step={0.1} size="sm" onChange={setRissetRatio} />
                <Knob label="FOCUS" paramKey="rissetFocus" value={rissetFocus} min={0.4} max={1.6} step={0.05} size="sm" onChange={setRissetFocus} />
              </div>
            </div>
            <div className={`matrix-cell ${missingFund ? "on" : ""}`}>
              <div className="mx-head"><span className="mx-chip" style={{ background: "var(--violet)" }} /><b>IV · SUBSTRATE</b><Toggle active={missingFund} label="MISSING FUNDAMENTAL" paramKey="missingFund" onClick={() => setMissingFund(!missingFund)} /></div>
              <div className="mx-body">
                <div className="mx-note">Perceived pitch {(carrier / 4).toFixed(0)} Hz from harmonics only — felt on earbuds no driver reproduces.</div>
                <Knob label="PARTIALS" paramKey="mfPartials" value={mfPartials} min={3} max={7} step={1} size="sm" onChange={setMfPartials} />
                <Knob label="BRIGHTNESS" paramKey="mfBrightness" value={mfBrightness} min={0} max={0.9} step={0.05} size="sm" onChange={setMfBrightness} />
              </div>
            </div>
          </div>
        </article>

        <article className="panel valves-panel">
          <PanelHeading roman="V" title="Thermionic Monitor" subtitle="Metering & four-stage harmonic circuit" />
          <div className="vu-pair"><VUMeter analyser={graph?.analyserL || null} label="LEFT" running={running} /><VUMeter analyser={graph?.analyserR || null} label="RIGHT" running={running} /></div>
          <div className="tube-circuit-frame"><TubeCircuit running={running} tubeDrive={tubeDrive} /></div>
          <div className="tube-knobs">{TUBE_KEYS.map((tube) => <div key={tube} className="tube-knob" title={TUBE_DESCRIPTIONS[tube]}><Knob label={tube} value={tubeDrive[tube]} min={0} max={1} step={0.01} size="sm" defaultValue={tube === "ECC83" ? 0.18 : 0} onChange={(v) => setTubeDrive((current) => ({ ...current, [tube]: v }))} /></div>)}</div>
          <div className="hardware-stats"><span><small>LATENCY</small><b>{running && graph ? Math.round(graph.ctx.baseLatency * 1000) : 0} ms</b></span><span><small>COLOUR</small><b>{TUBE_KEYS.filter((tube) => tubeDrive[tube] > 0).length} STAGES</b></span><span><small>LIMITER</small><b>{safeMode ? "ARMED" : "BYPASS"}</b></span></div>
        </article>

        <article className="panel phenomena-panel">
          <PanelHeading roman="VII" title="Phenomena Laboratory" subtitle="Audible gamma engine · noise synthesis · psychoacoustic edge" />
          <div className="phenomena-grid">
            <div className="phen-col">
              <div className="phen-col-head"><span className={`gamma-lamp ${gammaOn ? "on" : ""}`} />40 Hz GAMMA ENGINE — AUDITORY</div>
              <div className={`gamma-engine ${gammaOn ? "on" : ""}`}>
                <div className="gamma-top">
                  <Toggle active={gammaOn} label="ENGAGE GAMMA" paramKey="gammaOn" onClick={() => setGammaOn(!gammaOn)} />
                  <div className="gamma-wave"><span>CARRIER WAVE</span><div>{(["sine", "triangle", "sawtooth", "square"] as Waveform[]).map((w) => <button key={w} className={gammaWave === w ? "active" : ""} title={w} onClick={() => setGammaWave(w)} onDoubleClick={() => setGammaWave("sine")}>{w === "sine" ? "∿" : w === "triangle" ? "△" : w === "sawtooth" ? "⋀" : "⊓"}</button>)}</div></div>
                </div>
                <div className="gamma-knobs">
                  <Knob label="GAMMA RATE" paramKey="gammaRate" value={gammaRate} min={30} max={100} step={1} unit=" Hz" size="lg" onChange={setGammaRate} />
                  <Knob label="CARRIER" paramKey="gammaCarrierHz" value={gammaCarrierHz} min={80} max={1000} step={1} unit=" Hz" size="lg" onChange={setGammaCarrierHz} />
                  <Knob label="DEPTH" paramKey="gammaDepth" value={gammaDepth} min={0} max={1} step={0.01} onChange={setGammaDepth} />
                  <Knob label="DUTY" paramKey="gammaDuty" value={gammaDuty} min={0.05} max={0.95} step={0.01} onChange={setGammaDuty} />
                  <Knob label="EDGE" paramKey="gammaEdge" value={gammaEdge} min={0} max={1} step={0.01} onChange={setGammaEdge} />
                  <Knob label="LEVEL" paramKey="gammaLevel" value={gammaLevel} min={0} max={0.8} step={0.01} onChange={setGammaLevel} />
                </div>
                <p className="gamma-note">Isolated 30–100 Hz amplitude-modulated tone (default 40 Hz). Audio-only — combine with headphones. Research on 40 Hz stimulation is preliminary; this is a compositional instrument, not a treatment.</p>
              </div>
            </div>
            <div className="phen-col">
              <div className="phen-col-head">NOISE LABORATORY</div>
              <div className="noise-bank-head"><span>SOURCE BANK — MIX ANY COMBINATION</span><div className="nb-allnone"><button onClick={() => setAllNoise(true)}>ALL</button><button onClick={() => setAllNoise(false)}>NONE</button></div></div>
              <div className="noise-bank">
                {NOISE_COLORS.map((col) => <div className={`noise-row nc-${col.toLowerCase()} ${noiseActive[col] ? "on" : ""}`} key={col}>
                  <button className="nr-toggle" onClick={() => toggleNoise(col)}><i /></button>
                  <span className="nr-name">{col}</span>
                  <Slider min={0} max={1} step={0.01} value={noiseLevels[col]} disabled={!noiseActive[col]} defaultValue={0.75} onChange={(v) => setNoiseLevels((cur) => ({ ...cur, [col]: v }))} ariaLabel={`${col} level`} />
                </div>)}
              </div>
              <div className="noise-filter">
                <div className="nf-mode"><span>VEIL FILTER</span>{(["off", "lowpass", "highpass", "bandpass", "notch", "peaking"] as VeilType[]).map((m) => <button key={m} className={veilType === m ? "active" : ""} onClick={() => setVeilType(m)} onDoubleClick={() => setVeilType("off")}>{m === "off" ? "OFF" : m === "lowpass" ? "LP" : m === "highpass" ? "HP" : m === "bandpass" ? "BP" : m === "notch" ? "NOTCH" : "PEAK"}</button>)}</div>
                <div className="nf-params">
                  <label>CENTER <b>{veilCenter} Hz</b><Slider min={80} max={10000} step={10} value={veilCenter} disabled={veilType === "off"} paramKey="veilCenter" onChange={setVeilCenter} /></label>
                  <label>RESONANCE <b>{veilQ.toFixed(1)}</b><Slider min={0.3} max={24} step={0.3} value={veilQ} disabled={veilType === "off"} paramKey="veilQ" onChange={setVeilQ} /></label>
                  <label>GAIN <b>{veilGainDb > 0 ? `+${veilGainDb}` : veilGainDb} dB</b><Slider min={-24} max={24} step={1} value={veilGainDb} disabled={veilType !== "peaking"} paramKey="veilGainDb" onChange={setVeilGainDb} /></label>
                  <label>SWEEP RATE <b>{veilSweepRate.toFixed(2)} Hz</b><Slider min={0} max={4} step={0.05} value={veilSweepRate} disabled={veilType === "off"} paramKey="veilSweepRate" onChange={setVeilSweepRate} /></label>
                  <label>SWEEP DEPTH <b>{(veilSweepDepth * 100).toFixed(0)}%</b><Slider min={0} max={1} step={0.01} value={veilSweepDepth} disabled={veilType === "off" || veilSweepRate === 0} paramKey="veilSweepDepth" onChange={setVeilSweepDepth} /></label>
                  <label>SPECTRAL TILT <b>{veilTilt > 0 ? `+${veilTilt.toFixed(2)}` : veilTilt < 0 ? veilTilt.toFixed(2) : "flat"}</b><Slider min={-1} max={1} step={0.05} value={veilTilt} paramKey="veilTilt" onChange={setVeilTilt} /></label>
                </div>
              </div>
              <div className={`comod-box ${comodOn ? "on" : ""}`}>
                <div className="comod-head"><Toggle active={comodOn} label="COMODULATION" paramKey="comodOn" onClick={() => setComodOn(!comodOn)} /><span>coherent cross-band AM — masking release</span></div>
                <div className="comod-body">
                  <label>RATE <b>{comodRate.toFixed(1)} Hz</b><Slider min={0.2} max={30} step={0.1} value={comodRate} disabled={!comodOn} paramKey="comodRate" onChange={setComodRate} /></label>
                  <label>DEPTH <b>{(comodDepth * 100).toFixed(0)}%</b><Slider min={0} max={1} step={0.01} value={comodDepth} disabled={!comodOn} paramKey="comodDepth" onChange={setComodDepth} /></label>
                  <div className="comod-shape"><span>SHAPE</span>{(["sine", "triangle", "square"] as AmShape[]).map((s) => <button key={s} className={comodShape === s ? "active" : ""} disabled={!comodOn} onClick={() => setComodShape(s)} onDoubleClick={() => setComodShape("sine")}>{s === "sine" ? "∿" : s === "triangle" ? "△" : "⊓"}</button>)}</div>
                </div>
              </div>
            </div>
          </div>
        </article>

        <article className="panel automation-panel">
          <PanelHeading roman="VI" title="Temporal Automation" subtitle="Live parameter splines · no write pass required" />
          <div className="automation-toolbar"><Toggle active={automation} label="LIVE AUTOMATION" onClick={() => setAutomation(!automation)} /><div className="bpm"><button onClick={() => setBpm(clamp(bpm - 1, 30, 180))}>−</button><b>{bpm}</b><span>BPM</span><button onClick={() => setBpm(clamp(bpm + 1, 30, 180))}>+</button></div><div className="drift"><label>ORGANIC DRIFT <b>{drift.toFixed(2)}</b></label><Slider min={0} max={1} step={0.01} value={drift} onChange={setDrift} paramKey="drift" /></div><div className="drift"><label>PULSE DEPTH <b>{pulseDepth.toFixed(2)}</b></label><Slider min={0} max={1} step={0.01} value={pulseDepth} onChange={setPulseDepth} paramKey="pulseDepth" /></div><button className="add-track" disabled={automationTracks.length >= 6} onClick={addAutomationTrack}>＋ ADD CONTROL</button></div>
          <div className="automation-help"><span>DRAG TO SHAPE</span><p>Drag the red playhead to scrub live. Add a handle, drag it for value and time, or double-click an interior handle to delete it.</p><b>{automation ? `LIVE · ${formatTime(elapsed)}` : "BYPASSED"}</b></div>
          <div className="automation-ruler">{[0, .25, .5, .75, 1].map((value) => <span key={value}>{Math.round(value * sessionLength)}:00</span>)}</div>
          <div className="automation-tracks">
            {automationTracks.map((track) => {
              const meta = PARAM_MAP[track.parameter] ?? PARAM_DEFS[0];
              const label = meta.label;
              return <div className="automation-track" key={track.id}>
                <div className="track-controls">
                  <div className="track-source"><i className="track-chip" style={{ background: meta.hue }} /><span>PANEL {meta.panel}</span></div>
                  <div className="track-select"><select aria-label="Automated control" value={track.parameter} onChange={(event) => changeTrackParameter(track.id, event.target.value as AutomationParam)}>{AUTOMATION_GROUPS.map((grp) => <optgroup key={grp} label={grp}>{PARAM_DEFS.filter((c) => c.group === grp).map((control) => <option key={control.key} value={control.key}>{control.label}</option>)}</optgroup>)}</select></div>
                  <output title={label}>{formatAutomationValue(track.parameter)}</output>
                  <div className="track-buttons">
                    <button title="Add control handle" onClick={() => addAutomationPoint(track.id)}>＋</button>
                    <button title="Delete selected handle" disabled={!track.selectedPointId || !!track.points.find((point) => point.id === track.selectedPointId && (point.time === 0 || point.time === 1))} onClick={() => deleteAutomationPoint(track.id)}>−</button>
                    <button className={`snap ${track.snap ? "on" : ""}`} title="Snap handles to the tempo grid" onClick={() => setAutomationTracks((tracks) => tracks.map((item) => item.id === track.id ? { ...item, snap: !item.snap } : item))}>SNAP</button>
                    <button className="remove-track" title="Remove automation track" disabled={automationTracks.length === 1} onClick={() => setAutomationTracks((tracks) => tracks.filter((item) => item.id !== track.id))}>×</button>
                  </div>
                </div>
                <AutomationGraph points={track.points} selectedId={track.selectedPointId} progress={progress} snap={track.snap} hue={meta.hue} onSeek={seekSession} onSelect={(selectedPointId) => setAutomationTracks((tracks) => tracks.map((item) => item.id === track.id ? { ...item, selectedPointId } : item))} onChange={(points) => setAutomationTracks((tracks) => tracks.map((item) => item.id === track.id ? { ...item, points } : item))} />
              </div>;
            })}
          </div>
        </article>
      </section>

      <footer><span>NOCTURNE LABORATORY · CHICAGO</span><p>EXPERIMENTAL WELLNESS INSTRUMENT · FREQUENCY LABELS ARE COMPOSITIONAL, NOT MEDICAL CLAIMS</p><span>BUILD 01 · M2 / CHROME</span></footer>
    </main>
    </ControlContext.Provider>
  );
}

function PanelHeading({ roman, title, subtitle }: { roman: string; title: string; subtitle: string }) {
  return <header className="panel-heading"><span>{roman}</span><div><h2>{title}</h2><p>{subtitle}</p></div><i>✦</i></header>;
}
