/**
 * Cesium ion geocoder provider — the Pelias-backed endpoint IonGeocoderService
 * uses (`v1/geocode/search`, GeoJSON out). It is reachable cross-origin from the
 * browser, so unlike the local Nominatim route it needs no dev-server proxy, and
 * the token it spends is the CESIUM_ION_TOKEN the globe already needs for terrain.
 */
const ION_GEOCODE_ENDPOINT = 'https://api.cesium.com/v1/geocode/search';

/** Ion is a shared quota; fail fast rather than hold the search open. */
const ION_TIMEOUT_MS = 6000;

/**
 * Pelias `layer` → the Google `types` vocabulary `geocodeNavigationMode` reads.
 * Framing is driven entirely by these strings, so mapping here is what lets every
 * downstream branch (region swath, locality sanity gate, building resolve) stay
 * unchanged. Venue / address fall through to [] — precise-place, the right frame
 * for a building.
 */
const PELIAS_LAYER_TYPES = Object.freeze({
  country: ['country'],
  dependency: ['country'],
  continent: ['country'],
  macroregion: ['administrative_area_level_1'],
  region: ['administrative_area_level_1'],
  macrocounty: ['administrative_area_level_2'],
  county: ['administrative_area_level_2'],
  locality: ['locality'],
  localadmin: ['locality'],
  borough: ['neighborhood'],
  neighbourhood: ['neighborhood'],
  postalcode: ['postal_code'],
  street: ['route'],
  marinearea: ['natural_feature'],
});

/**
 * Scale bands for a result that carries a bounding box but NO type vocabulary.
 * Ion normalises every provider down to `{properties: {label}, bbox}` — no Pelias
 * `layer`, no Google `types` — so the box's own diagonal is the only scale signal
 * left. The bands are set against the constants governing framing in
 * locations.js: the city ceiling is REGION_SWATH_SPAN_KM, so an inferred type
 * lands in the same branch a real one would. The search package reads no
 * application state, so the value is restated here and pinned equal by test.
 */
export const ION_SPAN_PRECISE_MAX_KM = 1.2;
export const ION_SPAN_NEIGHBORHOOD_MAX_KM = 4;
export const ION_SPAN_CITY_MAX_KM = 400;

/** Mean km per degree of latitude (WGS84). */
const KM_PER_DEGREE = 111.32;

/** Diagonal of a {southwest,northeast} box in km, antimeridian read the short way. */
export function boundsDiagonalKm(viewport) {
  const sw = viewport?.southwest;
  const ne = viewport?.northeast;
  if (![sw?.lat, sw?.lng, ne?.lat, ne?.lng].every(Number.isFinite)) return null;
  const latSpanKm = Math.abs(ne.lat - sw.lat) * KM_PER_DEGREE;
  const lonSpanDeg = (((ne.lng - sw.lng) % 360) + 360) % 360;
  const centerLat = (sw.lat + ne.lat) / 2;
  const lonSpanKm =
    lonSpanDeg * KM_PER_DEGREE * Math.cos((centerLat * Math.PI) / 180);
  return Math.hypot(latSpanKm, lonSpanKm);
}

/**
 * Infer Google-ish `types` from a bounding box's diagonal span.
 * @returns {string[]} possibly empty — a building-sized box is a precise place.
 */
export function typesFromViewportSpan(viewport) {
  const spanKm = boundsDiagonalKm(viewport);
  if (!Number.isFinite(spanKm)) return [];
  if (spanKm <= ION_SPAN_PRECISE_MAX_KM) return [];
  if (spanKm <= ION_SPAN_NEIGHBORHOOD_MAX_KM) return ['neighborhood'];
  if (spanKm <= ION_SPAN_CITY_MAX_KM) return ['locality'];
  // Bigger than any city: a natural region. 'natural_feature' routes to
  // area-overview, whose swath plan caps the range — whole-box framing flew the
  // camera to space (the "Rocky Mountains" field test). A country this large
  // frames as a regional swath rather than edge-to-edge: a box alone cannot
  // tell a range from a nation.
  return ['natural_feature'];
}

/** GeoJSON bbox [west, south, east, north] → {southwest,northeast}, or null. */
export function ionBboxToBounds(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return {
    southwest: { lat: Math.min(south, north), lng: west },
    northeast: { lat: Math.max(south, north), lng: east },
  };
}

/**
 * Ion feature → the normalized geocode result the chain consumes. Ion's providers
 * answer with a box and no geometry; Pelias proper answers points with geometry
 * and no box. Accept either, preferring the box, exactly as Cesium's own
 * PeliasGeocoderService does.
 * @returns {?{lat:number, lng:number, name:string, label:string, types:string[], viewport:?object}}
 */
export function normalizeIonFeature(feature) {
  if (!feature) return null;
  const viewport = ionBboxToBounds(feature.bbox);
  let lat;
  let lng;
  if (viewport) {
    lat = (viewport.southwest.lat + viewport.northeast.lat) / 2;
    const lonSpan =
      (((viewport.northeast.lng - viewport.southwest.lng) % 360) + 360) % 360;
    lng = viewport.southwest.lng + lonSpan / 2;
    if (lng > 180) lng -= 360;
  } else {
    const coordinates = feature.geometry?.coordinates;
    lng = Number(coordinates?.[0]);
    lat = Number(coordinates?.[1]);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const properties = feature.properties || {};
  const label = String(properties.label || '');
  return {
    lat,
    lng,
    name: String(properties.name || label),
    label,
    // A Pelias `layer` when one is present; otherwise the box's own scale.
    types:
      PELIAS_LAYER_TYPES[String(properties.layer || '')] ||
      typesFromViewportSpan(viewport),
    viewport,
  };
}

/**
 * Request URL for one query. `bias` is the same "swLat,swLng|neLat,neLng" string
 * `viewportBias()` builds for Google, sent as ion's `focus.point` proximity bias.
 * Verified honoured by ion's default provider: "Sixth Street" focused on Austin
 * returns the Austin street.
 */
export function ionSearchUrl(
  query,
  token,
  { bias = null, endpoint = ION_GEOCODE_ENDPOINT } = {},
) {
  const url = new URL(endpoint);
  url.searchParams.set('access_token', String(token));
  url.searchParams.set('text', String(query ?? ''));
  const corners = String(bias ?? '').split('|');
  if (corners.length === 2) {
    const [swLat, swLng] = corners[0].split(',').map(Number);
    const [neLat, neLng] = corners[1].split(',').map(Number);
    if ([swLat, swLng, neLat, neLng].every(Number.isFinite)) {
      url.searchParams.set('focus.point.lat', String((swLat + neLat) / 2));
      url.searchParams.set('focus.point.lon', String((swLng + neLng) / 2));
    }
  }
  return url.toString();
}

/**
 * Construct an ion provider. `resolveToken` is read per request, the way the
 * Google adapter reads its key, so a token entered mid-session takes effect.
 * Read the configured token rather than Cesium.Ion.defaultAccessToken, which
 * falls back to the bundled demo token and would quietly spend someone else's
 * quota. Unconfigured → an unanswered-free pass ({place: null, answered: true}),
 * matching how an unconfigured Google provider declines to vote.
 */
export function createIonGeocoder({
  resolveToken,
  fetchImpl = (...args) => fetch(...args),
  endpoint = ION_GEOCODE_ENDPOINT,
} = {}) {
  return {
    async geocode(query, { bias = null, signal } = {}) {
      signal?.throwIfAborted();
      const token = resolveToken?.();
      if (!token) return { place: null, answered: true };
      const text = String(query ?? '').trim();
      if (!text) return { place: null, answered: true };
      try {
        const deadline = AbortSignal.timeout(ION_TIMEOUT_MS);
        const requestSignal = signal
          ? AbortSignal.any([signal, deadline])
          : deadline;
        const response = await fetchImpl(
          ionSearchUrl(text, token, { bias, endpoint }),
          { signal: requestSignal },
        );
        signal?.throwIfAborted();
        if (!response.ok) return { place: null, answered: false };
        const data = await response.json();
        signal?.throwIfAborted();
        if (!Array.isArray(data?.features))
          return { place: null, answered: false };
        const place = normalizeIonFeature(data.features[0]);
        // An empty feature list is a verdict; a malformed one is not.
        return {
          place,
          answered: Boolean(place) || data.features.length === 0,
        };
      } catch {
        signal?.throwIfAborted();
        return { place: null, answered: false };
      }
    },
  };
}
