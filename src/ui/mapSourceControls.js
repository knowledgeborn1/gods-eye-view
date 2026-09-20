import { renderMapStackChips, syncMapStackChips } from '../mapStackChips.js';
import { gibsDateBounds, gibsDefaultDate } from '../maps/gibsDate.js';

/**
 * Own Map Source presentation and selection without constructing map providers.
 * The supplied controller remains authoritative for availability and active state.
 *
 * The optional VIIRS date control belongs to one stack and means nothing
 * without it, so it appears and disappears with that chip rather than sitting
 * permanently in the tray offering to re-date Esri. The input is the only
 * writer of the controller's date; the controller is the only source of the
 * displayed value, so a clamped request (a future day, a pre-mission day)
 * visibly snaps back to what is actually rendered.
 */
export function createMapSourceControls({
  container,
  statusElement,
  dateRow = null,
  dateInput = null,
  dateLatestButton = null,
  controller,
  subscribe,
  claimSelection = () => {},
  onStateChanged = () => {},
  onError = () => {},
}) {
  let destroyed = false;
  let generation = 0;
  const removers = [];
  const persistent = [];
  const bind = (element, type, listener, list = removers) => {
    element.addEventListener(type, listener);
    list.push(() => element.removeEventListener(type, listener));
  };
  function render(state) {
    if (destroyed || !state) return;
    syncMapStackChips(container, state.activeId);
    if (statusElement) {
      const stack = state.activeStack;
      statusElement.textContent =
        state.status === 'switching'
          ? '...'
          : stack?.shortLabel || stack?.label || 'MAP';
      statusElement.classList.toggle('warn', !!state.lastError);
    }
    if (dateRow) dateRow.hidden = state.activeId !== 'gibs-viirs';
    if (dateInput && state.gibsDate) dateInput.value = state.gibsDate;
  }
  async function select(stackId, { syncShare = true } = {}) {
    if (destroyed) return null;
    const current = ++generation;
    if (syncShare) claimSelection();
    const before = controller.getActiveId();
    render(controller.getState('switching'));
    let state;
    try {
      state = await controller.setStack(stackId);
    } catch (error) {
      if (!destroyed && current === generation) {
        render(controller.getState());
        onError(error?.message || String(error));
      }
      throw error;
    }
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    if (state?.activeId === before && stackId !== before && state?.lastError)
      onError(state.lastError);
    if (syncShare) onStateChanged();
    return state;
  }
  /** Apply a VIIRS date and re-sync both the control and the share link. */
  async function setDate(date) {
    if (destroyed || typeof controller.setGibsDate !== 'function') return null;
    const current = ++generation;
    claimSelection();
    const state = await controller.setGibsDate(date);
    if (destroyed || current !== generation) return state;
    render(controller.getState());
    onStateChanged();
    return state;
  }
  function refresh() {
    if (destroyed) return;
    for (const remove of removers.splice(0)) remove();
    renderMapStackChips(container, controller.getStacks(), {
      activeId: controller.getActiveId(),
      onSelect: (id) => {
        void select(id).catch(() => {});
      },
      bind,
    });
    render(controller.getState());
  }
  if (dateInput) {
    const bounds = gibsDateBounds();
    dateInput.min = bounds.min;
    dateInput.max = bounds.max;
    bind(
      dateInput,
      'change',
      () => {
        void setDate(dateInput.value).catch(() => {});
      },
      persistent,
    );
  }
  if (dateLatestButton)
    bind(
      dateLatestButton,
      'click',
      () => {
        void setDate(gibsDefaultDate()).catch(() => {});
      },
      persistent,
    );
  const unsubscribe = subscribe(() => {
    if (destroyed) return;
    render(controller.getState());
    onStateChanged();
  });
  refresh();
  return {
    render,
    select,
    setDate,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      unsubscribe?.();
      for (const remove of removers.splice(0)) remove();
      for (const remove of persistent.splice(0)) remove();
    },
  };
}
