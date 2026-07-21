/**
 * Section-aware assertion helpers for epub.js reader boundary tests.
 *
 * These helpers compare locations by section href (not raw CFI) and
 * validate page-boundary landing positions after cross-section navigation.
 */

/**
 * Compare two location objects by their section href (strips #fragment).
 * Returns true if both are on the same section.
 */
export function sameSectionHref(locA, locB) {
  if (!locA || !locB || !locA.start || !locB.start) return false;
  const hrefA = locA.start.href ? locA.start.href.split('#')[0] : '';
  const hrefB = locB.start.href ? locB.start.href.split('#')[0] : '';
  return hrefA === hrefB;
}

/**
 * Check if a location is on the first page of its section.
 */
export function landedOnFirstPage(loc) {
  return loc && loc.start && loc.start.displayed && loc.start.displayed.page === 1;
}

/**
 * Check if a location is on the last page of its section.
 */
export function landedOnLastPage(loc) {
  return loc && loc.start && loc.start.displayed &&
    loc.start.displayed.page === loc.start.displayed.total;
}
