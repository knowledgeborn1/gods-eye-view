import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';

/**
 * Day/night: real-sun globe lighting, NASA Black Marble city lights on the
 * night side, and a ±12 h scrubber that drives the app clock so the
 * terminator can be dragged across the planet.
 *
 * ── Why the clock is stepped, not animated ──────────────────────────────────
 * Cesium derives both the sun direction and `dynamicAtmosphereLightingFromSun`
 * from `frameState.time`, i.e. `viewer.clock.currentTime` — so moving the
 * terminator means moving the clock. The obvious way to keep it live is to
 * let Cesium animate the clock, but that re-renders the scene every frame
 * forever, which is exactly what this app's render governor exists to avoid.
 * The terminator sweeps 15°/hour: over a 30-second resync it moves 0.125°,
 * far below one pixel at any sane zoom. So the clock is STEPPED on a slow
 * timer and one render is requested — live to the eye, idle to the GPU.
 *
 * ── What moving the clock does NOT move ─────────────────────────────────────
 * The shipped layers that read `viewer.clock.currentTime` only sample entity
 * properties with it, and the time-varying ones (aircraft position, heading,
 * trail head) are `CallbackProperty`s that ignore the sampled time and
 * dead-reckon from wall-clock internally. Satellites propagate from their own
 * beat, not this clock. So a ±12 h scrub moves the sun and nothing else.
 */

/** Furthest the scrubber can travel from now, in either direction. */
export const SUN_OFFSET_LIMIT_HOURS = 12;

/** Scrubber granularity, in minutes — fine enough to park a sunrise. */
export const SUN_OFFSET_STEP_MINUTES = 15;

/** How often the clock is re-pinned to (now + offset). See the module header. */
export const CLOCK_RESYNC_MS = 30_000;

/**
 * NASA Black Marble. The composite is a fixed 2016 epoch — it is a
 * once-produced global night-lights mosaic, not a daily product, so the date
 * is a constant rather than something the VIIRS date control should drive.
 */
export const BLACK_MARBLE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble' +
  '/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

/** `Level8` is literal, exactly as with the daily VIIRS stack. */
export const BLACK_MARBLE_MAX_LEVEL = 8;

export const BLACK_MARBLE_CREDIT = 'NASA GIBS / Worldview — VIIRS Black Marble';

/**
 * Styles that genuinely fight globe lighting.
 *
 * NVG and FLIR are SENSOR simulations: an image intensifier and a thermal
 * camera both see a scene the naked eye cannot, which is the entire reason to
 * switch to them. Lighting the globe makes the night side render near-black
 * BEFORE the shader runs, and neither post-process can recover signal that is
 * not in its input — NVG's gain multiplies zero, FLIR maps zero luminance to
 * the cold end of its palette. The result is a black screen where the sensor
 * sim should be at its most useful.
 *
 * NOIR is here for a measured reason rather than an assumed one. Its grade is
 * a contrast push plus a vignette, and on an already-dim night side that curve
 * lands the WHOLE frame in the black. Sampled over the rendered canvas on the
 * night side (Esri globe, street level over Austin at 02:16 local):
 *
 *   style   lighting off → on   p99 luminance   pixels above 24/255
 *   noir                        254 →  20.9     69% →   0%
 *   retro (CRT)                 203 → 100.4     94% →  96%
 *   snow                        238 → 109.2    100% → 100%
 *   normal                      246 →  76.0     97% → 100%
 *
 * Noir's peak output is 25/255 — a black screen, confirmed on screenshots.
 * CRT and Snow keep essentially all of their visible pixels, so they stay out
 * of this set: they treat a lit scene rather than replacing it, and the
 * terminator makes both look better.
 */
export const LIGHTING_INCOMPATIBLE_STYLES = Object.freeze(
  new Set(['surveillance', 'thermal', 'noir']),
);

/**
 * Whether globe lighting may be applied while `styleName` is active.
 * @param {string|null|undefined} styleName - StyleManager style id.
 * @returns {boolean}
 */
export function isLightingCompatibleStyle(styleName) {
  return !LIGHTING_INCOMPATIBLE_STYLES.has(String(styleName || ''));
}

/**
 * Clamp a scrubber position to the supported window.
 * @param {unknown} hours - Requested offset from now, in hours.
 * @returns {number} Offset within ±SUN_OFFSET_LIMIT_HOURS; 0 for junk input.
 */
export function clampSunOffsetHours(hours) {
  const numeric = Number(hours);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(
    -SUN_OFFSET_LIMIT_HOURS,
    Math.min(SUN_OFFSET_LIMIT_HOURS, numeric),
  );
}

/**
 * Readout for the scrubber.
 * @param {number} hours - Offset from now, in hours.
 * @returns {string} `LIVE`, `+3h`, `-45m`, `+2h 30m`.
 */
export function sunOffsetLabel(hours) {
  const clamped = clampSunOffsetHours(hours);
  const totalMinutes = Math.round(clamped * 60);
  if (totalMinutes === 0) return 'LIVE';
  const sign = totalMinutes > 0 ? '+' : '-';
  const magnitude = Math.abs(totalMinutes);
  const wholeHours = Math.floor(magnitude / 60);
  const minutes = magnitude % 60;
  if (wholeHours === 0) return `${sign}${minutes}m`;
  if (minutes === 0) return `${sign}${wholeHours}h`;
  return `${sign}${wholeHours}h ${minutes}m`;
}

/**
 * Owns the lighting flags, the city-lights layer and the clock offset.
 *
 * The user's SUN intent is LATCHED independently of whether lighting is
 * currently applied: switching to FLIR suspends the lighting but remembers
 * that SUN is on, so leaving FLIR restores it. Without that the toggle would
 * silently turn itself off whenever someone looked through a sensor.
 */
export class DayNightController {
  constructor(viewer, { activeStyle = 'normal', now = () => Date.now() } = {}) {
    this.viewer = viewer;
    this._now = now;
    this._enabled = false;
    this._cityLights = true;
    this._offsetHours = 0;
    this._activeStyle = activeStyle;
    this._cityLightsLayer = null;
    this._resyncTimer = null;
    const globe = viewer?.scene?.globe;
    // Restoring the scene's own defaults on disable, rather than assuming
    // they were false, keeps this controller composable with anything else
    // that might light the globe.
    this._restoreLighting = {
      enableLighting: globe?.enableLighting ?? false,
      dynamicAtmosphereLighting: globe?.dynamicAtmosphereLighting ?? true,
      dynamicAtmosphereLightingFromSun:
        globe?.dynamicAtmosphereLightingFromSun ?? false,
    };
  }

  /** @returns {boolean} The user's SUN intent, regardless of style suspension. */
  get enabled() {
    return this._enabled;
  }

  /** @returns {boolean} Whether lighting is actually applied right now. */
  get lightingActive() {
    return this._enabled && isLightingCompatibleStyle(this._activeStyle);
  }

  getState() {
    return {
      enabled: this._enabled,
      cityLights: this._cityLights,
      offsetHours: this._offsetHours,
      lightingActive: this.lightingActive,
      suspendedByStyle:
        this._enabled && !this.lightingActive ? this._activeStyle : null,
    };
  }

  /** Turn the day/night treatment on or off. */
  setEnabled(enabled) {
    this._enabled = enabled === true;
    this._apply();
    return this.getState();
  }

  /** Show or hide the Black Marble city lights (inert while SUN is off). */
  setCityLights(enabled) {
    this._cityLights = enabled === true;
    this._apply();
    return this.getState();
  }

  /** Move the sun: hours from now, clamped to ±12. */
  setOffsetHours(hours) {
    this._offsetHours = clampSunOffsetHours(hours);
    this._apply();
    return this.getState();
  }

  /** Snap back to following real time. */
  goLive() {
    return this.setOffsetHours(0);
  }

  /**
   * Tell the controller which visual style is active, so lighting can be
   * suspended for the sensor sims and restored afterwards.
   * @param {string} styleName - StyleManager style id.
   */
  setActiveStyle(styleName) {
    this._activeStyle = String(styleName || 'normal');
    this._apply();
    return this.getState();
  }

  /** Reconcile scene state with the current intent. Idempotent. */
  _apply() {
    const globe = this.viewer?.scene?.globe;
    if (!globe) return;
    const active = this.lightingActive;
    if (active) {
      globe.enableLighting = true;
      globe.dynamicAtmosphereLighting = true;
      globe.dynamicAtmosphereLightingFromSun = true;
    } else {
      globe.enableLighting = this._restoreLighting.enableLighting;
      globe.dynamicAtmosphereLighting =
        this._restoreLighting.dynamicAtmosphereLighting;
      globe.dynamicAtmosphereLightingFromSun =
        this._restoreLighting.dynamicAtmosphereLightingFromSun;
    }
    this._syncCityLightsLayer(active);
    this._syncClockTimer(active);
    this._writeClock(active);
    governorRequestRender('day-night');
  }

  _syncCityLightsLayer(active) {
    // dayAlpha/nightAlpha are only honored while the globe is lit, so the
    // layer is not merely pointless without lighting — it would paint the
    // 2016 night mosaic straight over the daylit basemap.
    const wanted = active && this._cityLights;
    if (wanted === Boolean(this._cityLightsLayer)) return;
    if (!wanted) {
      this.viewer.imageryLayers.remove(this._cityLightsLayer, true);
      this._cityLightsLayer = null;
      return;
    }
    this._cityLightsLayer = new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: BLACK_MARBLE_URL,
        maximumLevel: BLACK_MARBLE_MAX_LEVEL,
        enablePickFeatures: false,
        credit: BLACK_MARBLE_CREDIT,
      }),
    );
    this._cityLightsLayer.dayAlpha = 0;
    this._cityLightsLayer.nightAlpha = 1;
    this.viewer.imageryLayers.add(this._cityLightsLayer);
  }

  _syncClockTimer(active) {
    if (active && this._resyncTimer === null) {
      this._resyncTimer = setInterval(
        () => this._writeClock(true),
        CLOCK_RESYNC_MS,
      );
      this._resyncTimer?.unref?.();
      return;
    }
    if (!active && this._resyncTimer !== null) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }
  }

  /**
   * Pin the app clock to (real now + offset), or hand it back to real time.
   *
   * Handing it back on disable matters: anything else that samples
   * `viewer.clock.currentTime` must never inherit a 12-hour shift from a
   * feature the user has switched off.
   */
  _writeClock(active) {
    const clock = this.viewer?.clock;
    if (!clock) return;
    const offsetSeconds = active ? this._offsetHours * 3600 : 0;
    const base = Cesium.JulianDate.fromDate(new Date(this._now()));
    clock.currentTime = Cesium.JulianDate.addSeconds(
      base,
      offsetSeconds,
      new Cesium.JulianDate(),
    );
    governorRequestRender('day-night-clock');
  }

  destroy() {
    this._enabled = false;
    this._apply();
    if (this._resyncTimer !== null) clearInterval(this._resyncTimer);
    this._resyncTimer = null;
  }
}
