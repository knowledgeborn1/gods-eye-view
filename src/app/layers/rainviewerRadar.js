import { createRainviewerRadarLayer } from '../../data/rainviewerRadar.js';

/**
 * Construct the keyless RainViewer precipitation-radar imagery layer. It is a
 * Data Layers toggle, separate from the WEATHER rail's NOAA MRMS radar.
 */
export function createApplicationRainviewerRadar() {
  return createRainviewerRadarLayer();
}
