import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadUdotSourcesFromOpenData,
  udotCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  UDOT_CAMERAS_URL,
  UDOT_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One `api/v2/get/cameras` row, shaped like the live UDOT payload. */
const row = (patch = {}, views) => ({
  Id: 165266,
  Source: 'ADX',
  SourceId: '103664',
  Roadway: 'SR 51',
  Direction: 'Northbound',
  Latitude: 40.14488,
  Longitude: -111.61137,
  Location: 'SR-51 @ 1600 S, SPV',
  SortOrder: 0,
  Views: views ?? [
    {
      Id: 165266,
      Url: 'https://www.udottraffic.utah.gov/map/Cctv/165266',
      Status: 'Enabled',
      Description: '',
    },
  ],
  ...patch,
});

const FAKE_KEY = 'unit-test-key-0123456789abcdef';

/** Run `fn` with UDOT_API_KEY (and the pack switch) set exactly as given. */
const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_UDOT_ENABLED;
    delete process.env.CCTV_UDOT_MAX_SOURCES;
    delete process.env.UDOT_API_KEY;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('a UDOT row maps to a still-image source on the pinned frame host', () => {
  const source = udotCameraToSource(row());
  assert.equal(source.id, 'udot-165266');
  assert.equal(source.name, 'SR-51 @ 1600 S, SPV');
  assert.equal(source.city, 'SR 51');
  assert.equal(source.cityId, 'utah');
  assert.equal(source.provider, 'UDOT');
  assert.equal(source.lat, 40.14488);
  assert.equal(source.lon, -111.61137);
  assert.equal(source.headingDeg, 0);
  assert.equal(source.headingConfidence, 'high');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, `${UDOT_IMAGE_ORIGIN}165266`);
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.sourceKind, 'udot-open-data');
  assert.equal(source.license, 'Public UDOT traffic camera');
});

test('unknown roadway and direction fall back to the location and the id hash', () => {
  const source = udotCameraToSource(
    row({
      Id: 112731,
      Roadway: 'Unknown',
      Direction: 'Unknown',
      Location: 'Freedom Blvd / 200 W @ 1100 N, PVO',
    }),
  );
  assert.equal(source.city, 'Freedom Blvd / 200 W @ 1100 N, PVO');
  assert.equal(source.name, 'Freedom Blvd / 200 W @ 1100 N, PVO');
  assert.equal(source.headingConfidence, 'low');
  assert.ok(Number.isFinite(source.headingDeg));
  assert.equal(source.headingDeg % 22.5, 0, 'the shared id-hash fallback');
  // Nothing at all to name it by.
  assert.equal(
    udotCameraToSource(row({ Roadway: '', Location: '' })).name,
    'UDOT 165266',
  );
  assert.equal(
    udotCameraToSource(row({ Roadway: '', Location: '' })).city,
    'Utah',
  );
  // A view description rides along on the label.
  assert.equal(
    udotCameraToSource(
      row({}, [
        {
          Url: 'https://www.udottraffic.utah.gov/map/Cctv/165266',
          Status: 'Enabled',
          Description: 'Looking north',
        },
      ]),
    ).name,
    'SR-51 @ 1600 S, SPV - Looking north',
  );
});

test('cameras outside the Utah bounding box are dropped', () => {
  // Denver: plausible coordinates, but east of the box.
  assert.equal(
    udotCameraToSource(row({ Latitude: 39.7392, Longitude: -104.9903 })),
    null,
  );
  // Las Vegas: just west of the box.
  assert.equal(
    udotCameraToSource(row({ Latitude: 36.1699, Longitude: -115.1398 })),
    null,
  );
  assert.equal(udotCameraToSource(row({ Latitude: 'n/a' })), null);
  assert.equal(udotCameraToSource(row({ Longitude: null })), null);
  // The four corners of the box itself are in.
  assert.ok(udotCameraToSource(row({ Latitude: 36.9, Longitude: -114.1 })));
  assert.ok(udotCameraToSource(row({ Latitude: 42.1, Longitude: -109.0 })));
});

test('disabled views are skipped and the first enabled on-host view wins', () => {
  const disabled = {
    Url: 'https://www.udottraffic.utah.gov/map/Cctv/165266',
    Status: 'Disabled',
    Description: '',
  };
  assert.equal(udotCameraToSource(row({}, [disabled])), null);
  assert.equal(udotCameraToSource(row({}, [])), null);
  assert.equal(udotCameraToSource(row({ Views: undefined })), null);
  const picked = udotCameraToSource(
    row({}, [
      disabled,
      {
        Url: 'https://www.udottraffic.utah.gov/map/Cctv/900001',
        Status: 'Enabled',
      },
      {
        Url: 'https://www.udottraffic.utah.gov/map/Cctv/900002',
        Status: 'Enabled',
      },
    ]),
  );
  assert.equal(picked.url, `${UDOT_IMAGE_ORIGIN}900001`);
});

test('off-host, off-path and malformed view URLs never reach the frame proxy', () => {
  const view = (Url) => [{ Url, Status: 'Enabled', Description: '' }];
  for (const bad of [
    'https://evil.test/map/Cctv/165266',
    'http://www.udottraffic.utah.gov/map/Cctv/165266',
    'https://user:pw@www.udottraffic.utah.gov/map/Cctv/165266',
    'https://www.udottraffic.utah.gov/api/v2/get/cameras',
    'https://www.udottraffic.utah.gov/map/Cctv/165266/extra',
    'https://www.udottraffic.utah.gov/map/Cctv/..%2F..%2Fx',
    'not a url',
    '',
  ]) {
    assert.equal(udotCameraToSource(row({}, view(bad))), null, bad);
  }
  // The bare host is the same agency and is accepted, but the frame URL is
  // always REBUILT on the canonical origin from the view id alone: a query
  // string or fragment in the catalog never reaches the frame proxy.
  assert.equal(
    udotCameraToSource(
      row({}, view('https://udottraffic.utah.gov/map/Cctv/165266?x=1#f')),
    ).url,
    `${UDOT_IMAGE_ORIGIN}165266`,
  );
  assert.equal(udotCameraToSource(row({ Id: '../x' })), null);
  assert.equal(udotCameraToSource(null), null);
});

test('without UDOT_API_KEY the pack is skipped without a request', async (t) => {
  await withEnv({}, async () => {
    t.mock.method(console, 'log', () => {});
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('must not be called');
    });
    assert.deepEqual(await loadUdotSourcesFromOpenData(), []);
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

test('the loader sends the key once, dedupes, prioritizes, and degrades to an empty pack', async (t) => {
  await withEnv({ UDOT_API_KEY: FAKE_KEY }, async () => {
    const logged = [];
    t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
    t.mock.method(console, 'warn', (...args) => logged.push(args.join(' ')));
    const requested = [];
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(String(url));
      return Response.json([
        // Far from every anchor (St. George).
        row({ Id: 1, Latitude: 37.0965, Longitude: -113.5684 }),
        row({ Id: 1, Latitude: 37.0965, Longitude: -113.5684 }),
        // Downtown Salt Lake City.
        row({ Id: 2, Latitude: 40.7608, Longitude: -111.891 }),
        // Disabled: dropped before the cap.
        row({ Id: 3 }, [
          {
            Url: 'https://www.udottraffic.utah.gov/map/Cctv/3',
            Status: 'Disabled',
          },
        ]),
      ]);
    });
    const cameras = await loadUdotSourcesFromOpenData();
    assert.equal(requested.length, 1, 'one catalog call, never one per camera');
    const sent = new URL(requested[0]);
    assert.equal(
      `${sent.origin}${sent.pathname}`,
      `${new URL(UDOT_CAMERAS_URL).origin}${new URL(UDOT_CAMERAS_URL).pathname}`,
    );
    assert.equal(sent.searchParams.get('key'), FAKE_KEY);
    assert.equal(sent.searchParams.get('format'), 'json');
    // Nearest-to-anchor first: Salt Lake City leads; the duplicate collapsed.
    assert.deepEqual(
      cameras.map((c) => c.id),
      ['udot-2', 'udot-1'],
    );
    assert.ok(
      logged.every((line) => !line.includes(FAKE_KEY)),
      'the key must never be logged',
    );

    fetchMock.mock.mockImplementation(
      async () => new Response('nope', { status: 503 }),
    );
    assert.deepEqual(await loadUdotSourcesFromOpenData(), []);
    fetchMock.mock.mockImplementation(async () => {
      throw new Error(`offline ${FAKE_KEY}`);
    });
    assert.deepEqual(await loadUdotSourcesFromOpenData(), []);
    fetchMock.mock.mockImplementation(async () =>
      Response.json({ not: 'a list' }),
    );
    assert.deepEqual(await loadUdotSourcesFromOpenData(), []);
  });
});

test('CCTV_UDOT_MAX_SOURCES caps the pack nearest the anchors', async (t) => {
  await withEnv(
    { UDOT_API_KEY: FAKE_KEY, CCTV_UDOT_MAX_SOURCES: '8' },
    async () => {
      t.mock.method(console, 'log', () => {});
      t.mock.method(globalThis, 'fetch', async () =>
        Response.json(
          Array.from({ length: 12 }, (_, i) =>
            // Spread north from Provo along the valley; the farthest get trimmed.
            row({
              Id: 100 + i,
              Latitude: 40.2338 + i * 0.05,
              Longitude: -111.6585,
            }),
          ),
        ),
      );
      const cameras = await loadUdotSourcesFromOpenData();
      assert.equal(cameras.length, 8);
      assert.equal(
        cameras[0].id,
        'udot-100',
        'the camera at the Provo anchor leads',
      );
    },
  );
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.startsWith(UDOT_CAMERAS_URL.split('?')[0])) {
      return Response.json([row()]);
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const udotRequested = (requested) =>
  requested.some((href) => href.startsWith(UDOT_CAMERAS_URL.split('?')[0]));

test('the UDOT lane is wired into the catalog when a key is present', async (t) => {
  await withEnv({ UDOT_API_KEY: FAKE_KEY }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(udotRequested(requested));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'utah').map((s) => s.id),
      ['udot-165266'],
    );
    const served = sources.find((s) => s.id === 'udot-165266');
    assert.equal(served.pack, 'udot');
    assert.equal(served.feedType, 'image');
  });
});

test('CCTV_UDOT_ENABLED=0 keeps the lane from being loaded', async (t) => {
  await withEnv(
    { UDOT_API_KEY: FAKE_KEY, CCTV_UDOT_ENABLED: '0' },
    async () => {
      const { requested, sources } = await runCatalog(t);
      assert.equal(udotRequested(requested), false);
      assert.deepEqual(
        sources.filter((s) => s.cityId === 'utah'),
        [],
      );
    },
  );
});

test('a keyless install still serves every other pack', async (t) => {
  await withEnv({}, async () => {
    const { requested } = await runCatalog(t);
    assert.equal(
      udotRequested(requested),
      false,
      'no upstream call without a key',
    );
    assert.ok(requested.length > 0, 'the keyless packs still refresh');
  });
});
