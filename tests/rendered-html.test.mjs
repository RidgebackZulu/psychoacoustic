import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";

async function render() {
  const port = 32000 + Math.floor(Math.random() * 1000);
  const nextBin = new URL("../node_modules/next/dist/bin/next", import.meta.url);
  const server = spawn(process.execPath, [nextBin.pathname, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: new URL("..", import.meta.url),
    stdio: "pipe",
  });

  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        const body = await response.text();
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("Next.js production server did not become ready");
  } finally {
    server.kill("SIGTERM");
  }
}

test("server-renders the Nocturne research console", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Nocturne Laboratory/);
  assert.match(html, /Psychoacoustic Research Console/);
  assert.match(html, /Auditory Beat Engine/);
  assert.match(html, /Fourfold Layer Matrix/);
  assert.match(html, /Temporal Automation/);
  assert.match(html, /ADD CONTROL/);
  assert.match(html, /DRAG TO SHAPE/);
  assert.match(html, /SNAP/);
  assert.match(html, /ECC83/);
  assert.match(html, /Play session/);
  assert.match(html, /og:image/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});

test("ships the interactive audio engine and social card", async () => {
  const [page, layout, packageJson, card] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    access(new URL("../public/og.png", import.meta.url)),
  ]);
  assert.match(page, /new AudioContext/);
  assert.match(page, /createChannelMerger/);
  assert.match(page, /createDynamicsCompressor/);
  assert.match(page, /createAnalyser/);
  assert.match(page, /createWaveShaper/);
  assert.match(page, /beatMode === "isochronic"/);
  assert.match(page, /carriers\.left\.type = waveform/);
  assert.match(page, /sampleAutomation/);
  assert.match(page, /useState\(false\);\n  const \[drift/);
  assert.match(page, /AutomationGraph/);
  assert.match(page, /graph\.beatMode === mode/);
  assert.match(page, /<select value="" onChange=/);
  assert.match(page, /addEventListener\("wheel", handleWheel, \{ passive: false \}\)/);
  assert.doesNotMatch(page, /onWheel=/);
  assert.match(page, /nocturne-presets-/);
  assert.match(page, /Choose presets to import/);
  assert.match(page, /String\(suffix\)\.padStart\(3, "0"\)/);
  assert.match(page, /sessionOriginRef/);
  assert.match(page, /onSeek=\{seekSession\}/);
  assert.match(page, /requestAnimationFrame/);
  assert.doesNotMatch(page, />WRITE</);
  assert.match(layout, /summary_large_image/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(packageJson, /nocturne-psychoacoustic-console/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.equal(card, undefined);
  assert.match(page, /unlockAudioContext/);
  assert.match(page, /AudioContextConstructor\(\{ latencyHint: "interactive" \}\)/);
  assert.doesNotMatch(page, /new AudioContext\(\{ latencyHint: "interactive", sampleRate:/);
});
