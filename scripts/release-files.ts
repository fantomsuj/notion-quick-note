export const STATIC_RELEASE_FILES = Object.freeze([
  "LICENSE",
  "manifest.json",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "assets/brand/notion-mark.svg",
  "assets/fonts/NotionInter-Regular.woff2",
  "assets/fonts/NotionInter-Medium.woff2",
  "assets/fonts/NotionInter-SemiBold.woff2",
  "assets/fonts/NotionInter-Bold.woff2",
  "options/options.html",
  "options/options.css",
  "styles/tokens.css",
  "styles/composer.css"
]);

export const GENERATED_RELEASE_FILES = Object.freeze([
  "dist/background.js",
  "dist/content.js",
  "dist/options.js",
  "dist/product-config.js"
]);

export const RELEASE_FILES = Object.freeze([...STATIC_RELEASE_FILES, ...GENERATED_RELEASE_FILES]);
