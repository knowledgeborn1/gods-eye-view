/**
 * @file Pure frame math + path validation for the RainViewer weather-maps feed.
 *
 * Shared by the `/api/rainviewer` vite plugin (server-side: response
 * normalization, tile-path admission) and `src/data/rainviewerRadar.js`
 * (client-side: which frames to animate, what URL each one renders from).
 * Zero dependencies, Cesium-free, so both sides unit-test against it with
 * node:test.
 *
 * Upstream shape (https://api.rainviewer.com/public/weather-maps.json):
 *
 *   { version, generated, host: "https://tilecache.rainviewer.com",
 *     radar: { past: [{time, path}], nowcast: [{time, path}] },
 *     satellite: { infrared: [{time, path}] } }
 *
 * `time` is epoch SECONDS and `path` is a hashed, immutable frame directory
 * such as `/v2/radar/440ea8218834`. A tile is then
 * `{host}{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png`. Both
 * `radar.nowcast` and `satellite.infrared` are routinely EMPTY on the public
 * feed, so every consumer here treats them as optional rather than assuming
 * the documented key is populated.
 *
 * @module data/rainviewerFrames
 */

/** @const {string} Upstream feed. The proxy is the only caller. */
export const RAINVIEWER_WEATHER_MAPS_URL =
  'https://api.rainviewer.com/public/weather-maps.json';

/** @const {string} Same-origin base the rewritten `host` points at. */
export const RAINVIEWER_TILE_PROXY_BASE = '/api/rainviewer/tiles';

/** @const {number} Tile edge in px. RainViewer serves 256 and 512; 256 matches Cesium's default. */
export const RAINVIEWER_TILE_SIZE = 256;

/** @const {number} Color scheme 2 — "Universal Blue", the legible one over dark imagery. */
export const RAINVIEWER_COLOR_SCHEME = 2;

/** @const {number} Smoothed edges (1) rather than raw radar bins (0). */
export const RAINVIEWER_SMOOTH = 1;

/** @const {number} Render snow in its own palette (1) instead of as rain (0). */
export const RAINVIEWER_SNOW = 1;

/** @const {number} How much of `radar.past` the scrubber exposes (minutes). */
export const RAINVIEWER_PAST_WINDOW_MINUTES = 120;

/**
 * Frame directories this app will proxy.
 *
 * The tile endpoint takes a path chosen by the UPSTREAM feed, so it must never
 * become a general-purpose forwarder: without this the `/api/rainviewer/tiles`
 * middleware would happily fetch `/../../anything` from the tile host (or, with
 * a protocol-relative segment, off it entirely). Only the two documented frame
 * kinds with a hex frame id are admitted; everything else 404s before any
 * socket is opened.
 * @const {RegExp}
 */
const FRAME_PATH_GRAMMAR = /^\/v2\/(?:radar|satellite)\/[0-9a-f]{6,32}$/;

/**
 * Whether `path` is a frame directory this proxy is willing to fetch.
 * @param {unknown} path - Candidate `path` from the feed or a tile request.
 * @returns {boolean}
 */
export function isRainviewerFramePath(path) {
  return typeof path === 'string' && FRAME_PATH_GRAMMAR.test(path);
}

/**
 * Coerce one `{time, path}` entry, dropping anything malformed.
 * @param {unknown} frame - Candidate entry.
 * @returns {{time: number, path: string}|null}
 */
function normalizeFrame(frame) {
  const time = Number(frame?.time);
  const path = frame?.path;
  if (!Number.isInteger(time) || time <= 0) return null;
  if (!isRainviewerFramePath(path)) return null;
  return { time, path };
}

/** Normalize one frame list, sorted oldest → newest with duplicates dropped. */
function normalizeFrameList(frames) {
  if (!Array.isArray(frames)) return [];
  const byTime = new Map();
  for (const frame of frames) {
    const normalized = normalizeFrame(frame);
    if (normalized) byTime.set(normalized.time, normalized);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Validate and flatten a weather-maps response.
 *
 * Returns null only when the payload is unusable as a whole (not an object, or
 * carrying no radar history at all) — that is the signal to keep the previous
 * cached copy rather than replace a good snapshot with a broken one. An empty
 * `nowcast` or `infrared` is NORMAL, not a failure, and comes back as `[]`.
 * @param {unknown} payload - Parsed weather-maps.json.
 * @returns {{generated: number|null, host: string, radarPast: Array<{time:number,path:string}>,
 *   radarNowcast: Array<{time:number,path:string}>, infrared: Array<{time:number,path:string}>}|null}
 */
export function normalizeWeatherMaps(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return null;
  const radarPast = normalizeFrameList(payload.radar?.past);
  if (radarPast.length === 0) return null;
  const generated = Number(payload.generated);
  return {
    generated: Number.isInteger(generated) && generated > 0 ? generated : null,
    host: typeof payload.host === 'string' ? payload.host : '',
    radarPast,
    radarNowcast: normalizeFrameList(payload.radar?.nowcast),
    infrared: normalizeFrameList(payload.satellite?.infrared),
  };
}

/**
 * Rewrite a normalized snapshot for the browser: the upstream tile host is
 * replaced by the same-origin proxy base, so the client composes tile URLs with
 * the documented `{host}{path}/…` pattern and still never talks to RainViewer
 * directly (no CORS question, one place that caches, one place to audit).
 * @param {ReturnType<typeof normalizeWeatherMaps>} snapshot - Normalized feed.
 * @param {string} [tileBase=RAINVIEWER_TILE_PROXY_BASE] - Same-origin base.
 * @returns {object} Client-facing snapshot.
 */
export function toProxiedSnapshot(
  snapshot,
  tileBase = RAINVIEWER_TILE_PROXY_BASE,
) {
  return {
    generated: snapshot.generated,
    host: tileBase,
    radar: { past: snapshot.radarPast, nowcast: snapshot.radarNowcast },
    satellite: { infrared: snapshot.infrared },
  };
}

/**
 * Trailing-window slice of the past-radar frames, oldest → newest.
 *
 * The feed currently publishes 13 frames at a 10-minute cadence (exactly two
 * hours), but the count is upstream's to change; clamping by TIME rather than
 * by index keeps the scrubber honest about the window it advertises.
 * @param {Array<{time:number,path:string}>} frames - Normalized past frames.
 * @param {object} [options]
 * @param {number} [options.windowMinutes=RAINVIEWER_PAST_WINDOW_MINUTES] - Trailing span.
 * @returns {Array<{time:number,path:string}>}
 */
export function selectPastWindow(
  frames,
  { windowMinutes = RAINVIEWER_PAST_WINDOW_MINUTES } = {},
) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const newest = frames[frames.length - 1].time;
  const oldestAllowed = newest - Math.max(0, windowMinutes) * 60;
  return frames.filter((frame) => frame.time >= oldestAllowed);
}

/**
 * Build the Cesium `UrlTemplateImageryProvider` URL for one frame.
 *
 * `{z}/{x}/{y}` are left as Cesium placeholders; RainViewer uses standard
 * Web Mercator XYZ with y growing southward, which is exactly what Cesium
 * substitutes for `{y}` under its default tiling scheme.
 * @param {string} host - Tile host or same-origin proxy base.
 * @param {string} path - Frame directory (`/v2/radar/…`).
 * @param {object} [options]
 * @param {number} [options.size=RAINVIEWER_TILE_SIZE]
 * @param {number} [options.color=RAINVIEWER_COLOR_SCHEME]
 * @param {number} [options.smooth=RAINVIEWER_SMOOTH]
 * @param {number} [options.snow=RAINVIEWER_SNOW]
 * @returns {string} Tile URL template.
 */
export function frameTileTemplate(
  host,
  path,
  {
    size = RAINVIEWER_TILE_SIZE,
    color = RAINVIEWER_COLOR_SCHEME,
    smooth = RAINVIEWER_SMOOTH,
    snow = RAINVIEWER_SNOW,
  } = {},
) {
  return `${host}${path}/${size}/{z}/{x}/{y}/${color}/${smooth}_${snow}.png`;
}

/**
 * Parse a `/api/rainviewer/tiles/...` request path into its upstream parts.
 *
 * Every field is re-validated and re-emitted from parsed NUMBERS, so the string
 * the proxy forwards is one this function built, never one the caller supplied.
 * Returns null for anything outside the admitted grammar.
 * @param {string} requestPath - Path after the `/api/rainviewer/tiles` mount.
 * @returns {{path: string, size: number, z: number, x: number, y: number,
 *   color: number, smooth: number, snow: number, upstreamPath: string}|null}
 */
export function parseTileRequest(requestPath) {
  const match =
    /^(\/v2\/(?:radar|satellite)\/[0-9a-f]{6,32})\/(\d{3,4})\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\/(\d{1,2})\/([01])_([01])\.png$/.exec(
      String(requestPath || ''),
    );
  if (!match) return null;
  const [, path, sizeRaw, zRaw, xRaw, yRaw, colorRaw, smooth, snow] = match;
  const size = Number(sizeRaw);
  const z = Number(zRaw);
  const x = Number(xRaw);
  const y = Number(yRaw);
  const color = Number(colorRaw);
  // 256 and 512 are the sizes RainViewer publishes; 0..8 the documented color
  // schemes. Zoom is capped at 12 — radar resolution stops improving well
  // before that, and an uncapped z would let one viewport fan out into
  // thousands of upstream requests.
  if (size !== 256 && size !== 512) return null;
  if (z > 12) return null;
  const tilesPerAxis = 2 ** z;
  if (x >= tilesPerAxis || y >= tilesPerAxis) return null;
  if (color > 8) return null;
  return {
    path,
    size,
    z,
    x,
    y,
    color,
    smooth: Number(smooth),
    snow: Number(snow),
    upstreamPath: `${path}/${size}/${z}/${x}/${y}/${color}/${smooth}_${snow}.png`,
  };
}

/**
 * Short relative label for a frame, for the scrubber readout.
 *
 * Strictly elapsed time, with no "close enough to now" band: the newest frame
 * is routinely a full cadence step (10 minutes) old because radar composites
 * lag, and rounding that to NOW would have the readout state something the
 * data does not support. The scrubber calls the newest frame LATEST instead,
 * which is the claim that IS true.
 * @param {number} timeSeconds - Frame epoch seconds.
 * @param {number} [nowMs=Date.now()] - Clock.
 * @returns {string} e.g. `NOW`, `-40m`, `-2h`.
 */
export function frameLabel(timeSeconds, nowMs = Date.now()) {
  const deltaMinutes = Math.round((nowMs / 1000 - timeSeconds) / 60);
  if (deltaMinutes < 1) return 'NOW';
  if (deltaMinutes < 60) return `-${deltaMinutes}m`;
  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  return minutes === 0
    ? `-${hours}h`
    : `-${hours}h${String(minutes).padStart(2, '0')}`;
}
