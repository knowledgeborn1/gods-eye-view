import test from 'node:test';
import assert from 'node:assert/strict';
import { createRainviewerRadarLayer } from './rainviewerRadar.js';

/** Minimal viewer stand-in: the radar only ever touches imageryLayers. */
function fakeViewer() {
  const layers = [];
  return {
    imageryLayers: {
      add: (layer) => { layers.push(layer); },
      remove: (layer) => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      },
      raiseToTop: () => {},
      _layers: layers,
    },
  };
}

test('the layer declares the data-layer contract the manager and registry expect', () => {
  const layer = createRainviewerRadarLayer();
  assert.equal(layer.id, 'rainviewer-radar');
  assert.equal(layer.source, 'RainViewer');
  assert.ok(layer.name && layer.icon);
  // 10 minutes: the feed regenerates on that cadence and the proxy caches the
  // index for 5, so every refresh lands on genuinely new frames.
  assert.equal(layer.updateInterval, 600_000);
  for (const method of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats', 'setParams', 'getParams', 'getRowControls']) {
    assert.equal(typeof layer[method], 'function', `missing ${method}()`);
  }
  // Nothing sets showInTogglePanel, so the RADAR row appears in Data Layers.
  assert.equal(layer.showInTogglePanel, undefined);
});

test('init() must not clobber params the restore already reserved', () => {
  // Regression: the layer-state coordinator writes durable params
  // (setLayerParams) BEFORE it asks for the layer to be enabled, so init()
  // runs AFTER them. Resetting `playing`/`infrared` there silently dropped a
  // shared link's play state — the URL said play, the layer came up paused.
  // Caught by a browser round-trip, pinned here.
  const layer = createRainviewerRadarLayer();
  layer.setParams({ playing: true, infrared: true });
  assert.deepEqual(
    { ...layer.getParams(), frameTime: undefined },
    { playing: true, infrared: true, frameTime: undefined },
  );

  layer.init(fakeViewer());
  assert.equal(layer.getParams().playing, true, 'init() reset the reserved play state');
  assert.equal(layer.getParams().infrared, true, 'init() reset the reserved IR state');
});

test('scrubbing to an explicit frame stops the loop', () => {
  // A scrub is a deliberate position; leaving playback running would walk the
  // frame away from what the operator just chose.
  const layer = createRainviewerRadarLayer();
  layer.init(fakeViewer());
  layer.setParams({ playing: true });
  assert.equal(layer.getParams().playing, true);
  layer.setParams({ frameTime: 1789875600 });
  assert.equal(layer.getParams().playing, false);
});

test('an unknown or absent frame time leaves the layer following the newest frame', () => {
  const layer = createRainviewerRadarLayer();
  layer.init(fakeViewer());
  // No frames loaded yet, so any requested time is unknown and must not stick.
  layer.setParams({ frameTime: 123456 });
  assert.equal(layer.getParams().frameTime, null);
  layer.setParams({ frameTime: null });
  assert.equal(layer.getParams().frameTime, null);
});

test('setParams rejects a non-object and reports malformed input honestly', () => {
  const layer = createRainviewerRadarLayer();
  layer.init(fakeViewer());
  assert.equal(layer.setParams(null), false);
  assert.equal(layer.setParams('playing'), false);
  assert.equal(layer.setParams({}), true);
});

test('the row offers no scrubber before any frame has arrived', () => {
  // Chips computed from an empty frame list would render a scrubber with
  // nothing to scrub and a readout with no time to report.
  const layer = createRainviewerRadarLayer();
  layer.init(fakeViewer());
  assert.deepEqual(layer.getRowControls(), { chips: [] });
  assert.equal(layer.getStats().count, 0);
});

test('disable tears the imagery down rather than hiding it', () => {
  // A hidden ImageryLayer still holds its provider and tile cache; an OFF
  // radar layer must cost nothing.
  const viewer = fakeViewer();
  const layer = createRainviewerRadarLayer();
  layer.init(viewer);
  layer.enable();
  layer.disable();
  assert.equal(viewer.imageryLayers._layers.length, 0);
  layer.destroy();
  assert.equal(viewer.imageryLayers._layers.length, 0);
});
