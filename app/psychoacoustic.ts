export type PcmData = {
  sampleRate: number;
  channels: Float32Array[];
};

export type TextureAnalysis = {
  sourceName: string;
  startSeconds: number;
  durationSeconds: number;
  segment: PcmData;
  bandCenters: number[];
  bandEnergies: number[];
  centroidHz: number;
  modulationHz: number;
  crestDb: number;
  rms: number;
};

function seededRandom(seed: number) {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function fft(real: Float64Array, imag: Float64Array, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < length / 2; j++) {
        const even = start + j;
        const odd = even + length / 2;
        const or = real[odd] * wr - imag[odd] * wi;
        const oi = real[odd] * wi + imag[odd] * wr;
        real[odd] = real[even] - or;
        imag[odd] = imag[even] - oi;
        real[even] += or;
        imag[even] += oi;
        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nextWr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

/**
 * Periodic, phase-consistent dichotic noise. The right channel receives a
 * progressive interaural phase transition inside the selected band while the
 * magnitude spectrum remains identical between ears.
 */
export function generateHugginsPcm(
  sampleRate: number,
  centerHz: number,
  widthHz: number,
  phaseDegrees: number,
  seed = 0x4e4f4354,
): PcmData {
  const n = 1 << 18;
  const leftR = new Float64Array(n);
  const leftI = new Float64Array(n);
  const rightR = new Float64Array(n);
  const rightI = new Float64Array(n);
  const random = seededRandom(seed);
  const low = Math.max(20, centerHz - widthHz / 2);
  const high = Math.min(sampleRate / 2 - 100, centerHz + widthHz / 2);
  const phaseSpan = phaseDegrees * Math.PI / 180;

  for (let k = 1; k < n / 2; k++) {
    const magnitude = Math.sqrt(-2 * Math.log(Math.max(1e-9, random())));
    const phase = random() * Math.PI * 2;
    const lr = magnitude * Math.cos(phase);
    const li = magnitude * Math.sin(phase);
    const frequency = k * sampleRate / n;
    const transition = frequency >= low && frequency <= high
      ? phaseSpan * (frequency - low) / Math.max(1, high - low)
      : 0;
    const rr = lr * Math.cos(transition) - li * Math.sin(transition);
    const ri = lr * Math.sin(transition) + li * Math.cos(transition);
    leftR[k] = lr; leftI[k] = li; leftR[n - k] = lr; leftI[n - k] = -li;
    rightR[k] = rr; rightI[k] = ri; rightR[n - k] = rr; rightI[n - k] = -ri;
  }
  fft(leftR, leftI, true);
  fft(rightR, rightI, true);

  let energy = 0;
  for (let i = 0; i < n; i++) energy += leftR[i] * leftR[i] + rightR[i] * rightR[i];
  const gain = 0.16 / Math.max(1e-9, Math.sqrt(energy / (n * 2)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = leftR[i] * gain;
    right[i] = rightR[i] * gain;
  }
  return { sampleRate, channels: [left, right] };
}

export function pcmToAudioBuffer(context: BaseAudioContext, pcm: PcmData) {
  const buffer = context.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate);
  pcm.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
  return buffer;
}

function erbRate(frequency: number) {
  return 21.4 * Math.log10(1 + 0.00437 * frequency);
}

function inverseErbRate(rate: number) {
  return (Math.pow(10, rate / 21.4) - 1) / 0.00437;
}

export function makeErbCenters(count: number, low = 80, high = 8000) {
  const lo = erbRate(low);
  const hi = erbRate(high);
  return Array.from({ length: count }, (_, i) => inverseErbRate(lo + (hi - lo) * i / Math.max(1, count - 1)));
}

function nextPowerOfTwo(value: number) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

export function analyzeTextureBuffer(buffer: AudioBuffer, sourceName: string, startSeconds: number, durationSeconds: number): TextureAnalysis {
  const start = Math.max(0, Math.floor(startSeconds * buffer.sampleRate));
  const length = Math.max(1, Math.min(buffer.length - start, Math.floor(durationSeconds * buffer.sampleRate)));
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, channel) => buffer.getChannelData(channel).slice(start, start + length));
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    for (const channel of channels) mono[i] += channel[i] / channels.length;
  }

  const fftSize = Math.min(4096, nextPowerOfTwo(Math.min(4096, length)));
  const hop = Math.max(1, fftSize >> 1);
  const centers = makeErbCenters(18, 70, Math.min(10000, buffer.sampleRate * 0.45));
  const powers = new Float64Array(centers.length);
  let totalPower = 0;
  let weightedFrequency = 0;
  for (let offset = 0; offset + fftSize <= mono.length; offset += hop) {
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) real[i] = mono[offset + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (fftSize - 1)));
    fft(real, imag);
    for (let k = 1; k < fftSize / 2; k++) {
      const frequency = k * buffer.sampleRate / fftSize;
      const power = real[k] * real[k] + imag[k] * imag[k];
      if (!Number.isFinite(power)) continue;
      let nearest = 0;
      let distance = Infinity;
      const rate = erbRate(frequency);
      for (let band = 0; band < centers.length; band++) {
        const nextDistance = Math.abs(rate - erbRate(centers[band]));
        if (nextDistance < distance) { distance = nextDistance; nearest = band; }
      }
      powers[nearest] += power;
      totalPower += power;
      weightedFrequency += power * frequency;
    }
  }
  const maxPower = Math.max(...powers, 1e-12);
  const bandEnergies = Array.from(powers, (power) => Math.max(0, Math.min(1, (10 * Math.log10(Math.max(1e-12, power / maxPower)) + 48) / 48)));

  const envelopeRate = 100;
  const envelopeHop = Math.max(1, Math.round(buffer.sampleRate / envelopeRate));
  const envelope = new Float64Array(Math.floor(mono.length / envelopeHop));
  let peak = 0;
  let squareSum = 0;
  for (let i = 0; i < mono.length; i++) {
    peak = Math.max(peak, Math.abs(mono[i]));
    squareSum += mono[i] * mono[i];
  }
  for (let frame = 0; frame < envelope.length; frame++) {
    let sum = 0;
    const from = frame * envelopeHop;
    const to = Math.min(mono.length, from + envelopeHop);
    for (let i = from; i < to; i++) sum += mono[i] * mono[i];
    envelope[frame] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const mean = envelope.reduce((sum, value) => sum + value, 0) / Math.max(1, envelope.length);
  for (let i = 0; i < envelope.length; i++) envelope[i] -= mean;
  let bestLag = 20;
  let bestCorrelation = -Infinity;
  for (let lag = 5; lag <= Math.min(200, envelope.length / 2); lag++) {
    let correlation = 0;
    let normA = 0;
    let normB = 0;
    for (let i = lag; i < envelope.length; i++) {
      correlation += envelope[i] * envelope[i - lag];
      normA += envelope[i] * envelope[i];
      normB += envelope[i - lag] * envelope[i - lag];
    }
    correlation /= Math.sqrt(normA * normB) || 1;
    const frequency = envelopeRate / lag;
    const score = correlation * Math.min(1, frequency / 1.2);
    if (score > bestCorrelation) { bestCorrelation = score; bestLag = lag; }
  }
  const rms = Math.sqrt(squareSum / Math.max(1, mono.length));
  return {
    sourceName,
    startSeconds,
    durationSeconds: length / buffer.sampleRate,
    segment: { sampleRate: buffer.sampleRate, channels },
    bandCenters: centers,
    bandEnergies,
    centroidHz: totalPower > 0 ? weightedFrequency / totalPower : 0,
    modulationHz: envelopeRate / bestLag,
    crestDb: 20 * Math.log10(Math.max(1e-9, peak) / Math.max(1e-9, rms)),
    rms,
  };
}

/** Granular overlap-add resynthesis that retains the analyzed cochlear profile. */
export function synthesizeTexturePcm(analysis: TextureAnalysis, grainMs: number, scatter: number, seed: number, seconds = 24): PcmData {
  const { segment } = analysis;
  const sampleRate = segment.sampleRate;
  const outputLength = Math.max(1, Math.floor(seconds * sampleRate));
  const grainLength = Math.max(256, Math.min(segment.channels[0].length, Math.floor(grainMs * sampleRate / 1000)));
  const hop = Math.max(64, Math.floor(grainLength / 4));
  const channels = segment.channels.map(() => new Float32Array(outputLength));
  const weight = new Float32Array(outputLength);
  const random = seededRandom(seed);
  let sequential = 0;
  const maxSource = Math.max(1, segment.channels[0].length - grainLength - 1);

  for (let out = -grainLength; out < outputLength; out += hop) {
    const randomPosition = Math.floor(random() * maxSource);
    const jitter = (random() - 0.5) * scatter * grainLength * 0.5;
    const source = Math.floor(Math.max(0, Math.min(maxSource, sequential * (1 - scatter) + randomPosition * scatter + jitter)));
    sequential = (sequential + hop) % maxSource;
    for (let i = 0; i < grainLength; i++) {
      const outputIndex = out + i;
      if (outputIndex < 0 || outputIndex >= outputLength) continue;
      const window = Math.sin(Math.PI * i / Math.max(1, grainLength - 1));
      const w = window * window;
      weight[outputIndex] += w;
      for (let channel = 0; channel < channels.length; channel++) channels[channel][outputIndex] += segment.channels[channel][source + i] * w;
    }
  }
  let outputEnergy = 0;
  for (let i = 0; i < outputLength; i++) {
    const normalization = weight[i] > 1e-5 ? 1 / weight[i] : 0;
    for (const channel of channels) {
      channel[i] *= normalization;
      outputEnergy += channel[i] * channel[i];
    }
  }
  const outputRms = Math.sqrt(outputEnergy / Math.max(1, outputLength * channels.length));
  const gain = Math.min(3, analysis.rms / Math.max(1e-6, outputRms));
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = Math.max(-1, Math.min(1, channel[i] * gain));
  return { sampleRate, channels };
}
