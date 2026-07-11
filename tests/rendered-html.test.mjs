import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
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
  assert.match(html, /HANDLE/);
  assert.match(html, /ECC83/);
  assert.match(html, /ENGAGE SESSION/);
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
  assert.match(page, /AutomationGraph/);
  assert.match(page, /requestAnimationFrame/);
  assert.doesNotMatch(page, />WRITE</);
  assert.match(layout, /summary_large_image/);
  assert.match(packageJson, /nocturne-psychoacoustic-console/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.equal(card, undefined);
});
