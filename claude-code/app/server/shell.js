'use strict';

// Version-stamping for the console's own JS/CSS. The ingress shell (index.html)
// is served no-store (always fresh), but its assets keep a long cache; without a
// per-version key a fresh shell can pair with a STALE cached script after an
// update (new markup, old code → dead buttons). Appending ?v=<version> makes
// each release a distinct cache key. Kept in its own module so it is unit-
// testable without importing index.js (which starts the server on require).

// Anchored on the attribute's leading whitespace (not \b) so it can never fire
// inside a data-src="" / data-href="" attribute. Matches only the console's own
// mutable assets — styles.css, app.js, vendor/*.(js|css) — never fonts, icons,
// the manifest, or absolute URLs.
const VERSIONABLE = /(\s)(href|src)="((?:styles\.css|app\.js|vendor\/[\w-]+\.(?:js|css)))"/g;

/**
 * @param {string} html  the index.html source
 * @param {string} version  cache-busting token (the add-on version)
 * @returns {string} html with ?v=<version> appended to its own JS/CSS refs
 */
function stampAssetVersion(html, version) {
  return html.replace(VERSIONABLE, (_m, ws, attr, url) => `${ws}${attr}="${url}?v=${version}"`);
}

module.exports = { stampAssetVersion, VERSIONABLE };
