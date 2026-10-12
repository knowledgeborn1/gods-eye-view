import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken }).then(forceHttpsTiles);
}

// Cesium's Bing provider requests http:// tiles whenever the page itself is
// http (the local dev server), and the app's CSP only allows https, so Bing
// Aerial/Labels went blank. Bing serves the same tiles over https.
function forceHttpsTiles(provider) {
  const inner = provider?._imageryProvider;
  if (inner && typeof inner._imageUrlTemplate === 'string') {
    inner._imageUrlTemplate = inner._imageUrlTemplate.replace(/^http:\/\//, 'https://');
  }
  return provider;
}

// ── Keyless fresh-imagery stacks ─────────────────────────────────────────────
// Both are WMTS tiles fetched directly like Esri and OSM above — the dev proxy
// exists for feeds that need a key, a CORS shim or a quota governor, and
// neither of these needs any of the three.

/**
 * Newest Sentinel-2 cloudless mosaic EOX publishes.
 *
 * Probed from https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml, which
 * currently advertises s2cloudless-2017 … s2cloudless-2025. Bumping this is a
 * one-line yearly change; `mapStackFreshImagery.test.mjs` pins the URL shape
 * so a bump cannot quietly break the template.
 * @const {number}
 */
export const EOX_S2CLOUDLESS_YEAR = 2025;

/** WMTS RESTful template: `{TileMatrix}/{TileRow}/{TileCol}` — i.e. z/y/x. */
export const EOX_S2CLOUDLESS_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_S2CLOUDLESS_YEAR}_3857/default/g/{z}/{y}/{x}.jpg`;

/**
 * Sentinel-2 resolves 10 m/px, which z14 already renders fully. EOX's tile
 * matrix advertises z21, but every level past native is the same pixels cut
 * into four times as many requests, so Cesium upsamples locally instead.
 * @const {number}
 */
export const EOX_S2CLOUDLESS_MAX_LEVEL = 14;

const EOX_S2CLOUDLESS_CREDIT =
  'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data)';

export function createEoxS2CloudlessImagery() {
  return new Cesium.UrlTemplateImageryProvider({
    url: EOX_S2CLOUDLESS_URL,
    maximumLevel: EOX_S2CLOUDLESS_MAX_LEVEL,
    enablePickFeatures: false,
    credit: EOX_S2CLOUDLESS_CREDIT,
  });
}

/** GIBS RESTful WMTS; `{date}` is substituted per request, not by Cesium. */
export const GIBS_VIIRS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor' +
  '/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg';

/** The `Level9` in the matrix-set name is literal: z10 answers HTTP 400. */
export const GIBS_VIIRS_MAX_LEVEL = 9;

const GIBS_CREDIT =
  'NASA GIBS / Worldview — VIIRS/SNPP Corrected Reflectance (True Color)';

/**
 * Daily VIIRS true-color imagery for one UTC day. The date is baked into the
 * URL, so a different day is a different provider.
 * @param {string} date - `YYYY-MM-DD`, already normalized by the caller.
 */
export function createGibsViirsImagery(date) {
  return new Cesium.UrlTemplateImageryProvider({
    url: GIBS_VIIRS_URL.replace('{date}', date),
    maximumLevel: GIBS_VIIRS_MAX_LEVEL,
    enablePickFeatures: false,
    credit: GIBS_CREDIT,
  });
}
