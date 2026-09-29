/**
 * glassfx — real-refraction glassmorphism for any element.
 *
 * Importing this module (in the browser) does two things automatically:
 *   1. injects the shared SVG displacement filter (#glassfx-refract) used by
 *      `.glass-refract` for true backdrop lensing + chromatic dispersion;
 *   2. starts a single delegated pointer listener that drives the
 *      cursor-tracking bloom on every `.glass` element.
 *
 * Both steps are idempotent and SSR-safe (no-op when there is no document).
 * You can also call the named exports manually, e.g. after hydrating a SPA.
 *
 * The CSS ships separately — import "glassfx/glass.css" (bundler) or link it
 * from a CDN. See the README.
 *
 * @license MIT
 */

const FILTER_ID = "glassfx-refract";
const SVG_NS = "http://www.w3.org/2000/svg";

const isBrowser = typeof document !== "undefined";

/**
 * The displacement-lens filter, built from primitives (no feImage — Chromium
 * resolves feImage percentage subregions against the host SVG, not the filter
 * region). Blurring the backdrop's alpha gives an edge-distance ramp;
 * differencing two offset copies yields signed X/Y lens vectors in the map's
 * R/G channels — a neutral centre with a constant rim band that bends inward
 * on every surface. The backdrop is displaced three times at staggered
 * strengths (36/48/54) and the R/G/B channels recombined, so colours separate
 * at the edges (chromatic dispersion) like light through thick glass.
 *
 * Tunables, if you want to fork the look:
 *   - scale on the three feDisplacementMap nodes = refraction strength.
 *     Keep them centred on one mean for depth; spread them apart for more
 *     colour separation (here 42/48/54 → mean 48, gentle split).
 */
const FILTER_MARKUP = `
<filter id="${FILTER_ID}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
  <feGaussianBlur in="SourceAlpha" stdDeviation="16" result="soft"/>
  <feOffset in="soft" dx="8" dy="0" result="sxp"/>
  <feOffset in="soft" dx="-8" dy="0" result="sxn"/>
  <feComposite in="sxp" in2="sxn" operator="arithmetic" k1="0" k2="-2.5" k3="2.5" k4="0.5" result="gx"/>
  <feOffset in="soft" dx="0" dy="8" result="syp"/>
  <feOffset in="soft" dx="0" dy="-8" result="syn"/>
  <feComposite in="syp" in2="syn" operator="arithmetic" k1="0" k2="-2.5" k3="2.5" k4="0.5" result="gy"/>
  <feColorMatrix in="gx" type="matrix" values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="mx"/>
  <feColorMatrix in="gy" type="matrix" values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1" result="my"/>
  <feComposite in="mx" in2="my" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="base_map"/>
  <feComponentTransfer in="base_map" result="map">
    <feFuncR type="linear" slope="1.05" intercept="-0.025"/>
    <feFuncG type="linear" slope="1.05" intercept="-0.025"/>
  </feComponentTransfer>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="64" xChannelSelector="R" yChannelSelector="G" result="dispR"/>
  <feColorMatrix in="dispR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="onlyR"/>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="72" xChannelSelector="R" yChannelSelector="G" result="dispG"/>
  <feColorMatrix in="dispG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="onlyG"/>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="80" xChannelSelector="R" yChannelSelector="G" result="dispB"/>
  <feColorMatrix in="dispB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="onlyB"/>
  <feBlend in="onlyR" in2="onlyG" mode="screen" result="rg"/>
  <feBlend in="rg" in2="onlyB" mode="screen"/>
</filter>`;

/**
 * Inject the shared refraction filter once. Safe to call repeatedly.
 * @returns {boolean} true if the filter is present after the call.
 */
export function ensureFilter() {
  if (!isBrowser) return false;
  if (document.getElementById(FILTER_ID)) return true;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  svg.dataset.glassfx = "filter";
  svg.innerHTML = FILTER_MARKUP;

  const mount = () => document.body.appendChild(svg);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
  return true;
}

let trackerStarted = false;

/**
 * Start the cursor-tracking bloom. One delegated, rAF-throttled pointer
 * listener writes --glass-mx/--glass-my onto whichever `.glass` is hovered.
 * No-op on touch-only devices (the bloom is hover-gated in CSS) and idempotent.
 * @returns {() => void} a function that stops the tracker.
 */
export function initBloomTracker() {
  if (!isBrowser || trackerStarted) return () => {};
  if (!window.matchMedia || !window.matchMedia("(hover: hover)").matches) {
    return () => {};
  }
  trackerStarted = true;

  let raf = 0;
  let last = null;
  let activeEl = null;

  const onMove = (e) => {
    last = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = last;
      if (!ev) return;
      const target = ev.target;
      const el = target && target.closest ? target.closest(".glass") : null;
      
      if (el !== activeEl) {
        if (activeEl) {
          activeEl.style.removeProperty("--glass-angle");
        }
        activeEl = el;
      }

      if (!el) return;
      const r = el.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      el.style.setProperty("--glass-mx", `${mx}px`);
      el.style.setProperty("--glass-my", `${my}px`);

      // Calculate angle from center of card for dynamic light-tracking rim
      const cx = r.width / 2;
      const cy = r.height / 2;
      const angle = Math.round(Math.atan2(my - cy, mx - cx) * (180 / Math.PI)) + 270;
      el.style.setProperty("--glass-angle", `${angle}deg`);
    });
  };

  document.addEventListener("pointermove", onMove, { passive: true });
  return () => {
    document.removeEventListener("pointermove", onMove);
    if (raf) cancelAnimationFrame(raf);
    if (activeEl) {
      activeEl.style.removeProperty("--glass-angle");
    }
    trackerStarted = false;
  };
}

/**
 * Initialise everything (filter + bloom tracker + refraction tracker).
 * Returns a teardown function for all trackers. Called automatically on import in the browser.
 * @returns {() => void}
 */
export function init() {
  ensureFilter();
  const stopBloom = initBloomTracker();
  const stopRefract = initRefractionTracker();
  return () => {
    stopBloom();
    stopRefract();
  };
}

/**
 * Start 3D hover tilt tracking for a specific element.
 * Applies a lightweight CSS 3D perspective rotation based on pointer position.
 * @param {HTMLElement} el The glass element to tilt.
 * @returns {() => void} a teardown function.
 */
export function initTiltTracker(el) {
  if (!isBrowser || !window.matchMedia || !window.matchMedia("(hover: hover)").matches) {
    return () => {};
  }
  let raf = 0;

  const onMove = (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      
      const style = getComputedStyle(el);
      const maxStr = style.getPropertyValue("--glass-tilt-max").trim();
      const perspectiveStr = style.getPropertyValue("--glass-tilt-perspective").trim();

      const maxRot = maxStr ? parseFloat(maxStr) : 6;
      const perspective = perspectiveStr || "1000px";

      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Calculate rotation based on customized max angle
      const rotX = -((y - rect.height / 2) / (rect.height / 2)) * maxRot;
      const rotY = ((x - rect.width / 2) / (rect.width / 2)) * maxRot;

      el.style.transitionDuration = "0.1s";
      el.style.transitionProperty = "transform";
      el.style.transform = `perspective(${perspective}) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    });
  };

  const onLeave = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;

    const style = getComputedStyle(el);
    const perspective = style.getPropertyValue("--glass-tilt-perspective").trim() || "1000px";

    el.style.transitionDuration = "0.4s";
    el.style.transform = `perspective(${perspective}) rotateX(0deg) rotateY(0deg)`;

    setTimeout(() => {
      el.style.transform = "";
      el.style.transitionDuration = "";
      el.style.transitionProperty = "";
    }, 400);
  };

  el.addEventListener("pointermove", onMove, { passive: true });
  el.addEventListener("pointerleave", onLeave, { passive: true });

  return () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerleave", onLeave);
    if (raf) cancelAnimationFrame(raf);
  };
}

/**
 * Ensure a custom refraction filter is generated and injected.
 * @param {string} id Unique filter ID.
 * @param {number} strength Mean refraction strength (scale).
 * @param {number} dispersion Chromatic dispersion spread.
 */
function ensureCustomFilter(id, strength, dispersion) {
  if (!isBrowser || document.getElementById(id)) return;

  const r = strength - dispersion;
  const g = strength;
  const b = strength + dispersion;

  const markup = `
  <feGaussianBlur in="SourceAlpha" stdDeviation="16" result="soft"/>
  <feOffset in="soft" dx="8" dy="0" result="sxp"/>
  <feOffset in="soft" dx="-8" dy="0" result="sxn"/>
  <feComposite in="sxp" in2="sxn" operator="arithmetic" k1="0" k2="-2.5" k3="2.5" k4="0.5" result="gx"/>
  <feOffset in="soft" dx="0" dy="8" result="syp"/>
  <feOffset in="soft" dx="0" dy="-8" result="syn"/>
  <feComposite in="syp" in2="syn" operator="arithmetic" k1="0" k2="-2.5" k3="2.5" k4="0.5" result="gy"/>
  <feColorMatrix in="gx" type="matrix" values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="mx"/>
  <feColorMatrix in="gy" type="matrix" values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1" result="my"/>
  <feComposite in="mx" in2="my" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="base_map"/>
  <feComponentTransfer in="base_map" result="map">
    <feFuncR type="linear" slope="1.05" intercept="-0.025"/>
    <feFuncG type="linear" slope="1.05" intercept="-0.025"/>
  </feComponentTransfer>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="${r}" xChannelSelector="R" yChannelSelector="G" result="dispR"/>
  <feColorMatrix in="dispR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="onlyR"/>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="${g}" xChannelSelector="R" yChannelSelector="G" result="dispG"/>
  <feColorMatrix in="dispG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="onlyG"/>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="${b}" xChannelSelector="R" yChannelSelector="G" result="dispB"/>
  <feColorMatrix in="dispB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="onlyB"/>
  <feBlend in="onlyR" in2="onlyG" mode="screen" result="rg"/>
  <feBlend in="rg" in2="onlyB" mode="screen"/>`;

  let container = document.querySelector('svg[data-glassfx="filter"]');
  if (!container) {
    ensureFilter();
    container = document.querySelector('svg[data-glassfx="filter"]');
  }

  const filter = document.createElementNS(SVG_NS, "filter");
  filter.id = id;
  filter.setAttribute("x", "0");
  filter.setAttribute("y", "0");
  filter.setAttribute("width", "100%");
  filter.setAttribute("height", "100%");
  filter.setAttribute("color-interpolation-filters", "sRGB");
  filter.innerHTML = markup;

  if (container) {
    container.appendChild(filter);
  }
}

/**
 * Check custom variables on a .glass-refract element and dynamically apply a custom SVG filter.
 * @param {HTMLElement} el The glass element.
 */
export function updateElementRefraction(el) {
  if (!isBrowser || !el || !el.classList.contains("glass-refract")) return;

  const styleAttr = el.getAttribute("style") || "";
  const hasCustomVars = styleAttr.includes("--glass-refract-strength") || styleAttr.includes("--glass-refract-dispersion");

  // Fast path: skip expensive style recalculations if no variables are defined and default is active.
  if (!hasCustomVars && el.__lastStrength === 72 && el.__lastDispersion === 8) {
    return;
  }

  const style = getComputedStyle(el);
  const strengthStr = style.getPropertyValue("--glass-refract-strength").trim();
  const dispersionStr = style.getPropertyValue("--glass-refract-dispersion").trim();

  const strength = strengthStr ? parseFloat(strengthStr) : 72;
  const dispersion = dispersionStr ? parseFloat(dispersionStr) : 8;

  // Optimise layout/rendering: avoid redundant DOM/style changes if values haven't changed.
  if (el.__lastStrength === strength && el.__lastDispersion === dispersion) {
    return;
  }

  el.__lastStrength = strength;
  el.__lastDispersion = dispersion;

  if (strength === 72 && dispersion === 8) {
    el.style.removeProperty("--glass-refract-id");
    return;
  }

  const filterId = `glassfx-refract-${strength}-${dispersion}`;
  ensureCustomFilter(filterId, strength, dispersion);
  el.style.setProperty("--glass-refract-id", `url(#${filterId})`);
}

let refractionObserver = null;

/**
 * Watch for added or updated lensed glass elements and ensure they have custom filters applied.
 * @returns {() => void} stop observer teardown.
 */
export function initRefractionTracker() {
  if (!isBrowser) return () => {};
  if (refractionObserver) return () => {};

  // Initial scan on call
  const scan = () => {
    document.querySelectorAll(".glass-refract").forEach(updateElementRefraction);
  };
  
  if (document.body) scan();
  else document.addEventListener("DOMContentLoaded", scan, { once: true });

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.target.classList.contains("glass-refract")) {
          updateElementRefraction(m.target);
        }
      } else if (m.type === "childList") {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === 1) {
            if (node.classList.contains("glass-refract")) {
              updateElementRefraction(node);
            }
            node.querySelectorAll(".glass-refract").forEach(updateElementRefraction);
          }
        });
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  refractionObserver = observer;

  return () => {
    observer.disconnect();
    refractionObserver = null;
  };
}

if (isBrowser) {
  init();
}

export default init;
