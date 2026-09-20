import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  RAINVIEWER_PAST_WINDOW_MINUTES,
  frameLabel,
  frameTileTemplate,
  selectPastWindow,
} from './rainviewerFrames.js';

/**
 * Worldwide precipitation radar from RainViewer, as a Cesium imagery layer.
 *
 * Keyless: the dev-server proxy (`/api/rainviewer`, see
 * server/providers/rainviewer.js) owns
 * the upstream fetch, the 5-minute index cache and the tile cache, so this
 * module only ever talks same-origin.
 *
 * ── Why one ImageryLayer PER FRAME ──────────────────────────────────────────
 * A radar loop is thirteen complete global tile sets. Swapping the URL on a
 * single provider would discard Cesium's tile cache on every step, so the
 * animation would re-download the visible tiles 13 times a cycle and stutter
 * forever. Instead each frame gets its own layer, created LAZILY the first
 * time it is shown and hidden with `show=false` between turns: the first pass
 * through the loop is a download, every later pass is free. The set is bounded
 * by the two-hour window (13 layers at the current 10-minute cadence), and
 * layers for frames that age out of the index are destroyed on refresh.
 *
 * `alpha` is 0.75 so the basemap reads through the precipitation rather than
 * being replaced by it, and the active frame is raised to the top of the
 * imagery stack so nothing this app adds later can bury it.
 */

const INDEX_URL = '/api/rainviewer/weather-maps.json';

/** Radar tiles stop gaining detail well before this; the proxy caps z the same way. */
const MAX_TILE_LEVEL = 12;

/** Milliseconds each intermediate frame holds during playback. */
const FRAME_STEP_MS = 500;

/** Longer hold on the newest frame, so a loop reads as "and this is now". */
const FRAME_DWELL_MS = 1500;

/** Imagery opacity — precipitation over the basemap, not instead of it. */
const RADAR_ALPHA = 0.75;

/** Infrared cloud tops sit under the radar and are dimmer still. */
const INFRARED_ALPHA = 0.55;

export function createRainviewerRadarLayer() {
  let _viewer = null;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _rowControlsListener = null;

  /** @type {Array<{time:number, path:string}>} Past radar frames, oldest → newest. */
  let _frames = [];
  /** @type {Array<{time:number, path:string}>} Satellite IR frames; routinely EMPTY upstream. */
  let _infraredFrames = [];
  /** @type {string} Tile base the proxy told us to use (same-origin). */
  let _tileHost = '';
  /** @type {Map<string, Cesium.ImageryLayer>} frame path → lazily created layer. */
  const _frameLayers = new Map();
  /** @type {Cesium.ImageryLayer|null} The single IR layer (newest IR frame). */
  let _infraredLayer = null;

  /**
   * Which frame is on screen, tracked by TIME rather than index: a refresh
   * shifts every index by one, and a scrubbed-to position must survive that.
   * null means "follow the newest frame", which is also what a fresh enable
   * and an aged-out selection fall back to.
   * @type {number|null}
   */
  let _selectedTime = null;
  let _playing = false;
  let _infraredEnabled = false;
  let _playTimer = null;

  const notifyRowControls = () => {
    try {
      _rowControlsListener?.();
    } catch {
      /* panel repaint is best effort */
    }
  };

  /** The frame currently displayed, or null when there is no data yet. */
  function activeFrame() {
    if (_frames.length === 0) return null;
    if (_selectedTime === null) return _frames[_frames.length - 1];
    return (
      _frames.find((frame) => frame.time === _selectedTime) ||
      _frames[_frames.length - 1]
    );
  }

  function activeIndex() {
    const frame = activeFrame();
    return frame ? _frames.indexOf(frame) : -1;
  }

  /** Build (or reuse) the imagery layer for one frame. */
  function layerForFrame(frame) {
    const existing = _frameLayers.get(frame.path);
    if (existing) return existing;
    const layer = new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: frameTileTemplate(_tileHost, frame.path),
        maximumLevel: MAX_TILE_LEVEL,
        // Radar tiles carry no picking metadata; asking for it costs a request.
        enablePickFeatures: false,
        credit: 'Weather data by RainViewer',
      }),
    );
    layer.alpha = RADAR_ALPHA;
    layer.show = false;
    _viewer.imageryLayers.add(layer);
    _frameLayers.set(frame.path, layer);
    return layer;
  }

  /** Show exactly one radar frame and nothing else. */
  function paintActiveFrame() {
    if (!_viewer || !_enabled) return;
    const frame = activeFrame();
    for (const [path, layer] of _frameLayers) {
      if (path !== frame?.path) layer.show = false;
    }
    if (!frame) return;
    const layer = layerForFrame(frame);
    layer.show = true;
    // Keep precipitation above anything else this app stacks on the globe
    // (city lights, a future overlay) without depending on insertion order.
    _viewer.imageryLayers.raiseToTop(layer);
    governorRequestRender('rainviewer-radar-frame');
  }

  function syncInfraredLayer() {
    const wanted = _enabled && _infraredEnabled && _infraredFrames.length > 0;
    if (!wanted) {
      if (_infraredLayer) {
        _viewer?.imageryLayers.remove(_infraredLayer, true);
        _infraredLayer = null;
        governorRequestRender('rainviewer-radar-ir-off');
      }
      return;
    }
    const newest = _infraredFrames[_infraredFrames.length - 1];
    // Rebuild when the newest IR frame moved on; there is only ever one IR
    // layer, so there is no cache to preserve across the swap.
    if (_infraredLayer?.__gevIrPath === newest.path) return;
    if (_infraredLayer) _viewer.imageryLayers.remove(_infraredLayer, true);
    _infraredLayer = new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: frameTileTemplate(_tileHost, newest.path),
        maximumLevel: MAX_TILE_LEVEL,
        enablePickFeatures: false,
        credit: 'Weather data by RainViewer',
      }),
    );
    _infraredLayer.__gevIrPath = newest.path;
    _infraredLayer.alpha = INFRARED_ALPHA;
    _viewer.imageryLayers.add(_infraredLayer);
    // Radar reclaims the top; IR is context beneath it.
    paintActiveFrame();
    governorRequestRender('rainviewer-radar-ir-on');
  }

  function stopPlayback() {
    if (_playTimer !== null) clearTimeout(_playTimer);
    _playTimer = null;
  }

  function schedulePlaybackStep() {
    stopPlayback();
    if (!_playing || !_enabled || _frames.length < 2) return;
    const onNewest = activeIndex() === _frames.length - 1;
    _playTimer = setTimeout(
      () => {
        _playTimer = null;
        if (!_playing || !_enabled) return;
        const next = (activeIndex() + 1) % _frames.length;
        // Wrapping to the oldest frame re-enters "following", so a loop that
        // reaches the present keeps tracking the present across a refresh.
        _selectedTime = next === _frames.length - 1 ? null : _frames[next].time;
        paintActiveFrame();
        notifyRowControls();
        schedulePlaybackStep();
      },
      onNewest ? FRAME_DWELL_MS : FRAME_STEP_MS,
    );
    _playTimer?.unref?.();
  }

  /** Discard layers for frames that have aged out of the index. */
  function pruneRetiredFrames() {
    const live = new Set(_frames.map((frame) => frame.path));
    for (const [path, layer] of [..._frameLayers]) {
      if (live.has(path)) continue;
      _viewer?.imageryLayers.remove(layer, true);
      _frameLayers.delete(path);
    }
  }

  function removeAllLayers() {
    for (const layer of _frameLayers.values())
      _viewer?.imageryLayers.remove(layer, true);
    _frameLayers.clear();
    if (_infraredLayer) {
      _viewer?.imageryLayers.remove(_infraredLayer, true);
      _infraredLayer = null;
    }
  }

  const layer = {
    id: 'rainviewer-radar',
    name: 'Precipitation Radar',
    icon: '🌧',
    source: 'RainViewer',
    // The feed regenerates every ~10 minutes and the proxy caches the index
    // for 5, so a 10-minute refresh always lands on new frames.
    updateInterval: 600_000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      _frames = [];
      _infraredFrames = [];
      _selectedTime = null;
      _playing = false;
      _infraredEnabled = false;
      _lastUpdate = null;
      _lastError = null;
      console.log('[Data:RainviewerRadar] Initialized');
    },

    enable() {
      _enabled = true;
      paintActiveFrame();
      syncInfraredLayer();
      schedulePlaybackStep();
    },

    disable() {
      _enabled = false;
      stopPlayback();
      // Tear the imagery down rather than hiding it: a hidden ImageryLayer
      // still holds its tile cache and its provider, and an OFF radar layer
      // must cost nothing.
      removeAllLayers();
      governorRequestRender('rainviewer-radar-off');
    },

    async update() {
      try {
        const response = await fetch(INDEX_URL);
        if (!response.ok) {
          _lastError = `RainViewer HTTP ${response.status}`;
          return false;
        }
        const payload = await response.json();
        const past = Array.isArray(payload?.radar?.past)
          ? payload.radar.past
          : null;
        if (!past || past.length === 0) {
          _lastError = 'Malformed RainViewer response';
          return false;
        }
        _tileHost = String(payload.host || '');
        _frames = selectPastWindow(past, {
          windowMinutes: RAINVIEWER_PAST_WINDOW_MINUTES,
        });
        _infraredFrames = Array.isArray(payload?.satellite?.infrared)
          ? payload.satellite.infrared
          : [];
        // A selection that aged out of the window returns to following the
        // newest frame rather than silently sticking on a frame that is gone.
        if (
          _selectedTime !== null &&
          !_frames.some((frame) => frame.time === _selectedTime)
        ) {
          _selectedTime = null;
        }
        pruneRetiredFrames();
        if (_enabled) {
          paintActiveFrame();
          syncInfraredLayer();
          schedulePlaybackStep();
        }
        _lastUpdate = Date.now();
        _lastError = null;
        notifyRowControls();
        console.log(
          `[Data:RainviewerRadar] Updated: ${_frames.length} radar frames, ${_infraredFrames.length} IR frames`,
        );
        return true;
      } catch (error) {
        console.warn('[Data:RainviewerRadar] Fetch error:', error);
        _lastError = 'RainViewer network error';
        return false;
      }
    },

    destroy() {
      _enabled = false;
      stopPlayback();
      removeAllLayers();
      _frames = [];
      _infraredFrames = [];
      _selectedTime = null;
      _lastUpdate = null;
      _lastError = null;
      _rowControlsListener = null;
      _viewer = null;
    },

    /**
     * Runtime parameters (DataLayerManager params contract).
     *
     * `frameTime` is deliberately absolute: the scrubber chips compute the
     * neighbouring frame's timestamp at render time and declare it, so a stale
     * row can never apply a relative step against a list that has since moved.
     * @param {object} params
     * @returns {boolean} True when the request was understood.
     */
    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      if (Object.hasOwn(params, 'playing')) {
        const next = params.playing === true;
        if (next !== _playing) {
          _playing = next;
          if (_playing) schedulePlaybackStep();
          else stopPlayback();
        }
      }
      if (Object.hasOwn(params, 'infrared')) {
        const next = params.infrared === true;
        if (next !== _infraredEnabled) {
          _infraredEnabled = next;
          syncInfraredLayer();
        }
      }
      if (Object.hasOwn(params, 'frameTime')) {
        const requested = Number(params.frameTime);
        if (params.frameTime === null) {
          _selectedTime = null;
        } else if (
          Number.isInteger(requested) &&
          _frames.some((frame) => frame.time === requested)
        ) {
          // Pinning the newest frame is stored as "follow", so a later refresh
          // advances with the feed instead of freezing on a now-older frame.
          _selectedTime =
            requested === _frames[_frames.length - 1].time ? null : requested;
        }
        // Scrubbing is an explicit position, so it stops the loop.
        if (_playing) {
          _playing = false;
          stopPlayback();
        }
        paintActiveFrame();
      }
      notifyRowControls();
      return true;
    },

    /** @returns {{playing: boolean, infrared: boolean, frameTime: number|null}} */
    getParams() {
      return {
        playing: _playing,
        infrared: _infraredEnabled,
        frameTime: activeFrame()?.time ?? null,
      };
    },

    /**
     * Layer-row sub-controls: the two-hour frame scrubber, plus the IR cloud
     * sub-toggle when — and only when — the feed actually carries infrared
     * frames. `satellite.infrared` is an empty array on the public feed most
     * of the time, and a chip that can only ever show an empty sky is worse
     * than no chip, so the control appears with the data and not before.
     * @returns {{chips: Array<object>}}
     */
    getRowControls() {
      if (_frames.length === 0) return { chips: [] };
      const index = activeIndex();
      const previous = _frames[index - 1] || null;
      const next = _frames[index + 1] || null;
      const current = _frames[index];
      const chips = [
        {
          id: 'frame-prev',
          label: '⏮',
          active: false,
          disabled: !previous,
          state: 'idle',
          title: previous
            ? `Step back to ${frameLabel(previous.time)}`
            : `Oldest frame in the ${RAINVIEWER_PAST_WINDOW_MINUTES}-minute window`,
          params: previous ? { frameTime: previous.time } : null,
        },
        {
          id: 'frame-play',
          label: _playing ? '⏸' : '▶',
          active: _playing,
          disabled: _frames.length < 2,
          state: _playing ? 'active' : 'idle',
          title: _playing
            ? 'Pause the radar loop'
            : `Play the last ${RAINVIEWER_PAST_WINDOW_MINUTES} minutes of radar`,
          params: { playing: !_playing },
        },
        {
          id: 'frame-next',
          label: '⏭',
          active: false,
          disabled: !next,
          state: 'idle',
          title: next
            ? `Step forward to ${frameLabel(next.time)}`
            : 'Latest frame',
          params: next ? { frameTime: next.time } : null,
        },
        {
          // A readout, not a control: it reports which frame is on screen so
          // the scrubber means something. Disabled because there is nothing
          // to activate — the chip row is the only surface this layer has.
          id: 'frame-time',
          label:
            index === _frames.length - 1 ? 'LATEST' : frameLabel(current.time),
          active: false,
          disabled: true,
          state: 'idle',
          title: new Date(current.time * 1000).toUTCString(),
          params: null,
        },
      ];
      if (_infraredFrames.length > 0) {
        chips.push({
          id: 'infrared',
          label: 'IR CLOUDS',
          active: _infraredEnabled,
          disabled: false,
          state: _infraredEnabled ? 'active' : 'idle',
          title: _infraredEnabled
            ? 'Hide infrared satellite cloud tops'
            : 'Show infrared satellite cloud tops beneath the radar',
          params: { infrared: !_infraredEnabled },
        });
      }
      return { chips };
    },

    /** Install the manager's "row controls changed" callback. */
    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _frames.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        status: _lastError ? 'degraded' : 'nominal',
      };
    },
  };

  return layer;
}

const rainviewerRadarLayer = createRainviewerRadarLayer();

export default rainviewerRadarLayer;
