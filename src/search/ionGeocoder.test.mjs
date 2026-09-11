// ION GEOCODER — the Cesium ion rung of the keyless chain. Ion answers with a
// bbox and no type vocabulary, so what matters here is that the box's own scale
// becomes the types the framing code reads, that the view bias rides along as
// focus.point, and that an unconfigured token never issues a request.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIonGeocoder,
  normalizeIonFeature,
  typesFromViewportSpan,
  ionSearchUrl,
  ION_SPAN_CITY_MAX_KM,
} from './ionGeocoder.js';
import { createDefaultPlaceSearch } from './defaults.js';
import { REGION_SWATH_SPAN_KM } from '../locations.js';

const austinBox = (label = 'Austin, TX, USA') => ({
  type: 'Feature',
  properties: { label },
  bbox: [-97.95, 30.1, -97.55, 30.52],
});

test('the span bands are pinned to the framing constant they mirror', () => {
  assert.equal(ION_SPAN_CITY_MAX_KM, REGION_SWATH_SPAN_KM);
});

test('a box with no layer infers types from its diagonal', () => {
  const box = (halfDeg) => ({
    southwest: { lat: 30 - halfDeg, lng: -97 - halfDeg },
    northeast: { lat: 30 + halfDeg, lng: -97 + halfDeg },
  });
  assert.deepEqual(typesFromViewportSpan(box(0.003)), [], 'a building is precise');
  assert.deepEqual(typesFromViewportSpan(box(0.012)), ['neighborhood']);
  assert.deepEqual(typesFromViewportSpan(box(0.2)), ['locality']);
  assert.deepEqual(typesFromViewportSpan(box(5)), ['natural_feature']);
  assert.deepEqual(typesFromViewportSpan(null), []);
});

test('a Pelias layer wins over the span inference', () => {
  const place = normalizeIonFeature({
    ...austinBox('Texas, USA'),
    properties: { label: 'Texas, USA', layer: 'region' },
  });
  assert.deepEqual(place.types, ['administrative_area_level_1']);
});

test('a bbox feature centres on its box in the framing shape', () => {
  const place = normalizeIonFeature(austinBox());
  assert.ok(Math.abs(place.lat - 30.31) < 1e-9);
  assert.ok(Math.abs(place.lng - -97.75) < 1e-9);
  assert.equal(place.label, 'Austin, TX, USA');
  assert.deepEqual(place.viewport, {
    southwest: { lat: 30.1, lng: -97.95 },
    northeast: { lat: 30.52, lng: -97.55 },
  });
  assert.deepEqual(place.types, ['locality']);
});

test('a point feature without a bbox is a precise place', () => {
  const place = normalizeIonFeature({
    geometry: { type: 'Point', coordinates: [-97.7403, 30.2747] },
    properties: { label: 'Texas State Capitol' },
  });
  assert.equal(place.lat, 30.2747);
  assert.equal(place.lng, -97.7403);
  assert.deepEqual(place.types, []);
  assert.equal(place.viewport, null);
  assert.equal(normalizeIonFeature({ properties: { label: 'nowhere' } }), null);
});

test('the view bias is sent as focus.point, never as a hard filter', () => {
  const url = new URL(ionSearchUrl('Sixth Street', 'tok', { bias: '30.1,-97.95|30.52,-97.55' }));
  assert.equal(url.searchParams.get('access_token'), 'tok');
  assert.equal(url.searchParams.get('text'), 'Sixth Street');
  assert.ok(Math.abs(Number(url.searchParams.get('focus.point.lat')) - 30.31) < 1e-9);
  assert.ok(Math.abs(Number(url.searchParams.get('focus.point.lon')) - -97.75) < 1e-9);
  assert.equal(url.searchParams.has('boundary.rect.min_lat'), false);
  const unbiased = new URL(ionSearchUrl('Sixth Street', 'tok'));
  assert.equal(unbiased.searchParams.has('focus.point.lat'), false);
});

test('no token means no request and no negative verdict', async () => {
  let calls = 0;
  const provider = createIonGeocoder({
    resolveToken: () => '',
    fetchImpl: async () => { calls++; return Response.json({ features: [] }); },
  });
  assert.deepEqual(await provider.geocode('Austin'), { place: null, answered: true });
  assert.equal(calls, 0);
});

test('an empty answer is a verdict, a failure is not', async () => {
  const empty = createIonGeocoder({ resolveToken: () => 'tok', fetchImpl: async () => Response.json({ features: [] }) });
  assert.deepEqual(await empty.geocode('zzzz'), { place: null, answered: true });
  for (const fail of [
    () => { throw new Error('offline'); },
    () => new Response('not json', { status: 200 }),
    () => new Response('', { status: 401 }),
    () => Response.json({ error: 'bad' }),
  ]) {
    const provider = createIonGeocoder({ resolveToken: () => 'tok', fetchImpl: async () => fail() });
    assert.deepEqual(await provider.geocode('Austin'), { place: null, answered: false });
  }
});

test('cancellation before lookup makes no request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const provider = createIonGeocoder({ resolveToken: () => 'tok', fetchImpl: async () => { calls++; return Response.json({ features: [austinBox()] }); } });
  await assert.rejects(provider.geocode('Austin', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('the default chain asks ion after Photon misses and before the Nominatim route', async () => {
  const hosts = [];
  const service = createDefaultPlaceSearch({
    resolveIonToken: () => 'tok',
    fetchImpl: async (url) => {
      const host = new URL(url, 'http://localhost').hostname;
      hosts.push(host);
      if (host === 'photon.komoot.io') return Response.json({ features: [] });
      if (host === 'api.cesium.com') return Response.json({ features: [austinBox()] });
      throw new Error(`unexpected request to ${host}`);
    },
  });
  const result = await service.geocode('Austin');
  assert.equal(result.place.label, 'Austin, TX, USA');
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(hosts, ['photon.komoot.io', 'api.cesium.com']);
});

test('without an ion token the default chain never asks ion', async () => {
  const hosts = [];
  const service = createDefaultPlaceSearch({
    fetchImpl: async (url) => {
      hosts.push(new URL(url, 'http://localhost').hostname);
      return Response.json({ features: [] });
    },
  });
  await service.geocode('zzzz');
  assert.equal(hosts.includes('api.cesium.com'), false);
});
