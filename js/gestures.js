// gestures.js — Touch gestures for Honest Streaks.
//
// Two best-practice gestures, both accelerators layered over the existing
// tappable controls (bottom nav, sheet back button) — never the only path:
//
//   1. Horizontal swipe moves between the top-level tabs in their fixed order
//      (Today ↔ History ↔ Settings), content-follows-finger: a right-to-left
//      swipe brings the next view in from the right. No wrap-around at the ends.
//   2. A downward drag on the habit sheet dismisses it — the iOS
//      pull-to-dismiss idiom, and the "I opened the wrong habit, get me out"
//      affordance. Below the threshold it snaps back.
//
// DOM-driven, so it lives outside the pure test suite. Vanilla, no deps.

const TAB_ORDER = ['today', 'history', 'settings'];

// A gesture becomes horizontal (vs. a vertical scroll) once travel passes
// AXIS_LOCK and one axis clearly dominates.
const AXIS_LOCK = 10; // px of travel before we commit to an axis
const AXIS_RATIO = 1.3; // the dominant axis must exceed the other by this factor
const FLICK_MS = 300; // under this, a short fast swipe still commits
const FLICK_DIST = 40; // px: minimum travel for a flick to count

const SHEET_CURVE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // the design-system sheet curve

// A deliberate swipe covers ~22% of the axis, floored so small screens still
// demand a real drag rather than a twitch.
function commitDistance(span) {
  return Math.max(60, span * 0.22);
}

export function initGestures(opts) {
  initTabSwipe(opts);
  initSheetDismiss(opts);
}

function initTabSwipe({ root, canSwipeTabs, currentTab, goToTab }) {
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let tracking = false;
  let axis = null;

  root.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || !canSwipeTabs()) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      // Leave the iOS home-indicator / app-switcher band to the system.
      if (t.clientY > window.innerHeight - 20) {
        tracking = false;
        return;
      }
      if (e.target.closest('[data-no-swipe]')) {
        tracking = false;
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      startT = e.timeStamp;
      tracking = true;
      axis = null;
    },
    { passive: true }
  );

  root.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!axis && (Math.abs(dx) > AXIS_LOCK || Math.abs(dy) > AXIS_LOCK)) {
        axis = Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y';
        if (axis === 'y') tracking = false; // vertical intent → let the page scroll
      }
    },
    { passive: true }
  );

  root.addEventListener(
    'touchend',
    (e) => {
      if (!tracking || axis !== 'x') {
        tracking = false;
        return;
      }
      tracking = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const elapsed = e.timeStamp - startT;
      const far = Math.abs(dx) >= commitDistance(window.innerWidth);
      const flick = Math.abs(dx) >= FLICK_DIST && elapsed <= FLICK_MS;
      if (!far && !flick) return;
      const dir = dx < 0 ? 1 : -1; // swipe left → next tab to the right
      const from = TAB_ORDER.indexOf(currentTab());
      const to = from + dir;
      if (from < 0 || to < 0 || to >= TAB_ORDER.length) return; // no wrap-around
      goToTab(TAB_ORDER[to], dir);
    },
    { passive: true }
  );
}

function initSheetDismiss({ sheet }) {
  if (!sheet || !sheet.el) return;
  const el = sheet.el;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let startX = 0;
  let startY = 0;
  let startT = 0;
  let armed = false;
  let dragging = false;
  let axis = null;

  function clearInline() {
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
  }

  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || !sheet.isOpen()) {
        armed = false;
        return;
      }
      // Only from the top of the sheet, so we never fight its inner scroll.
      if (sheet.scroller && sheet.scroller.scrollTop > 0) {
        armed = false;
        return;
      }
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startT = e.timeStamp;
      armed = true;
      dragging = false;
      axis = null;
      el.style.transition = 'none';
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      if (!armed) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!axis && (Math.abs(dx) > AXIS_LOCK || Math.abs(dy) > AXIS_LOCK)) {
        axis = Math.abs(dy) > Math.abs(dx) * AXIS_RATIO ? 'y' : 'x';
        if (axis !== 'y') {
          armed = false; // horizontal intent → not a dismiss
          return;
        }
      }
      if (axis !== 'y') return;
      if (dy <= 0) {
        // Dragging back up past the start: pin to the top, don't lift the sheet.
        if (dragging) {
          el.style.transform = '';
          el.style.opacity = '';
        }
        return;
      }
      dragging = true;
      e.preventDefault(); // own the gesture now; block the page from scrolling
      el.style.transform = `translateY(${dy}px)`;
      el.style.opacity = String(Math.max(0.4, 1 - dy / (window.innerHeight * 1.6)));
    },
    { passive: false }
  );

  el.addEventListener(
    'touchend',
    (e) => {
      if (!armed && !dragging) return;
      armed = false;
      if (!dragging) {
        clearInline();
        return;
      }
      dragging = false;
      const dy = e.changedTouches[0].clientY - startY;
      const elapsed = e.timeStamp - startT;
      const far = dy >= Math.max(80, window.innerHeight * 0.28);
      const flick = dy >= FLICK_DIST && elapsed <= FLICK_MS;

      if (far || flick) {
        if (reduce) {
          clearInline();
          sheet.dismiss();
          return;
        }
        // Slide the rest of the way out, then hand off to the real dismissal.
        el.style.transition = `transform 180ms ${SHEET_CURVE}, opacity 180ms ease`;
        el.style.transform = `translateY(${window.innerHeight}px)`;
        el.style.opacity = '0';
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          el.removeEventListener('transitionend', finish);
          clearInline();
          sheet.dismiss();
        };
        el.addEventListener('transitionend', finish);
        setTimeout(finish, 260); // fallback if transitionend never fires
        return;
      }

      // Snap back.
      if (reduce) {
        clearInline();
        return;
      }
      el.style.transition = `transform 180ms ${SHEET_CURVE}, opacity 180ms ease`;
      el.style.transform = '';
      el.style.opacity = '';
    },
    { passive: true }
  );
}
