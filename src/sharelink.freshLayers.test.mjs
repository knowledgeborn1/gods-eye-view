import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  decodeLayerStateParams,
  encodeLayerStateParams,
  normalizeLayerState,
} from './data/layerState.js';
import { CREDENTIALS, buildCapabilitySummary, formatSetupReport } from '../scripts/setup-doctor.mjs';

/**
 * Share-link + registry coverage for the radar layer, the two fresh-imagery
 * basemaps and the day/night controls. Every one of them is a toggle the user
 * can set, so every one of them has to survive a copied link.
 */

function makeManager(hash = '') {
  globalThis.window = { location: { hash, href: `http://localhost/${hash}` } };
  globalThis.history = {
    replaceState(_state, _title, nextHash) { window.location.hash = nextHash; },
  };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

/** The hash a manager would currently write, as URLSearchParams. */
function writtenParams(manager) {
  return new URLSearchParams(manager._buildHashParams().toString());
}

// ── Day/night ───────────────────────────────────────────────────────────────

test('a fresh link says the sun is off and carries no offset noise', () => {
  const params = writtenParams(makeManager());
  assert.equal(params.get('sun'), '0');
  assert.equal(params.has('sut'), false, 'a zero offset must not be written');
  assert.equal(params.has('sul'), false, 'the default city-lights state must not be written');
  assert.equal(params.has('vd'), false, 'the rolling default day must not be pinned');
});

test('the sun toggle, its offset and its city lights all round-trip', () => {
  const manager = makeManager();
  manager.onToggleChange(false, false, {
    sunEnabled: true,
    sunOffsetMinutes: -480,
    sunCityLights: false,
  });
  const params = writtenParams(manager);
  assert.equal(params.get('sun'), '1');
  assert.equal(params.get('sut'), '-480');
  assert.equal(params.get('sul'), '0');

  const restored = makeManager(`#v=2&lat=10&lon=20&${params.toString()}`).parseInitialHash();
  assert.equal(restored.sunEnabled, true);
  assert.equal(restored.sunOffsetMinutes, -480);
  assert.equal(restored.sunCityLights, false);
});

test('an absent sun field means the shipped default, not undefined', () => {
  const restored = makeManager('#lat=10&lon=20').parseInitialHash();
  assert.equal(restored.sunEnabled, false);
  assert.equal(restored.sunOffsetMinutes, 0);
  assert.equal(restored.sunCityLights, true, 'lights ship on; absent must not read as off');
  assert.equal(restored.gibsDate, null);
});

test('a hand-edited offset cannot park the app clock outside the supported window', () => {
  for (const [hash, expected] of [
    ['#lat=10&lon=20&sut=99999', 720],
    ['#lat=10&lon=20&sut=-99999', -720],
    ['#lat=10&lon=20&sut=nonsense', 0],
    ['#lat=10&lon=20&sut=', 0],
  ]) {
    assert.equal(makeManager(hash).parseInitialHash().sunOffsetMinutes, expected, hash);
  }
});

// ── Fresh imagery ───────────────────────────────────────────────────────────

test('both new basemaps ride the existing map field', () => {
  for (const stack of ['eox-s2cloudless', 'gibs-viirs']) {
    const manager = makeManager();
    manager.onToggleChange(false, false, { mapStack: stack });
    assert.equal(writtenParams(manager).get('map'), stack);
    assert.equal(makeManager(`#lat=1&lon=2&map=${stack}`).parseInitialHash().mapStack, stack);
  }
});

test('a pinned VIIRS day travels, and clearing it returns to the rolling default', () => {
  // Absent `vd` deliberately means "the most recent complete day", so a link
  // opened next week shows that week's imagery instead of a frozen archive.
  const manager = makeManager();
  manager.onToggleChange(false, false, { mapStack: 'gibs-viirs', gibsDate: '2024-07-04' });
  assert.equal(writtenParams(manager).get('vd'), '2024-07-04');
  assert.equal(makeManager('#lat=1&lon=2&vd=2024-07-04').parseInitialHash().gibsDate, '2024-07-04');

  manager.onToggleChange(false, false, { gibsDate: null });
  assert.equal(writtenParams(manager).has('vd'), false);
});

// ── Radar layer (rides the v2 layer codec) ──────────────────────────────────

test('the radar layer is registered with a unique token and its own options', () => {
  const entry = LAYER_STATE_REGISTRY.find((row) => row.id === 'rainviewer-radar');
  assert.ok(entry, 'rainviewer-radar must be in the serialization registry');
  assert.equal(entry.disposition, 'enabled+options');
  assert.equal(entry.optionOwner, 'rainviewer-radar');
  assert.ok(REGISTERED_LAYER_IDS.includes('rainviewer-radar'));
  // Tokens are the URL alphabet; a collision would silently alias two layers.
  const tokens = LAYER_STATE_REGISTRY.map((row) => row.token);
  assert.equal(new Set(tokens).size, tokens.length);
});

test('radar play state and IR clouds survive a link; the frame deliberately does not', () => {
  const state = normalizeLayerState({
    enabledLayerIds: ['rainviewer-radar'],
    options: { 'rainviewer-radar': { playing: true, infrared: true } },
  });
  const params = new URLSearchParams();
  params.set('v', '2');
  encodeLayerStateParams(params, state);

  const decoded = decodeLayerStateParams(params);
  assert.deepEqual(decoded.enabledLayerIds, ['rainviewer-radar']);
  assert.equal(decoded.options['rainviewer-radar'].playing, true);
  assert.equal(decoded.options['rainviewer-radar'].infrared, true);

  // frameTime is a runtime param only: it names an absolute timestamp inside a
  // two-hour window, so by the time a link is opened that frame has aged out
  // of the feed. It must never reach the URL.
  assert.doesNotMatch(params.toString(), /frameTime/);
  assert.equal(Object.hasOwn(decoded.options['rainviewer-radar'], 'frameTime'), false);
});

test('radar defaults are off, paused and IR-free', () => {
  const defaults = createDefaultLayerState();
  assert.equal(defaults.enabledLayerIds.includes('rainviewer-radar'), false);
  assert.deepEqual(defaults.options['rainviewer-radar'], { playing: false, infrared: false });
  // Defaults are omitted from the hash, so an enabled-but-untouched radar
  // encodes as the bare token and contributes NOTHING to `lo`. (`lo` itself
  // is still present — `models3d` deliberately writes its default explicitly,
  // see absentTokenValue in layerState.js — so the claim is specifically that
  // no `3.*` assignment appears, not that the field is empty.) The token is
  // `3`, allocated 2026-10-11 from the upstream ledger after the rebase: `k`
  // went to upstream's wind layer and `v` to its NOAA MRMS weather-radar.
  const params = new URLSearchParams();
  encodeLayerStateParams(params, normalizeLayerState({ enabledLayerIds: ['rainviewer-radar'] }));
  assert.equal(params.get('l'), '3');
  const assignments = String(params.get('lo') || '').split('_').filter(Boolean);
  assert.deepEqual(assignments.filter((a) => a.startsWith('3.')), []);
});

// ── Setup doctor ────────────────────────────────────────────────────────────

test('the doctor reports the three keyless additions as already working', () => {
  // These have no credential to branch on, and that is the point: the report
  // must say they work on a fresh clone rather than leaving them unmentioned
  // and looking like another key the user still has to find.
  // Every credential the doctor knows, all unconfigured — read from the
  // doctor's own list so a credential added upstream cannot silently break
  // this fixture.
  const credentials = Object.fromEntries(
    CREDENTIALS.map((spec) => [spec.name, { configured: false }]),
  );
  const capabilities = buildCapabilitySummary(credentials);

  assert.match(capabilities.radar, /RainViewer/);
  assert.match(capabilities.radar, /keyless/);
  assert.match(capabilities.freshImagery, /Sentinel-2/);
  assert.match(capabilities.freshImagery, /VIIRS/);
  assert.match(capabilities.freshImagery, /keyless/);
  assert.match(capabilities.dayNight, /Black Marble/);
  assert.match(capabilities.dayNight, /keyless/);

  const report = formatSetupReport({
    ready: true,
    node: { version: '24.14.0', level: 'ok', summary: 'supported' },
    npm: { available: true, version: '11.0.0' },
    dependenciesInstalled: true,
    credentials,
    capabilities,
  });
  assert.match(report, /^Radar: {3}live RainViewer/m);
  assert.match(report, /^Imagery: Sentinel-2 cloudless/m);
  assert.match(report, /^Sun: {5}real-sun terminator/m);
  // A fully keyless clone is still READY — none of the three gates startup.
  assert.match(report, /Ready\. Run npm run dev/);
});
