import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { readShellSource } from './testSupport/readShellSource.mjs';
import { expandApplicationHtml } from '../build/application-html.js';
import {
  BLACK_MARBLE_MAX_LEVEL,
  BLACK_MARBLE_URL,
  CLOCK_RESYNC_MS,
  DayNightController,
  LIGHTING_INCOMPATIBLE_STYLES,
  SUN_OFFSET_LIMIT_HOURS,
  clampSunOffsetHours,
  isLightingCompatibleStyle,
  sunOffsetLabel,
} from './dayNight.js';

const ui = readShellSource();
const html = expandApplicationHtml(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));

/** 2026-09-20T12:00:00Z — a fixed clock so offsets are checkable arithmetic. */
const NOW = Date.UTC(2026, 8, 20, 12);

/** Minimal viewer stand-in: the globe flags, an imagery list and a clock. */
function fakeViewer() {
  const layers = [];
  return {
    scene: {
      globe: {
        enableLighting: false,
        dynamicAtmosphereLighting: true,
        dynamicAtmosphereLightingFromSun: false,
      },
    },
    clock: { currentTime: Cesium.JulianDate.fromDate(new Date(NOW)) },
    imageryLayers: {
      length: 0,
      add: (layer) => { layers.push(layer); },
      remove: (layer) => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      },
      _layers: layers,
    },
  };
}

const controllerFor = (viewer, options = {}) => new DayNightController(viewer, {
  now: () => NOW,
  ...options,
});

test('SUN sets exactly the three lighting flags the terminator needs', () => {
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(viewer.scene.globe.dynamicAtmosphereLighting, true);
  assert.equal(viewer.scene.globe.dynamicAtmosphereLightingFromSun, true);
});

test('turning SUN off restores the scene\'s own lighting defaults, not hardcoded false', () => {
  // Composability: another feature may legitimately light the globe, and this
  // controller must hand back what it found rather than what it assumed.
  const viewer = fakeViewer();
  viewer.scene.globe.enableLighting = true;
  viewer.scene.globe.dynamicAtmosphereLighting = false;
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  sun.setEnabled(false);
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(viewer.scene.globe.dynamicAtmosphereLighting, false);
  assert.equal(viewer.scene.globe.dynamicAtmosphereLightingFromSun, false);
});

test('styles that black out under lighting suspend it, and the SUN intent survives', () => {
  // NVG and FLIR see what the eye cannot — that is the reason to use them.
  // An unlit night side feeds both a black frame their shaders cannot
  // recover signal from. Noir earns its place by measurement, not theory:
  // its contrast+vignette grade puts the whole night-side frame under
  // luminance 25/255 (peak), i.e. a black screen. See dayNight.js.
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);

  for (const sensor of ['surveillance', 'thermal', 'noir']) {
    sun.setActiveStyle(sensor);
    assert.equal(viewer.scene.globe.enableLighting, false, `${sensor} must suspend lighting`);
    // The toggle is still ON: the user never turned it off.
    assert.equal(sun.enabled, true);
    assert.equal(sun.lightingActive, false);
    assert.equal(sun.getState().suspendedByStyle, sensor);

    sun.setActiveStyle('normal');
    assert.equal(viewer.scene.globe.enableLighting, true, `leaving ${sensor} must restore lighting`);
    assert.equal(sun.getState().suspendedByStyle, null);
  }
});

test('CRT and Snow keep their lighting — they treat a lit scene, they do not replace it', () => {
  // Measured on the night side: CRT keeps 96% of its pixels above 24/255 with
  // lighting on and Snow keeps 100%, against Noir's 0%. Both are image
  // treatments of a lit scene, so the terminator improves them.
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  for (const style of ['retro', 'snow', 'anime', 'normal']) {
    sun.setActiveStyle(style);
    assert.equal(isLightingCompatibleStyle(style), true, `${style} should keep lighting`);
    assert.equal(viewer.scene.globe.enableLighting, true, `${style} lost its lighting`);
  }
  assert.deepEqual([...LIGHTING_INCOMPATIBLE_STYLES].sort(), ['noir', 'surveillance', 'thermal']);
});

test('a style switch while SUN is OFF never turns lighting on', () => {
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setActiveStyle('thermal');
  sun.setActiveStyle('normal');
  assert.equal(viewer.scene.globe.enableLighting, false);
  assert.equal(sun.lightingActive, false);
});

test('city lights ride the night side only, and never exist without lighting', () => {
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  // dayAlpha/nightAlpha are only honored while the globe is lit — without
  // lighting this layer would paint the 2016 night mosaic over daylight.
  assert.equal(viewer.imageryLayers._layers.length, 0);
  sun.setEnabled(true);
  assert.equal(viewer.imageryLayers._layers.length, 1);
  const layer = viewer.imageryLayers._layers[0];
  assert.equal(layer.dayAlpha, 0);
  assert.equal(layer.nightAlpha, 1);

  // Suspended by a sensor sim → the layer goes with the lighting.
  sun.setActiveStyle('thermal');
  assert.equal(viewer.imageryLayers._layers.length, 0);
  sun.setActiveStyle('normal');
  assert.equal(viewer.imageryLayers._layers.length, 1);

  sun.setCityLights(false);
  assert.equal(viewer.imageryLayers._layers.length, 0);
  sun.setCityLights(true);
  assert.equal(viewer.imageryLayers._layers.length, 1);
  sun.setEnabled(false);
  assert.equal(viewer.imageryLayers._layers.length, 0);
});

test('the Black Marble source is the fixed 2016 composite at its real level cap', () => {
  // It is a once-produced global mosaic, not a daily product, so the date is
  // a constant and must not be wired to the VIIRS date control.
  assert.equal(
    BLACK_MARBLE_URL,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble'
    + '/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  );
  assert.equal(BLACK_MARBLE_MAX_LEVEL, 8);
});

test('the scrubber drives the app clock and LIVE hands it back', () => {
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  const secondsFromNow = () => Cesium.JulianDate.secondsDifference(
    viewer.clock.currentTime,
    Cesium.JulianDate.fromDate(new Date(NOW)),
  );
  assert.equal(Math.round(secondsFromNow()), 0);

  sun.setOffsetHours(6);
  assert.equal(Math.round(secondsFromNow()), 6 * 3600);
  sun.setOffsetHours(-3.5);
  assert.equal(Math.round(secondsFromNow()), -3.5 * 3600);

  sun.goLive();
  assert.equal(Math.round(secondsFromNow()), 0);
  assert.equal(sun.getState().offsetHours, 0);
});

test('turning SUN off hands the clock back to real time', () => {
  // Nothing else that samples viewer.clock may inherit a 12-hour shift from
  // a feature the user has switched off.
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  sun.setOffsetHours(12);
  sun.setEnabled(false);
  assert.equal(
    Math.round(Cesium.JulianDate.secondsDifference(
      viewer.clock.currentTime,
      Cesium.JulianDate.fromDate(new Date(NOW)),
    )),
    0,
  );
  // The offset itself is remembered, so re-enabling returns to where the
  // user left the sun rather than snapping to live.
  assert.equal(sun.getState().offsetHours, 12);
});

test('offsets are clamped to the advertised ±12 hours', () => {
  assert.equal(SUN_OFFSET_LIMIT_HOURS, 12);
  assert.equal(clampSunOffsetHours(99), 12);
  assert.equal(clampSunOffsetHours(-99), -12);
  assert.equal(clampSunOffsetHours(3.25), 3.25);
  for (const junk of [NaN, Infinity, -Infinity, 'soon', null, undefined, {}]) {
    assert.equal(clampSunOffsetHours(junk), 0, `should neutralize: ${String(junk)}`);
  }
});

test('the scrubber readout names the offset, and zero reads as LIVE', () => {
  assert.equal(sunOffsetLabel(0), 'LIVE');
  assert.equal(sunOffsetLabel(3), '+3h');
  assert.equal(sunOffsetLabel(-3), '-3h');
  assert.equal(sunOffsetLabel(0.75), '+45m');
  assert.equal(sunOffsetLabel(-0.25), '-15m');
  assert.equal(sunOffsetLabel(2.5), '+2h 30m');
  assert.equal(sunOffsetLabel(-2.5), '-2h 30m');
  assert.equal(sunOffsetLabel(99), '+12h');
});

test('the clock is stepped on a slow timer, never animated per frame', () => {
  // `clock.shouldAnimate = true` would re-render every frame forever, which
  // is exactly what the render governor exists to prevent. The terminator
  // moves 15°/hour, so a 30 s step is invisible and costs one render.
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  assert.equal(viewer.clock.shouldAnimate, undefined, 'the controller must not animate the clock');
  assert.equal(CLOCK_RESYNC_MS, 30_000);
  // The module header discusses `shouldAnimate` deliberately, so the guard is
  // on ASSIGNING it (and on taking a continuous-render hold), not on the word.
  const source = readFileSync(new URL('./dayNight.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /shouldAnimate\s*=/);
  assert.doesNotMatch(source, /holdContinuousRender\s*\(/);
  sun.destroy();
});

test('destroy releases the resync timer and the lighting it applied', () => {
  const viewer = fakeViewer();
  const sun = controllerFor(viewer);
  sun.setEnabled(true);
  sun.destroy();
  assert.equal(viewer.scene.globe.enableLighting, false);
  assert.equal(viewer.imageryLayers._layers.length, 0);
});

// ── UI wiring ───────────────────────────────────────────────────────────────

test('the SUN block ships in the DISPLAY rail with a scrubber and a LIVE button', () => {
  assert.match(
    html,
    /id="pp-toggles"[\s\S]*?id="sun-toggle"[\s\S]*?id="sun-time-slider"[\s\S]*?id="sun-time-value"[\s\S]*?id="sun-live-btn"[\s\S]*?id="sun-city-lights"/,
  );
  // ±12 h expressed in minutes at 15-minute steps, starting live.
  assert.match(html, /id="sun-time-slider"[^>]*min="-720"[^>]*max="720"[^>]*step="15"[^>]*value="0"/);
  assert.match(html, /id="sun-time-value"[^>]*>LIVE</);
});

test('the SUN control paints from controller state, never from the click', () => {
  // Same rule the map-source chips follow: a suspended or clamped result must
  // be what the UI shows, or the toggle lies about what is on screen.
  const start = ui.indexOf('  _renderDayNightState(state) {');
  assert.ok(start > 0, '_renderDayNightState is missing');
  const body = ui.slice(start, ui.indexOf('\n  }', start));
  assert.match(body, /this\._sunBtn\?\.classList\.toggle\('active', state\.enabled\)/);
  assert.match(body, /state\.suspendedByStyle/);
  assert.match(body, /this\._sunTimeValue\.textContent = sunOffsetLabel\(state\.offsetHours\)/);
  assert.match(body, /this\._sunTimeSlider\.value = String\(Math\.round\(state\.offsetHours \* 60\)\)/);
  // Every style change reaches the controller, or lighting would never be
  // suspended for the sensor sims nor restored on the way out.
  assert.match(ui, /this\._renderDayNightState\(this\.dayNight\.setActiveStyle\(styleName\)\)/);
});
