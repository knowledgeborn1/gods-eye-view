import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RAINVIEWER_TILE_PROXY_BASE,
  frameLabel,
  frameTileTemplate,
  isRainviewerFramePath,
  normalizeWeatherMaps,
  parseTileRequest,
  selectPastWindow,
  toProxiedSnapshot,
} from './rainviewerFrames.js';

/** A feed payload shaped exactly like the live one (probed 2026-09-19). */
function feed({ past, nowcast = [], infrared = [] } = {}) {
  return {
    version: '2.0',
    generated: 1789882822,
    host: 'https://tilecache.rainviewer.com',
    radar: { past, nowcast },
    satellite: { infrared },
  };
}

const PAST = [
  { time: 1789875600, path: '/v2/radar/440ea8218834' },
  { time: 1789876200, path: '/v2/radar/550ea8218835' },
  { time: 1789882800, path: '/v2/radar/16b64688839f' },
];

test('a well-formed feed normalizes to sorted, de-duplicated frames', () => {
  const snapshot = normalizeWeatherMaps(feed({
    // Deliberately out of order with a repeat, which is what a sorted
    // consumer must not have to care about.
    past: [PAST[2], PAST[0], PAST[1], PAST[0]],
    infrared: [{ time: 1789882800, path: '/v2/satellite/abc123def456' }],
  }));
  assert.deepEqual(snapshot.radarPast, PAST);
  assert.equal(snapshot.generated, 1789882822);
  assert.equal(snapshot.host, 'https://tilecache.rainviewer.com');
  assert.deepEqual(snapshot.infrared, [{ time: 1789882800, path: '/v2/satellite/abc123def456' }]);
});

test('empty nowcast and infrared are normal, not failure', () => {
  // The live public feed ships both as [] most of the time; treating that as
  // a broken payload would take the whole radar layer down with it.
  const snapshot = normalizeWeatherMaps(feed({ past: PAST }));
  assert.deepEqual(snapshot.radarNowcast, []);
  assert.deepEqual(snapshot.infrared, []);
  assert.equal(snapshot.radarPast.length, 3);
});

test('a payload with no usable radar history is rejected outright', () => {
  // null is the signal to KEEP the previous cached snapshot, so each of these
  // must not come back as an empty-but-valid one.
  for (const payload of [
    null,
    'not an object',
    [],
    feed({ past: [] }),
    feed({ past: [{ time: 0, path: '/v2/radar/440ea8218834' }] }),
    feed({ past: [{ time: 1789875600, path: '/v2/radar/NOT-HEX' }] }),
    { radar: { past: PAST[0] } },
  ]) {
    assert.equal(normalizeWeatherMaps(payload), null, `should reject: ${JSON.stringify(payload)}`);
  }
});

test('individually malformed frames are dropped without losing the good ones', () => {
  const snapshot = normalizeWeatherMaps(feed({
    past: [PAST[0], { time: 'soon', path: PAST[1].path }, { time: 1789876800 }, PAST[2]],
  }));
  assert.deepEqual(snapshot.radarPast, [PAST[0], PAST[2]]);
});

test('frame paths outside the documented grammar are refused', () => {
  assert.ok(isRainviewerFramePath('/v2/radar/440ea8218834'));
  assert.ok(isRainviewerFramePath('/v2/satellite/abc123'));
  for (const hostile of [
    '/v2/radar/../../etc/passwd',
    '//evil.example.com/v2/radar/440ea8218834',
    '/v2/radar/440ea8218834/../../..',
    '/v3/radar/440ea8218834',
    '/v2/other/440ea8218834',
    '/v2/radar/ZZZZZZ',
    '/v2/radar/',
    'v2/radar/440ea8218834',
    '/v2/radar/440ea8218834?x=1',
    123,
    null,
  ]) {
    assert.equal(isRainviewerFramePath(hostile), false, `should refuse: ${String(hostile)}`);
  }
});

test('the proxied snapshot swaps the upstream host for the same-origin mount', () => {
  // The browser must never learn (or reach) the upstream tile host: one place
  // fetches RainViewer, one place caches it, one place to audit.
  const proxied = toProxiedSnapshot(normalizeWeatherMaps(feed({ past: PAST })));
  assert.equal(proxied.host, RAINVIEWER_TILE_PROXY_BASE);
  assert.deepEqual(proxied.radar.past, PAST);
  assert.deepEqual(proxied.satellite.infrared, []);
  assert.equal(JSON.stringify(proxied).includes('tilecache.rainviewer.com'), false);
});

test('the tile template pins the owner-specified rendering options', () => {
  // Color scheme 2, smooth 1, snow 1 — and Cesium's own {z}/{x}/{y} left intact.
  assert.equal(
    frameTileTemplate(RAINVIEWER_TILE_PROXY_BASE, '/v2/radar/440ea8218834'),
    '/api/rainviewer/tiles/v2/radar/440ea8218834/256/{z}/{x}/{y}/2/1_1.png',
  );
});

test('the past window is clamped by time, not by frame count', () => {
  // Upstream owns the cadence and the frame count; the scrubber advertises two
  // hours, so it must slice by timestamp or the label becomes a lie.
  const newest = 1789882800;
  const frames = [
    { time: newest - 200 * 60, path: '/v2/radar/aaaaaaaaaaaa' },
    { time: newest - 121 * 60, path: '/v2/radar/bbbbbbbbbbbb' },
    { time: newest - 120 * 60, path: '/v2/radar/cccccccccccc' },
    { time: newest - 10 * 60, path: '/v2/radar/dddddddddddd' },
    { time: newest, path: '/v2/radar/eeeeeeeeeeee' },
  ];
  assert.deepEqual(
    selectPastWindow(frames).map((frame) => frame.time),
    [newest - 120 * 60, newest - 10 * 60, newest],
  );
  assert.deepEqual(selectPastWindow(frames, { windowMinutes: 20 }).map((f) => f.time),
    [newest - 10 * 60, newest]);
  assert.deepEqual(selectPastWindow([]), []);
});

test('tile requests are rebuilt from validated numbers', () => {
  const parsed = parseTileRequest('/v2/radar/440ea8218834/256/7/64/42/2/1_1.png');
  assert.deepEqual(parsed, {
    path: '/v2/radar/440ea8218834',
    size: 256,
    z: 7,
    x: 64,
    y: 42,
    color: 2,
    smooth: 1,
    snow: 1,
    upstreamPath: '/v2/radar/440ea8218834/256/7/64/42/2/1_1.png',
  });
});

test('the tile endpoint refuses everything it did not build itself', () => {
  // The frame path comes from UPSTREAM, so this parser is the only thing
  // standing between the tile mount and a general-purpose request forwarder.
  for (const hostile of [
    '/v2/radar/440ea8218834/256/7/64/42/2/1_1.png/../../secret',
    '/../../../etc/passwd',
    '//evil.example.com/v2/radar/440ea8218834/256/7/64/42/2/1_1.png',
    '/v2/radar/440ea8218834/999/7/64/42/2/1_1.png', // unsupported tile size
    '/v2/radar/440ea8218834/256/13/64/42/2/1_1.png', // past the zoom cap
    '/v2/radar/440ea8218834/256/2/9/0/2/1_1.png', // x outside 2^z
    '/v2/radar/440ea8218834/256/2/0/9/2/1_1.png', // y outside 2^z
    '/v2/radar/440ea8218834/256/7/64/42/9/1_1.png', // no such color scheme
    '/v2/radar/440ea8218834/256/7/64/42/2/2_1.png', // smooth is a flag
    '/v2/radar/440ea8218834/256/7/64/42/2/1_1.jpg',
    '/v2/radar/440ea8218834/256/7/64/42/2/1_1.png?key=x',
    '',
    null,
  ]) {
    assert.equal(parseTileRequest(hostile), null, `should refuse: ${String(hostile)}`);
  }
});

test('frame labels read as clock-relative positions in the loop', () => {
  const now = 1789882800 * 1000;
  assert.equal(frameLabel(1789882800, now), 'NOW');
  // No "close enough to now" band: the newest frame is routinely a full
  // cadence step old, and the scrubber says LATEST for that rather than
  // having this claim the data is current when it is not.
  assert.equal(frameLabel(1789882800 - 9 * 60, now), '-9m');
  assert.equal(frameLabel(1789882800 - 10 * 60, now), '-10m');
  assert.equal(frameLabel(1789882800 - 40 * 60, now), '-40m');
  assert.equal(frameLabel(1789882800 - 60 * 60, now), '-1h');
  assert.equal(frameLabel(1789882800 - 120 * 60, now), '-2h');
  assert.equal(frameLabel(1789882800 - 95 * 60, now), '-1h35');
});
