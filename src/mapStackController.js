import { MapSourceController } from './maps/controller.js';
import { createDefaultMapSources } from './maps/defaultSources.js';
import { governorRequestRender } from './renderGovernor.js';
import { normalizeGibsDate } from './maps/gibsDate.js';
export { MAP_STACKS } from './maps/catalog.js';
export { photorealUnavailableReason } from './maps/availability.js';
export {
  EOX_S2CLOUDLESS_MAX_LEVEL,
  EOX_S2CLOUDLESS_URL,
  EOX_S2CLOUDLESS_YEAR,
  GIBS_VIIRS_MAX_LEVEL,
  GIBS_VIIRS_URL,
} from './maps/imagery.js';
export {
  GIBS_VIIRS_FIRST_DATE,
  gibsDateBounds,
  gibsDefaultDate,
  normalizeGibsDate,
} from './maps/gibsDate.js';

/** Preserve the standalone entry point; applications can compose the source controller directly. */
export class MapStackController extends MapSourceController {
  constructor(viewer, options = {}) {
    const googleApiKey =
      typeof window !== 'undefined' ? window.__GOOGLE_MAPS_API_KEY__ : '';
    const registry = createDefaultMapSources({ ...options, googleApiKey });
    super(viewer, {
      registry,
      initialStack: options.googleTileset
        ? options.initialStack || 'photoreal'
        : registry.defaultId,
      ...options,
      requestRender: governorRequestRender,
    });
    this.googleTileset = options.googleTileset || null;
    this.cesiumToken = String(options.cesiumToken || '').trim();
  }
  _hasPhotorealCredentials() {
    const googleKey =
      typeof window !== 'undefined' ? window.__GOOGLE_MAPS_API_KEY__ : '';
    return (
      Boolean(String(googleKey || '').trim()) ||
      Boolean(String(this.cesiumToken || '').trim())
    );
  }

  /** The day the VIIRS stack is rendering. @returns {string} `YYYY-MM-DD`. */
  getGibsDate() {
    return this._registry.gibsDate;
  }

  /**
   * Point the VIIRS stack at another day.
   *
   * The cached provider for that stack is retired (its URL has the date baked
   * in), and the globe is only re-activated when VIIRS is what is actually on
   * screen — picking a date while looking at Esri should arm the choice, not
   * hijack the view.
   * @param {string} date - Requested `YYYY-MM-DD`; clamped to the covered range.
   * @param {object} [options]
   * @param {boolean} [options.silent=false] - Suppress change emissions.
   * @returns {Promise<object>} Controller state.
   */
  async setGibsDate(date, { silent = false } = {}) {
    const normalized = normalizeGibsDate(date);
    if (normalized === this._registry.gibsDate) return this.getState();
    this._registry.setGibsDate(normalized);
    return this.reconfigureSource('gibs-viirs', { silent });
  }
}
