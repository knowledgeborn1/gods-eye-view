import { MAP_STACKS } from './catalog.js';
import { photorealUnavailableReason } from './availability.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
import {
  createOsmImagery,
  createEsriImagery,
  createIonImagery,
  createEoxS2CloudlessImagery,
  createGibsViirsImagery,
  ESRI_ATTRIBUTION_HTML,
} from './imagery.js';
import { createWorldTerrain, createKeylessTerrain } from './terrain.js';
import { gibsDefaultDate, normalizeGibsDate } from './gibsDate.js';

/** Select sources and setup guidance without putting provider branches in the controller. */
export function createDefaultMapSources({
  googleTileset = null,
  cesiumToken = '',
  googleApiKey = '',
  gibsDate = gibsDefaultDate(),
} = {}) {
  const ionToken = String(cesiumToken || '').trim();
  const hasIon = Boolean(ionToken);
  const hasGoogle = Boolean(String(googleApiKey || '').trim());
  const terrain = {
    id: hasIon ? 'world' : 'keyless',
    create: hasIon
      ? (request) => createWorldTerrain(ionToken, request)
      : createKeylessTerrain,
  };
  // The day the VIIRS stack renders. Held on the registry rather than in the
  // provider cache key, because it is one shared user choice, not a
  // per-provider variant: changing it retires the cached provider outright.
  let viirsDate = normalizeGibsDate(gibsDate);
  return {
    defaultId: googleTileset ? 'photoreal' : 'esri-imagery',
    unknownId: 'photoreal',
    recoveryId: googleTileset ? 'photoreal' : null,
    state: {
      hasCesiumIonToken: hasIon,
      get gibsDate() {
        return viirsDate;
      },
    },
    get gibsDate() {
      return viirsDate;
    },
    /** Clamp and store the VIIRS day; returns the day actually stored. */
    setGibsDate(date) {
      viirsDate = normalizeGibsDate(date);
      return viirsDate;
    },
    sources: MAP_STACKS.map((descriptor) => {
      const common = {
        descriptor,
        available: !descriptor.requiresIon || hasIon,
        unavailableReason: descriptor.requiresIon
          ? keySetupRequirement('cesium-ion')
          : null,
      };
      if (descriptor.kind === 'photoreal')
        return {
          ...common,
          available: Boolean(googleTileset),
          unavailableReason: photorealUnavailableReason(hasIon || hasGoogle),
          tileset: googleTileset,
        };
      const imagery =
        descriptor.kind === 'ion'
          ? () => createIonImagery(descriptor.style, ionToken)
          : descriptor.kind === 'eox-s2cloudless'
            ? createEoxS2CloudlessImagery
            : descriptor.kind === 'gibs-viirs'
              ? () => createGibsViirsImagery(viirsDate)
              : descriptor.id === 'osm'
                ? createOsmImagery
                : createEsriImagery;
      return {
        ...common,
        imagery,
        terrain,
        ...(descriptor.id === 'esri-imagery'
          ? {
              credit: ESRI_ATTRIBUTION_HTML,
              constructionFallback: {
                id: 'osm',
                message: 'Esri Satellite is unavailable; using OSM',
              },
              tileFailureFallback: {
                id: 'osm',
                threshold: 2,
                message: 'Esri Satellite tile requests failed; using OSM',
              },
            }
          : {}),
      };
    }),
  };
}
