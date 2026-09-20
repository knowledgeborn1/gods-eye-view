/** First day VIIRS/SNPP corrected-reflectance imagery exists in GIBS. */
export const GIBS_VIIRS_FIRST_DATE = '2015-11-24';

/** Format an epoch as a GIBS `YYYY-MM-DD` day key in UTC. */
function utcDateKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * The day the VIIRS stack opens on: YESTERDAY in UTC.
 *
 * Today's swath is still being flown and stitched, so a "today" mosaic is
 * reliably a half-black globe with a few fresh strips — which reads as a
 * broken layer rather than as the newest imagery on Earth. Yesterday is the
 * most recent COMPLETE day, so it is the honest default; the date control
 * lets anyone step forward to today deliberately.
 * @param {number} [nowMs=Date.now()] - Clock.
 * @returns {string} `YYYY-MM-DD`.
 */
export function gibsDefaultDate(nowMs = Date.now()) {
  return utcDateKey(nowMs - 86_400_000);
}

/**
 * The selectable range for the VIIRS date control, as `<input type="date">`
 * min/max. `max` is TODAY, not the default day: today's partial mosaic is a
 * legitimate thing to ask for deliberately, it is just a poor default.
 * @param {number} [nowMs=Date.now()] - Clock.
 * @returns {{min: string, max: string}} Inclusive `YYYY-MM-DD` bounds.
 */
export function gibsDateBounds(nowMs = Date.now()) {
  return { min: GIBS_VIIRS_FIRST_DATE, max: utcDateKey(nowMs) };
}

/**
 * Validate and clamp a requested GIBS date into the range that has imagery.
 *
 * A future date and a pre-mission date both return tiles that are empty or an
 * error, so they are clamped rather than passed through — a date control that
 * can render a blank globe is a bug report waiting to happen. Anything that is
 * not a `YYYY-MM-DD` calendar date falls back to the default day.
 * @param {unknown} value - Requested date.
 * @param {number} [nowMs=Date.now()] - Clock.
 * @returns {string} `YYYY-MM-DD` within [GIBS_VIIRS_FIRST_DATE, today UTC].
 */
export function normalizeGibsDate(value, nowMs = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return gibsDefaultDate(nowMs);
  const parsed = Date.parse(`${raw}T00:00:00Z`);
  // Rejects both unparseable text and calendar-invalid dates such as
  // 2026-02-31, which Date.parse accepts in some engines by rolling over.
  if (!Number.isFinite(parsed) || utcDateKey(parsed) !== raw)
    return gibsDefaultDate(nowMs);
  const today = utcDateKey(nowMs);
  if (raw > today) return today;
  if (raw < GIBS_VIIRS_FIRST_DATE) return GIBS_VIIRS_FIRST_DATE;
  return raw;
}
