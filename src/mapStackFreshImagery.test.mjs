import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EOX_S2CLOUDLESS_MAX_LEVEL,
  EOX_S2CLOUDLESS_URL,
  EOX_S2CLOUDLESS_YEAR,
  GIBS_VIIRS_FIRST_DATE,
  GIBS_VIIRS_MAX_LEVEL,
  GIBS_VIIRS_URL,
  MAP_STACKS,
  gibsDateBounds,
  gibsDefaultDate,
  normalizeGibsDate,
} from './mapStackController.js';

const controller = readFileSync(new URL('./mapStackController.js', import.meta.url), 'utf8');
const imagery = readFileSync(new URL('./maps/imagery.js', import.meta.url), 'utf8');
const sources = readFileSync(new URL('./maps/defaultSources.js', import.meta.url), 'utf8');

/** 2026-09-20T06:00:00Z — a fixed clock, so "yesterday" is a fact not a race. */
const NOW = Date.UTC(2026, 8, 20, 6);

test('both keyless fresh-imagery stacks are registered and need no credentials', () => {
  for (const id of ['eox-s2cloudless', 'gibs-viirs']) {
    const stack = MAP_STACKS.find((entry) => entry.id === id);
    assert.ok(stack, `${id} is missing from MAP_STACKS`);
    assert.equal(stack.requiresIon, false, `${id} must stay keyless`);
    assert.ok(stack.label && stack.shortLabel, `${id} needs a chip label and a status label`);
  }
});

test('the Sentinel-2 template names the newest published mosaic in WMTS z/y/x order', () => {
  // EOX advertises s2cloudless-2017 … s2cloudless-2025 today. The RESTful WMTS
  // template is {TileMatrix}/{TileRow}/{TileCol}, i.e. z/y/x — transposing the
  // last two silently renders a mirrored globe rather than failing.
  assert.equal(
    EOX_S2CLOUDLESS_URL,
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
  );
  assert.equal(EOX_S2CLOUDLESS_YEAR, 2025);
  // Native Sentinel-2 resolution is fully rendered by z14; past that Cesium
  // upsamples locally rather than quadrupling requests for the same pixels.
  assert.equal(EOX_S2CLOUDLESS_MAX_LEVEL, 14);
});

test('the VIIRS template is the Level9 matrix set and is capped to match', () => {
  // GIBS answers HTTP 400 at z10 for GoogleMapsCompatible_Level9, so the cap
  // is not a preference — an uncapped provider renders errors at close zoom.
  assert.equal(
    GIBS_VIIRS_URL,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor'
    + '/default/{date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
  );
  assert.equal(GIBS_VIIRS_MAX_LEVEL, 9);
  assert.match(imagery, /maximumLevel: GIBS_VIIRS_MAX_LEVEL/);
  // The date is substituted by us, not by Cesium — a surviving {date} would
  // be requested verbatim and 404 every tile.
  assert.match(imagery, /GIBS_VIIRS_URL\.replace\('\{date\}', date\)/);
  // ...and the registry hands the provider factory the CURRENT day, read at
  // construction time, so a retired provider is rebuilt on the new date.
  assert.match(sources, /createGibsViirsImagery\(viirsDate\)/);
});

test('the VIIRS stack opens on yesterday, not today', () => {
  // Today's swath is still being flown, so a "today" default renders a mostly
  // black globe and reads as a broken layer.
  assert.equal(gibsDefaultDate(NOW), '2026-09-19');
  // Just after midnight UTC the answer is still the previous calendar day.
  assert.equal(gibsDefaultDate(Date.UTC(2026, 8, 20, 0, 1)), '2026-09-19');
  assert.equal(gibsDefaultDate(Date.UTC(2026, 0, 1, 0, 0)), '2025-12-31');
});

test('the date control offers exactly the days that have imagery', () => {
  // `max` is TODAY, not the default day: a partial mosaic is a legitimate
  // deliberate request, it is just a poor default.
  assert.deepEqual(gibsDateBounds(NOW), { min: GIBS_VIIRS_FIRST_DATE, max: '2026-09-20' });
});

test('requested dates are clamped into the covered range instead of rendering blank', () => {
  assert.equal(normalizeGibsDate('2026-09-20', NOW), '2026-09-20');
  assert.equal(normalizeGibsDate('2020-07-04', NOW), '2020-07-04');
  // Future and pre-mission both return empty or error tiles upstream.
  assert.equal(normalizeGibsDate('2027-01-01', NOW), '2026-09-20');
  assert.equal(normalizeGibsDate('1999-01-01', NOW), GIBS_VIIRS_FIRST_DATE);
  assert.equal(normalizeGibsDate(GIBS_VIIRS_FIRST_DATE, NOW), GIBS_VIIRS_FIRST_DATE);
});

test('a date that is not a real calendar day falls back to the default', () => {
  for (const bogus of [
    '', null, undefined, 'yesterday', '2026-9-1', '20260901', '2026-02-31', '2026-13-01',
    '2026-09-20T00:00:00Z', {}, 42,
  ]) {
    assert.equal(normalizeGibsDate(bogus, NOW), '2026-09-19', `should reject: ${String(bogus)}`);
  }
});

test('changing the date retires the cached provider and only re-renders when VIIRS is live', () => {
  // The date is baked into the provider URL, so a stale cache entry would keep
  // painting the old day; and arming a date while looking at Esri must not
  // yank the view onto VIIRS.
  const start = controller.indexOf('async setGibsDate(');
  assert.ok(start > 0, 'setGibsDate is missing');
  const body = controller.slice(start, controller.indexOf('\n  }', start));
  assert.match(body, /const normalized = normalizeGibsDate\(date\)/);
  assert.match(body, /return this\.reconfigureSource\('gibs-viirs', \{ silent \}\)/);
  // The generic reconfigure hook is where the cache entry actually dies and
  // where the "only when on screen" rule lives.
  const generic = readFileSync(new URL('./maps/controller.js', import.meta.url), 'utf8');
  const hook = generic.slice(generic.indexOf('async reconfigureSource('));
  const hookBody = hook.slice(0, hook.indexOf('\n  }'));
  assert.match(hookBody, /this\._imageryProviders\.delete\(id\)/);
  assert.match(hookBody, /if \(this\._activeId === id\)[\s\S]*?await this\.setStack\(id, \{ silent \}\)/);
});
