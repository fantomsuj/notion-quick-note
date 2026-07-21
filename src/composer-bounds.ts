/** Viewport-relative geometry for the in-page Quick Note composer. */
export interface ComposerBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComposerViewport {
  width: number;
  height: number;
}

export interface ComposerSizeLimits {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
}

export const COMPOSER_VIEWPORT_MARGIN = 16;
export const COMPOSER_MIN_WIDTH = 320;
export const COMPOSER_MIN_HEIGHT = 260;
export const COMPOSER_MAX_WIDTH = 720;
export const COMPOSER_MAX_HEIGHT = 720;
export const COMPOSER_DEFAULT_WIDTH = 390;
export const COMPOSER_DEFAULT_HEIGHT = 315;

/**
 * Accepts persisted geometry only when it has every numeric field needed to
 * position a real panel. Viewport-relative values may be stale, so callers
 * should pass successful results through `clampComposerBounds`.
 */
export function validateComposerBounds(value: unknown): ComposerBounds | null {
  if (!isRecord(value)) return null;
  const { left, top, width, height } = value;
  if (!isFiniteNumber(left) || !isFiniteNumber(top) || !isPositiveFiniteNumber(width) || !isPositiveFiniteNumber(height)) {
    return null;
  }
  return { left, top, width, height };
}

/** Returns the effective size range after accounting for the visible viewport. */
export function composerSizeLimits(viewport: ComposerViewport): ComposerSizeLimits {
  const availableWidth = availableViewportSpace(viewport.width);
  const availableHeight = availableViewportSpace(viewport.height);
  const maxWidth = Math.min(COMPOSER_MAX_WIDTH, availableWidth);
  const maxHeight = Math.min(COMPOSER_MAX_HEIGHT, availableHeight);
  return {
    minWidth: Math.min(COMPOSER_MIN_WIDTH, maxWidth),
    minHeight: Math.min(COMPOSER_MIN_HEIGHT, maxHeight),
    maxWidth,
    maxHeight
  };
}

/** Keeps a composer entirely reachable, including on a smaller viewport. */
export function clampComposerBounds(bounds: ComposerBounds, viewport: ComposerViewport): ComposerBounds {
  const limits = composerSizeLimits(viewport);
  const width = clamp(bounds.width, limits.minWidth, limits.maxWidth);
  const height = clamp(bounds.height, limits.minHeight, limits.maxHeight);
  const maxLeft = Math.max(COMPOSER_VIEWPORT_MARGIN, viewportSize(viewport.width) - COMPOSER_VIEWPORT_MARGIN - width);
  const maxTop = Math.max(COMPOSER_VIEWPORT_MARGIN, viewportSize(viewport.height) - COMPOSER_VIEWPORT_MARGIN - height);
  return {
    left: clamp(bounds.left, COMPOSER_VIEWPORT_MARGIN, maxLeft),
    top: clamp(bounds.top, COMPOSER_VIEWPORT_MARGIN, maxTop),
    width,
    height
  };
}

/** The legacy bottom-right placement, constrained for the current viewport. */
export function defaultComposerBounds(viewport: ComposerViewport): ComposerBounds {
  const bounds = clampComposerBounds({
    left: 0,
    top: 0,
    width: COMPOSER_DEFAULT_WIDTH,
    height: COMPOSER_DEFAULT_HEIGHT
  }, viewport);
  return {
    ...bounds,
    left: Math.max(COMPOSER_VIEWPORT_MARGIN, viewportSize(viewport.width) - COMPOSER_VIEWPORT_MARGIN - bounds.width),
    top: Math.max(COMPOSER_VIEWPORT_MARGIN, viewportSize(viewport.height) - COMPOSER_VIEWPORT_MARGIN - bounds.height)
  };
}

/** Validates persisted geometry, then repairs position and dimensions for this viewport. */
export function normalizeStoredComposerBounds(value: unknown, viewport: ComposerViewport): ComposerBounds | null {
  const bounds = validateComposerBounds(value);
  return bounds ? clampComposerBounds(bounds, viewport) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function availableViewportSpace(value: number): number {
  return Math.max(0, viewportSize(value) - COMPOSER_VIEWPORT_MARGIN * 2);
}

function viewportSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
