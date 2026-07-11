# Real-Time Psychoacoustic Synthesis Engine

## Acoustic and DSP Technical Specification - v0.1

**Status:** architecture brief for prototyping  
**Scope:** sound-generation, mixing, measurement, safety, session data, and verification. The application interface, visual design, account system, distribution, and clinical claims are intentionally out of scope.

## 1. Product definition

Build a real-time, stereo-first synthesis engine for composing repeatable and continuously varying audio sessions intended to support focus, relaxation, sleep, meditation, and performance routines. The engine combines auditory-beat primitives, conventional synthesis, noise, recorded sound, modulation, spatial processing, and automation.

The engine is an **audio composition instrument**, not a medical device and not a brain-state controller. It must describe a preset as an *intended listening experience*, never as a guaranteed neurological outcome. Delta/theta/alpha/beta/gamma names are useful frequency-band labels, but selecting a beat in one of these ranges must not be represented as proof that the listener's EEG will enter that band.

This distinction follows the evidence summarized in the infographic. A 2023 systematic review found binaural-beat EEG entrainment results inconsistent: five included studies supported the hypothesis, eight contradicted it, and one was mixed; implementations and measurements were highly heterogeneous. That makes reproducibility and exact parameter logging first-class product requirements, not optional research features.

## 2. Design principles

1. **Exact underneath, organic on top.** Beat frequency, phase, routing, and timing are exact and inspectable; musical variation may be stochastic but bounded and reproducible.
2. **Stereo integrity is explicit.** A true binaural configuration requires separate signals at the two ears. The engine must know whether content is headphone-required, speaker-compatible, or mono-safe.
3. **No hidden recipes.** Every audible result must serialize to a versioned session document, including random seeds and generator versions.
4. **No unsafe gain surprises.** Adding a layer must not silently increase output level. Headroom, true-peak limiting, loudness measurement, and exposure estimates are built into the signal path.
5. **Claims follow evidence.** Frequency-band vocabulary is descriptive. Outcome labels and commercial copy are a separate, reviewable metadata layer.
6. **Real-time safe.** No memory allocation, locks, file I/O, network I/O, logging, or garbage collection on the audio render thread.

## 3. Evidence-informed acoustic boundaries

### 3.1 Binaural beats

For center carrier frequency `fc` and signed beat frequency `fb`, the preferred symmetric construction is:

```text
fL = fc - fb / 2
fR = fc + fb / 2
xL(t) = AL(t) * oscillator(phaseL(t))
xR(t) = AR(t) * oscillator(phaseR(t))
```

The perceived beat magnitude is `abs(fR - fL)`. Symmetric construction holds the spectral center stable while the beat changes. An anchored construction (`fL = fc`, `fR = fc + fb`) may be offered for experimental reproduction but must be labeled because it changes perceived pitch when `fb` changes.

Validated authoring range for a conventional binaural-beat node:

| Parameter | Default | Normal authoring range | Absolute engine range | Notes |
|---|---:|---:|---:|---|
| Center carrier `fc` | 400 Hz | 100-600 Hz | 40-1,000 Hz | Literature reports best perception near 400 Hz; perception weakens at high carriers. |
| Beat `fb` | 10 Hz | 0.5-30 Hz | 0.1-40 Hz | Above roughly 30 Hz, two pitches/roughness may replace the classic beat percept. Values over 30 Hz are experimental. |
| Per-ear level trim | 0 dB | -12 to +3 dB | -60 to +6 dB | Final safety ceiling still applies. |
| Interaural phase offset | 0 degrees | -180 to +180 degrees | unbounded/normalized | Preserve continuous phase during automation. |
| On/off ramp | 2 s | 0.25-10 s | >= 20 ms | Avoid clicks and abrupt startling transitions. |

These ranges are perceptual design bounds, not treatment doses. The review literature describes approximate and listener-dependent boundaries: carriers no higher than about 1 kHz, strongest perception around 400 Hz, and interaural differences around 30 Hz or less. The engine may reproduce research stimuli outside the normal range, but the preset schema must flag them `experimental: true`.

**Headphone rule:** the two carriers must remain isolated until the output transducers for binaural mode. Do not add a binaural generator before a mono reverb, crossfeed stage, stereo widener that mixes channels, or master mono fold-down. Any shared ambience should be generated on a parallel bus.

### 3.2 Monaural/acoustic beats

Monaural beats physically mix two frequencies in each output channel:

```text
x(t) = A(t) * [sin(2*pi*f1*t + p1) + sin(2*pi*f2*t + p2)] / 2
fb = abs(f2 - f1)
```

They are speaker-compatible and survive mono playback. Their audible amplitude fluctuation is not the same mechanism as a binaural illusion. The generator must allow identical, partially decorrelated, or spatialized copies after the two tones have been summed.

### 3.3 Isochronic and explicit amplitude modulation

An amplitude-modulated carrier uses:

```text
m(t) = (1 - depth) + depth * shape(phaseMod(t))
x(t) = gainCompensation(depth, shape) * m(t) * carrier(t)
```

Required modulation shapes: sine, triangle, raised cosine, trapezoid, pulse with adjustable duty cycle, and user curve. A literal square gate is not permitted without band-limiting and edge smoothing. Minimum attack/release on a pulse is 2 ms; the content authoring default is 10-30 ms.

Depth is `0..1`. Gain compensation must be based on measured RMS, not peak, and capped so increasing depth cannot create a large loudness jump. The node must expose both nominal modulation frequency and measured envelope frequency.

### 3.4 Frequency-band labels

The following labels are defaults for organization only and must be editable/versioned:

| Label | Nominal beat-frequency range |
|---|---:|
| Delta | 0.5-4 Hz |
| Theta | 4-8 Hz |
| Alpha | 8-13 Hz |
| Beta | 13-30 Hz |
| Gamma/experimental | >30 Hz |

Boundary values do not have universal meanings, and a label must never constrain the underlying numeric value. All automation stores hertz, not only a band name.

## 4. Engine signal flow

```text
Session clock + seeded variation
        |
        +--> modulation/control graph --------------------------+
        |                                                       |
Sources --> per-voice envelope --> voice FX --> stereo policy --+--> group buses
                                                                   |-- Beat bus
                                                                   |-- Tonal bus
                                                                   |-- Texture bus
                                                                   |-- Nature/sample bus
                                                                   |-- Voice/guidance bus
                                                                        |
                                                           bus EQ/dynamics/space
                                                                        |
                                                           master headroom mixer
                                                                        |
                                                           safety high-pass (DC)
                                                                        |
                                                           true-peak limiter
                                                                        |
                                               loudness/peak/exposure analysis tap
                                                                        |
                                                              stereo device output
```

The limiter is protection against digital overload, not a creative loudness tool. Creative compression/saturation belongs upstream. Meters read both pre-limiter and post-limiter signals so an author can see when the limiter is masking a bad mix.

### 4.1 Channel formats

- Internal canonical format: stereo `L/R`, 32-bit floating point.
- Timing and oscillator phase accumulators: 64-bit floating point or fixed-point with equivalent long-run precision.
- Optional internal mono buses are permitted; conversion points must be explicit.
- Future spatial backends may use ambisonics or object audio, but v1 output remains stereo.
- Binaural generator channels carry semantic tags `ear:left` and `ear:right`; graph compilation must reject channel-merging effects inside the protected path.

## 5. Source modules

### 5.1 Precision beat oscillator

Required waveforms: sine, triangle, band-limited saw, band-limited square, wavetable, and user harmonic spectrum. Sine is the scientific/reference default. Each oscillator provides:

- continuous phase accumulator;
- phase-reset mode and free-running mode;
- frequency automation without phase reset;
- per-channel gain and polarity;
- optional bounded drift in cents and hertz;
- harmonic distortion control with an alias-safe ceiling;
- reference output that bypasses effects for measurement.

Changing carrier or beat frequency must be click-free and phase-continuous. A request to jump phase is a separate explicit event with an enforced micro-ramp.

### 5.2 Additive/harmonic voice

- Up to 64 partials per voice.
- Per-partial ratio or absolute frequency, amplitude, phase, stereo position, and decay.
- Odd/even tilt, spectral centroid, inharmonicity, and harmonic stretch macros.
- Normalize by summed energy, not the number of active partials.
- Cull partials above `0.45 * sampleRate` before synthesis.

### 5.3 FM/PM voice

- At least four operators with selectable algorithms.
- Frequency specified as ratio or hertz.
- Audio-rate phase modulation is preferred internally because its spectral behavior is easier to bound than naive frequency modulation.
- Oversample nonlinear or high-index configurations 2x/4x as required; downsample with a documented low-pass filter.
- Graph validator estimates maximum sideband spread and warns when a patch will alias.

### 5.4 Wavetable and sample/granular voice

- Mipmapped/band-limited wavetable selection by fundamental frequency.
- Sample playback with high-quality resampling, looping crossfades, reverse, and time-stretch independent of pitch.
- Granular controls: 5-500 ms grain length, 0-100 grains/s per voice, position spread, pitch spread, stereo spread, envelope shape, and deterministic seed.
- Stream long ambience from a non-real-time reader into lock-free ring buffers; an underrun fades to silence and emits telemetry off-thread.
- Sample metadata includes source/license, native sample rate, loop points, loudness, true peak, checksum, and preprocessing history.

### 5.5 Noise and procedural texture

Required noise colors: white, pink, brown/red, blue, violet, and custom spectral tilt. Pink/brown algorithms must be statistically tested; a single low-order filter marketed as exact pink noise is not sufficient.

Additional procedural modules:

- filtered noise bank;
- rain/wind/water-style sparse event generator;
- resonator/modal bank;
- filtered impulse train;
- crackle/dust with event-rate limiting;
- spectral freeze and slow convolution texture.

All stochastic modules use splittable, seeded pseudo-random streams. Adding an unrelated layer must not change the random sequence of existing layers.

## 6. Modulation and variation system

### 6.1 Modulation sources

- LFO: 0.001-100 Hz, with tempo-sync option;
- multi-stage envelope and breakpoint curve;
- random sample-and-hold, smoothed random, Brownian walk, and bounded Ornstein-Uhlenbeck-style drift;
- step sequencer;
- envelope follower from any non-protected bus;
- session-time macro and scene-progress value;
- external control input, timestamped and rate-limited.

### 6.2 Routing semantics

Every modulation route declares source, destination, unit, polarity, depth, transform curve, smoothing, and clamp. Units are never inferred. For example, a route is `LFO -> carrierFrequency, semitones +/-0.25`, not an untyped multiplier.

Parameter classes:

- **sample-rate:** oscillator phase/frequency, gain, pan, filter cutoff when audibly modulated;
- **control-rate:** slow texture and scene parameters, normally 100-250 Hz with interpolation;
- **event-rate:** preset and topology changes.

Feedback in the control graph is disabled by default. If enabled for an expert patch, it requires a one-block delay, bounded output, and cycle detection.

### 6.3 Constrained variation

A variation recipe specifies a distribution plus acoustic constraints:

```json
{
  "parameter": "layers.beatA.beatHz",
  "distribution": { "type": "normal", "mean": 10.0, "sd": 0.35 },
  "clamp": [8.5, 11.5],
  "maxSlopePerSecond": 0.05,
  "quantize": 0.01,
  "seedStream": "beatA-session-drift"
}
```

The variation engine must support:

- a stable seed for exact replay;
- a session seed for a fresh but reconstructable performance;
- correlated variation groups so layers move musically together;
- exclusion rules to prevent simultaneous high-density events;
- energy-aware rules that retain headroom as layers accumulate;
- freeze/unfreeze and capture-current-state;
- mutation strength with a before/after diff.

Randomization may never alter the master safety ceiling, calibration state, exposure mode, or claim/evidence metadata.

## 7. Automation, scenes, and real-time control

### 7.1 Session clock

- One monotonic 64-bit sample clock is the source of truth.
- Musical time is a projection of sample time; tempo changes cannot move already-rendered events.
- Automation events are scheduled in samples and rendered with sample accuracy.
- UI/network controller timestamps are converted to render time with a jitter buffer; late events use a documented catch-up policy.
- Pause has two modes: `freeze` (all phases stop) and `continueSilent` (clock/phase continue while gain ramps down).

### 7.2 Curves

Support step, linear, exponential, S-curve, cubic Bezier, and hold-then-ramp. Exponential curves cannot cross zero. Curves have defined collision semantics: replace, append, blend, or cancel-and-hold.

Default smoothing:

| Parameter | Default smoothing |
|---|---:|
| gain/mute | 20 ms equal-power or linear amplitude ramp |
| frequency | 20-100 ms, phase-continuous |
| filter cutoff/Q | 20 ms minimum unless intentionally audio-rate |
| pan/spatial position | 50 ms |
| master start/stop | 2 s content default; 100 ms emergency stop |

### 7.3 Scene model

A session contains scenes such as arrival, transition, sustained section, and exit. These are compositional terms, not physiological stages. A scene defines duration or exit condition, active layers, parameter snapshots, transition curves, and allowed variation. A transition pre-rolls new streaming assets and crossfades buses; it never tears down the active graph on the render thread.

## 8. Effects and spatial processing

Required v1 processors:

- biquad and state-variable filters;
- parametric EQ with spectrum analyzer;
- delay, multi-tap delay, chorus, and all-pass diffusion;
- algorithmic reverb plus partitioned-convolution reverb;
- compressor/expander, sidechain ducking, soft clipper, and true-peak limiter;
- stereo balance, equal-power pan, mid/side width, and optional headphone crossfeed;
- transient-safe fade and de-click processor.

Rules:

1. Effects declare latency; the graph performs automatic delay compensation.
2. Reverb/delay tails are preserved across scene transitions.
3. Binaural protected paths prohibit crossfeed, M/S manipulation, mono effects, and channel-coupled modulation before the perceptual signal reaches the master summing point.
4. Spatial motion intended for sleep/relaxation defaults to low angular velocity and no sudden lateral jump.
5. Convolution runs in partitions off the smallest render block; IR changes crossfade.

## 9. Mixing, loudness, and hearing-safety controls

### 9.1 Digital output targets

- Master true peak: **never above -1 dBTP** in normal output.
- Factory session target: **-23 LUFS integrated** as a conservative authoring anchor; content may intentionally be quieter.
- Factory-session ceiling: **-18 LUFS integrated** unless reviewed for a specific distribution context.
- Maximum limiter gain reduction in a shippable factory preset: 3 dB momentary and 1 dB sustained; otherwise remix.
- DC blocker/high-pass: approximately 15-20 Hz, chosen to remove offset without audibly thinning ordinary content.
- Metering: sample peak, 4x-or-better oversampled true peak, RMS, momentary/short-term/integrated loudness, loudness range, per-bus crest factor, and stereo correlation.

LUFS/dBTP control prevents inconsistent digital masters and inter-sample clipping. It **does not establish dBA SPL at the ear**. Digital full scale maps to a different acoustic level for every DAC, volume setting, amplifier, headphone sensitivity, fit, and seal.

### 9.2 Calibration confidence

Exposure UI and APIs return one of three states:

| Grade | Basis | Permitted claim |
|---|---|---|
| A - calibrated | Known device gain plus headphone sensitivity, or OS/HATS-derived ear-level estimate | Quantified estimated dBA SPL and weekly allowance, with uncertainty. |
| B - system estimate | Trusted platform headphone-exposure API but incomplete transducer/fit information | Platform-estimated exposure, clearly attributed. |
| C - unknown | Only digital samples/dBFS are known | No SPL or safe-time claim; show digital level and request lower device volume. |

Calibration and dose estimation occur as late as possible in the signal chain and include every available volume control, matching ITU-T H.870's architecture principle.

### 9.3 Weekly sound allowance

When and only when a credible A-weighted acoustic estimate exists, implement a rolling seven-day energy accumulator. The H.870 adult reference exposure is `1.6 Pa^2 h`, corresponding to 80 dBA for 40 hours. The more conservative mode is `0.51 Pa^2 h`, corresponding to 75 dBA for 40 hours.

For a constant equivalent level, an implementation check using the 3 dB exchange rule is:

```text
allowedHours(L) = 40 * 2^((reference_dBA - L) / 3)
sessionDose = sessionHours / allowedHours(L)
```

Production accumulation should integrate A-weighted energy over time rather than repeatedly applying the shortcut. Persist uncertainty, source, timestamp, and calibration changes with dose records. Explain that the estimate excludes exposure from other devices and environmental sound unless the operating system supplies it.

At warning thresholds the engine emits events; the application later decides presentation:

- 50%: informational;
- 80%: recommend reducing level or duration;
- 100%: default automatic attenuation to the selected reference level, with an explicit user override and audit event.

### 9.4 Acoustic comfort safeguards

- No factory preset begins with an un-ramped pure tone.
- Sudden level increase is limited to 3 dB per second unless an authored transient is explicitly reviewed.
- Soloing a quiet layer must retain a safe monitor gain; it may not bypass the master limiter.
- Prevent feedback paths from input/microphone to output by default.
- Detect sustained ultrasonic/near-Nyquist energy and DC/sub-audible overload.
- Factory content must be auditioned for tonal fatigue, roughness, tinnitus aggravation, and motion discomfort at several playback levels.
- User-facing guidance must say to stop if sound causes discomfort, pain, dizziness, or ringing, and not to use sleep/drowsiness sessions while driving or operating machinery.

## 10. Runtime performance requirements

Reference target: modern mobile device, stereo, 48 kHz.

| Requirement | v1 target |
|---|---:|
| Sample rates | 44.1, 48, 88.2, 96 kHz; 48 kHz default |
| Render quantum | <=128 frames preferred; backend-native adapter allowed |
| Numeric audio format | float32 |
| Simultaneous precision oscillators | 64 stereo pairs minimum |
| Simultaneous sample streams | 12 stereo streams minimum |
| Granular budget | 400 concurrent grains minimum on reference hardware |
| Interactive control-to-audio response | <20 ms excluding hardware output latency |
| CPU budget | <=40% average, <=70% 99th percentile for factory maximum-density session |
| Audio deadline misses | 0 in a 12-hour soak test |
| Memory growth | 0 steady-state growth after assets/graph are warm |

Quality degradation, if needed, follows a fixed policy: reduce analyzer refresh, reverb tail density, oversampling on noncritical creative effects, and granular density. Never degrade beat-frequency accuracy, scheduling, master limiting, or exposure measurement.

## 11. Session and preset document

Use a human-readable, versioned JSON document plus separately checksummed assets. Minimum top-level form:

```json
{
  "schemaVersion": "1.0.0",
  "engineVersion": "0.1.0",
  "id": "session_uuid",
  "title": "Example - Quiet Focus",
  "intent": ["focus", "low-distraction"],
  "claimsClass": "wellness-experience",
  "evidence": {
    "status": "mixed",
    "notes": "Frequency labels are compositional; entrainment is not guaranteed."
  },
  "render": { "sampleRate": 48000, "channels": 2, "seed": "hex-256" },
  "playbackPolicy": { "headphones": "required", "mono": "fallback-scene" },
  "scenes": [],
  "layers": [],
  "buses": [],
  "modulationRoutes": [],
  "automation": [],
  "master": {},
  "assets": [],
  "provenance": {},
  "validation": {}
}
```

Each layer stores generator type/version, complete parameters, channel semantics, gain staging, modulation routes, seed stream, automation, asset references, and author notes. Units are written into schema field definitions and API types. Unknown fields survive a read/write round trip for forward compatibility.

### 11.1 Playback capability negotiation

Before rendering, the host reports sample rate, block size, output channels, mono/stereo route, headphone confidence, exposure API availability, and compute tier. The compiled session returns one of:

- `full`: intended protected stereo path available;
- `fallback`: substitute monaural/isochronic layer or alternate scene;
- `blocked`: playback cannot preserve required semantics.

Bluetooth codecs may alter latency and frequency response but ordinarily retain channel separation. Route changes during playback trigger a short master fade, graph revalidation, and explicit fallback decision.

## 12. Observability and research reproducibility

The engine can export a compact render manifest containing:

- exact engine, generator, and schema versions;
- sample rate, block size, device route class, and channel mapping;
- all session parameters and automation;
- PRNG algorithm, root seed, and stream identifiers;
- measured post-render integrated LUFS, true peak, spectral summary, and duration;
- calibrated/estimated exposure data and its confidence grade;
- asset checksums and license/source metadata;
- underruns, limiter activity, NaN guards, graph fallbacks, and late control events.

Telemetry is opt-in and must not include health inference. A research export may additionally log the actual rendered WAV/FLAC checksum and experimental condition identifier. Never reconstruct a stimulus from a marketing preset name alone.

## 13. Verification and acceptance tests

### 13.1 Unit and property tests

- Binaural invariant: `abs(fR - fL) == requestedBeat` within numerical tolerance across automation.
- Symmetric invariant: `(fL + fR) / 2 == requestedCenter`.
- Phase remains continuous under frequency ramps unless reset is explicitly scheduled.
- Event and curve endpoints land on the requested sample.
- Same document + engine version + assets + seed produces the same event stream and equivalent rendered samples.
- No graph can merge channels within a protected binaural path.
- Stochastic output never exceeds declared parameter clamps or slew rates.
- No output contains NaN, infinity, denormal storms, or unintended DC.

### 13.2 DSP conformance

| Test | Acceptance criterion |
|---|---|
| Oscillator frequency | <=0.01 Hz error over a 60-minute 400 Hz reference render |
| Beat difference | <=0.001 Hz steady-state error for 0.5-30 Hz test set |
| Protected-path channel leakage | below -100 dBFS in a digital impulse/FFT test |
| Automation timing | <=1 sample error |
| True peak | <=-1 dBTP on all factory renders and stress vectors |
| Aliasing | no unplanned component above -90 dBFS for reference band-limited oscillator tests |
| Silence transition | no click exceeding the authored envelope or master slew bound |
| Loop seam | residual discontinuity below -80 dBFS after loop crossfade |
| Long-run clock | no skipped/repeated sample and no scene drift in 12-hour render |

### 13.3 Perceptual and route tests

- Headphones: verify correct left/right orientation and channel isolation.
- Mono fold-down: expected outcome is declared for every preset; a binaural-only preset invokes fallback rather than silently changing mechanism.
- Speakers: speaker-compatible presets remain balanced and do not rely on ear isolation.
- Common devices: wired headphones, Bluetooth headphones/earbuds, phone speaker, laptop speaker, and route switch during playback.
- Hearing diversity review: test with listeners who report normal hearing plus voluntary review for sensitivity/tinnitus comfort; never ask participants to endure discomfort.
- ABX or blinded evaluation is used when claiming one algorithm sounds cleaner or a variation is less fatiguing.

### 13.4 Factory-preset release gate

A preset ships only when it has:

1. schema validation and no experimental parameter without a visible flag;
2. automated offline render analysis at all transitions and at least three seeds;
3. true-peak, loudness, DC, alias, and mono/fallback pass;
4. route/headphone policy;
5. evidence/claims classification reviewed;
6. asset provenance and license clearance;
7. human audition notes and reviewer identity/date;
8. reproducible render manifest.

## 14. Recommended implementation sequence

### Milestone A - reference renderer

Build an offline command-line renderer first: session schema, sine-based binaural/monaural/AM nodes, sample clock, automation curves, stereo WAV output, loudness/true-peak analysis, deterministic seeds, and golden-vector tests. This becomes the correctness oracle for every real-time backend.

### Milestone B - real-time core

Add lock-free graph snapshots, device adapter, protected stereo paths, meters, limiter, asset streaming, and route capability negotiation. Prove 12-hour stability before complex synthesis.

### Milestone C - synthesis and texture

Add noise colors, additive voice, band-limited wavetable, FM/PM, granular playback, effects buses, convolution, and constrained variation. Each module must pass offline-versus-real-time null/equivalence tests where applicable.

### Milestone D - calibration and safe listening

Integrate platform exposure data, calibration confidence, rolling seven-day energy accounting, and automatic attenuation events. Keep this subsystem separate from LUFS normalization.

### Milestone E - authoring API

Expose scene compilation, parameter inspection, mutation/diff, freeze/capture, research manifest, and factory-preset validator. The later application should be a client of this stable API rather than embedding DSP rules in UI code.

## 15. Decisions to preserve for the app-design stage

- Whether the first runtime is native C++/Rust, Apple AVAudioEngine, JUCE, Web Audio/AudioWorklet, or a hybrid. The acoustic contract above is backend-independent.
- Which operating systems provide credible headphone exposure estimates and how their permissions are presented.
- Whether user-imported samples are allowed and what content/licensing scanner they require.
- Whether an expert mode can bypass normal authoring ranges; it must never bypass the master ceiling or falsify calibration confidence.
- Which wellness wording is legally and clinically reviewed in launch markets.

## 16. Sources and standards

1. Ingendoh RM, Posny ES, Heine A. [Binaural beats to entrain the brain? A systematic review](https://pmc.ncbi.nlm.nih.gov/articles/PMC10198548/). *PLOS ONE*. 2023. This is the main basis for perceptual limits, implementation heterogeneity, and the evidence caveat.
2. Garcia-Argibay M, Santed MA, Reales JM. [Efficacy of binaural auditory beats in cognition, anxiety, and pain perception: a meta-analysis](https://pubmed.ncbi.nlm.nih.gov/30073406/). *Psychological Research*. 2019. This provides a more favorable outcome synthesis and reinforces that frequency, timing, and exposure protocol matter; it should be read alongside the later EEG review.
3. World Health Organization. [Safe listening devices and systems: a WHO-ITU standard](https://www.who.int/publications/i/item/9789241515276). 2019. Basis for sound allowance, dose tracking, automatic reduction, and communication requirements.
4. International Telecommunication Union. [ITU-T H.870 v2: Guidelines for safe listening devices/systems](https://www.itu.int/epublications/publication/itu-t-h-870-v2-2022-03-guidelines-for-safe-listening-devices-systems). 2022. Basis for calibrated exposure architecture, reference energy, and late-chain dose estimation.
5. International Telecommunication Union. [ITU-R BS.1770-5: Algorithms to measure audio programme loudness and true-peak audio level](https://www.itu.int/rec/R-REC-BS.1770/). 2023. Basis for LUFS and true-peak measurement.
6. European Broadcasting Union. [EBU R 128: Loudness normalisation and permitted maximum level](https://tech.ebu.ch/publications/r128). Basis for the -23 LUFS authoring anchor and -1 dBTP ceiling; these are digital-program targets, not hearing-exposure limits.
7. ISO. [ISO 226:2023: Normal equal-loudness-level contours](https://www.iso.org/standard/83117.html). Basis for acknowledging frequency-dependent human sensitivity; its free-field pure-tone conditions must not be mistaken for headphone calibration.

## 17. Bottom line

The differentiating technology should not be a library of named “brain frequencies.” It should be a precise, inspectable stereo DSP engine that can hold a perceptual relationship stable while everything around it evolves: timbre, texture, spatial field, density, harmony, and narrative time. Its scientific credibility comes from exact stimulus reconstruction, honest uncertainty, calibrated safety when possible, and refusal to turn frequency-band associations into guaranteed outcomes.
