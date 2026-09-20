import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  RAINVIEWER_WEATHER_MAPS_URL,
  normalizeWeatherMaps as normalizeRainviewerWeatherMaps,
  parseTileRequest as parseRainviewerTileRequest,
  toProxiedSnapshot as toProxiedRainviewerSnapshot,
} from '../../src/data/rainviewerFrames.js';

/**
 * RainViewer precipitation-radar proxy — the weather-maps index and the frame
 * tiles it points at, both keyless.
 *
 * Upstream: https://api.rainviewer.com/public/weather-maps.json (index) and
 * https://tilecache.rainviewer.com{path}/{size}/{z}/{x}/{y}/{color}/{smooth}_{snow}.png
 * (tiles). Neither sends CORS headers for this origin, so both go through here
 * — and routing the tiles too means the app has exactly ONE place that talks to
 * RainViewer, caches it, and can be audited.
 *
 * Index cache: memory + disk (.gev-cache/rainviewer-weather-maps.json), TTL
 * 5 min, single-flight, serve-stale-on-failure — the celestrakProxy pattern.
 * The feed regenerates every ~10 min, so a 5-minute TTL never misses a frame
 * while collapsing every reload and every client in the session onto one fetch.
 * The served copy has its `host` rewritten to the same-origin tile mount, so
 * the browser composes tile URLs with the documented `{host}{path}/…` pattern
 * and still never learns the upstream host.
 *
 * Tile cache: memory only, bounded LRU, TTL 20 min. Frame directories are
 * hashed and immutable but they AGE OUT of the index every 10 minutes, so a
 * disk cache would accumulate tiles for frames nothing can request again;
 * memory plus an LRU bound is the honest lifetime. Scrubbing back and forth
 * over the two-hour window therefore hits cache rather than upstream.
 *
 * SSRF posture: the tile path is chosen by the upstream FEED, not by us, so it
 * is re-parsed and rebuilt from validated numbers by `parseTileRequest` before
 * a socket is opened, and the tile host is allowlisted to rainviewer.com
 * regardless of what the index claims. Anything else 404s locally.
 *
 * @returns {import('vite').Plugin}
 */
export function rainviewerProxy() {
  const INDEX_TTL_MS = 5 * 60_000;
  const TILE_TTL_MS = 20 * 60_000;
  const TILE_MEM_MAX_ENTRIES = 600;
  const UPSTREAM_TIMEOUT_MS = 15_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const INDEX_CACHE_PATH = path.join(CACHE_DIR, 'rainviewer-weather-maps.json');
  const DEFAULT_TILE_HOST = 'https://tilecache.rainviewer.com';

  /** @type {{at:number, snapshot:object}|null} Normalized index (kept past TTL for serve-stale). */
  let index = null;
  /** @type {Promise<{at:number, snapshot:object}|null>|null} Single-flight index refresh. */
  let indexInflight = null;
  /** @type {Map<string, {at:number, buf:Buffer, type:string}>} upstream path -> tile. */
  const tiles = new Map();
  /** @type {Map<string, Promise<{at:number, buf:Buffer, type:string}|null>>} Single-flight per tile. */
  const tileInflight = new Map();

  /**
   * The tile host to fetch from. The index CLAIMS one, but a claimed host is
   * attacker-controlled input the moment the feed is wrong, so it is honored
   * only when it is an https rainviewer.com origin; otherwise the documented
   * default stands.
   */
  function tileHost() {
    const claimed = String(index?.snapshot?.host || '');
    try {
      const url = new URL(claimed);
      const allowed =
        url.protocol === 'https:' &&
        (url.hostname === 'rainviewer.com' ||
          url.hostname.endsWith('.rainviewer.com'));
      if (allowed) return url.origin;
    } catch {
      /* not a URL — fall through to the default */
    }
    return DEFAULT_TILE_HOST;
  }

  async function readIndexDisk() {
    try {
      const parsed = JSON.parse(await fsp.readFile(INDEX_CACHE_PATH, 'utf8'));
      const snapshot = normalizeRainviewerWeatherMaps(parsed?.snapshot);
      if (snapshot && Number.isFinite(parsed?.at))
        return { at: parsed.at, snapshot };
    } catch {
      /* no disk cache yet, or it no longer parses */
    }
    return null;
  }

  async function writeIndexDisk(entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(INDEX_CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn(
        '[rainviewer-proxy] index cache write failed:',
        err?.message || err,
      );
    }
  }

  async function fetchIndexUpstream() {
    const res = await fetch(RAINVIEWER_WEATHER_MAPS_URL, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'gods-eye-view-rainviewer-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = normalizeRainviewerWeatherMaps(await res.json());
    // A 200 carrying no radar history is an upstream error page as far as this
    // layer is concerned — keep the cache rather than replace it with nothing.
    if (!snapshot) throw new Error('no radar frames in response');
    return { at: Date.now(), snapshot };
  }

  /** LRU-ish memory insert (Map preserves insertion order; evict the oldest). */
  function tileMemSet(key, entry) {
    if (!tiles.has(key) && tiles.size >= TILE_MEM_MAX_ENTRIES) {
      tiles.delete(tiles.keys().next().value);
    }
    tiles.set(key, entry);
  }

  async function fetchTileUpstream(upstreamPath) {
    const res = await fetch(`${tileHost()}${upstreamPath}`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('empty tile body');
    return {
      at: Date.now(),
      buf,
      type: res.headers.get('content-type') || 'image/png',
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/rainviewer', async (req, res) => {
      // Sanitized responses only (proxy/security baseline): no upstream error
      // details and never the upstream URL.
      const sendJson = (status, obj, extraHeaders = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...extraHeaders,
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (entry, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': entry.type,
          'Cache-Control': 'no-store',
          'x-rainviewer-cache': cacheStatus,
        });
        res.end(entry.buf);
      };

      try {
        const urlPath = String(req.url || '').split('?')[0];

        if (urlPath === '/weather-maps.json') {
          const now = Date.now();
          if (!index) index = await readIndexDisk();
          if (index && now - index.at < INDEX_TTL_MS) {
            sendJson(200, toProxiedRainviewerSnapshot(index.snapshot), {
              'x-rainviewer-cache': 'HIT',
            });
            return;
          }
          if (!indexInflight) {
            indexInflight = fetchIndexUpstream()
              .then(async (fresh) => {
                index = fresh;
                await writeIndexDisk(fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[rainviewer-proxy] index refresh failed (${err?.message || err}) — serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                indexInflight = null;
              });
          }
          const fresh = await indexInflight;
          if (fresh) {
            sendJson(200, toProxiedRainviewerSnapshot(fresh.snapshot), {
              'x-rainviewer-cache': 'MISS',
            });
          } else if (index) {
            // Upstream down — a two-hour-old radar loop beats a dead layer,
            // and the client labels frames by their own timestamps anyway.
            sendJson(200, toProxiedRainviewerSnapshot(index.snapshot), {
              'x-rainviewer-cache': 'STALE-ERROR',
            });
          } else {
            sendJson(502, { error: 'upstream' });
          }
          return;
        }

        if (!urlPath.startsWith('/tiles/')) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const tile = parseRainviewerTileRequest(urlPath.slice('/tiles'.length));
        if (!tile) {
          sendJson(404, { error: 'not_found' });
          return;
        }

        const key = tile.upstreamPath;
        const now = Date.now();
        const cached = tiles.get(key);
        if (cached && now - cached.at < TILE_TTL_MS) {
          sendTile(cached, 'HIT');
          return;
        }
        if (!tileInflight.has(key)) {
          tileInflight.set(
            key,
            fetchTileUpstream(key)
              .then((fresh) => {
                tileMemSet(key, fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[rainviewer-proxy] tile fetch failed (${err?.message || err}) — serving stale if any`,
                );
                return null;
              })
              .finally(() => tileInflight.delete(key)),
          );
        }
        const fresh = await tileInflight.get(key);
        if (fresh) sendTile(fresh, 'MISS');
        else if (cached) sendTile(cached, 'STALE-ERROR');
        else sendJson(502, { error: 'upstream' });
      } catch (err) {
        console.warn('[rainviewer-proxy] error:', err?.message || err);
        sendJson(500, { error: 'proxy' });
      }
    });
  };

  return {
    name: 'rainviewer-proxy',
    configureServer: installMiddleware,
    // The preview server serves the built app and must route the same
    // keyless feeds, or `npm run preview` renders a dead radar layer.
    configurePreviewServer: installMiddleware,
  };
}
