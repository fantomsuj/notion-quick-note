import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("shared tokens define approved light and dark roles", async () => {
  const css = await read("styles/tokens.css");
  for (const value of ["#fff", "#f9f8f7", "#f0efed", "#191919", "#202020", "#252525"]) {
    assert.match(css, new RegExp(value.replace("#", "#"), "i"));
  }
  assert.match(css, /--nqn-text-secondary:\s*#5f5e59/i);
  assert.match(css, /--nqn-action:\s*#0077d4/i);
  assert.match(css, /--nqn-focus:\s*#2383e2/i);
});

test("all NotionInter weights are bundled and declared locally", async () => {
  const css = await read("styles/tokens.css");
  for (const [name, weight] of [["Regular", 400], ["Medium", 500], ["SemiBold", 600], ["Bold", 700]]) {
    assert.match(css, new RegExp(`NotionInter-${name}\\.woff2`));
    assert.match(css, new RegExp(`font-weight:\\s*${weight}`));
  }
  assert.doesNotMatch(css, /https?:\/\//i);
});

test("only approved radii and motion conventions appear in UI styles", async () => {
  const css = `${await read("styles/tokens.css")}\n${await read("styles/composer.css")}\n${await read("options/options.css")}`;
  const pixelRadii = [...css.matchAll(/border-radius:\s*(\d+)px/gi)].map((match) => Number(match[1]));
  assert.ok(pixelRadii.every((radius) => radius <= 10), `found oversized radius: ${pixelRadii.join(", ")}`);
  assert.match(css, /prefers-reduced-motion:\s*reduce/i);
  assert.doesNotMatch(css, /backdrop-filter|blur\s*\(/i);
});

test("manifest exposes only packaged design resources", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: [
      "styles/tokens.css",
      "styles/composer.css",
      "assets/fonts/*.woff2"
    ],
    matches: ["<all_urls>"]
  }]);
});

test("both surfaces consume shared tokens and keep the compact Notion page geometry", async () => {
  const options = await read("options/options.html");
  const content = await read("src/content.js");
  const composer = await read("styles/composer.css");
  assert.match(options, /href="\.\.\/styles\/tokens\.css"/);
  assert.match(content, /getURL\("styles\/composer\.css"\)/);
  assert.match(composer, /@import url\("tokens\.css"\)/);
  assert.match(composer, /width:\s*min\(390px,/);
  assert.match(composer, /max-height:\s*min\(520px,/);
  assert.match(composer, /\.topbar\s*\{[\s\S]*?min-height:\s*40px/);
  assert.match(composer, /\.page\s*\{[\s\S]*?padding:\s*24px 24px 22px/);
  assert.match(composer, /\.editor\s*\{[\s\S]*?min-height:\s*180px[\s\S]*?overflow-y:\s*auto/);
  assert.doesNotMatch(content, /class="(?:source-row|destination-strip|composer-footer)"/);
});

test("small copy, placeholders, and segmented controls retain accessible focus and contrast roles", async () => {
  const composer = await read("styles/composer.css");
  const options = await read("options/options.css");
  assert.match(composer, /\.status\s*\{[\s\S]*?color:\s*var\(--nqn-text-secondary\)/);
  assert.match(composer, /\.page-title::placeholder\s*\{[^}]*color:\s*var\(--nqn-text-tertiary\)[^}]*opacity:\s*1/);
  assert.match(composer, /\.ProseMirror p\.is-editor-empty:first-child::before\s*\{[^}]*color:\s*var\(--nqn-text-secondary\)[^}]*opacity:\s*1/);
  assert.match(options, /\.segmented input:focus-visible \+ span\s*\{[^}]*outline:\s*2px solid var\(--nqn-focus\)/);
});

test("legacy editorial and glass treatments are removed from runtime UI", async () => {
  const runtime = `${await read("options/options.css")}\n${await read("options/options.html")}\n${await read("src/content.js")}\n${await read("styles/composer.css")}\n${await read("sidepanel/sidepanel.css")}\n${await read("sidepanel/index.html")}`;
  assert.doesNotMatch(runtime, /Georgia|Avenir|SF Pro|backdrop-filter|#e8b44d|#fff4cf/i);
  assert.doesNotMatch(runtime, />\s*(?:N|•••|×|⌕|↻|✓)\s*</);
});

test("privacy handling is explained in settings, Notes, policy, and store copy", async () => {
  const options = await read("options/options.html");
  const sidepanel = await read("sidepanel/index.html");
  const policy = await read("PRIVACY.md");
  const listing = await read("docs/STORE_LISTING.md");
  const copy = `${options}\n${sidepanel}\n${policy}\n${listing}`;

  assert.match(options, /What stays here, and what goes to Notion/);
  assert.match(sidepanel, /How your captures are handled/);
  for (const phrase of ["note text", "selected text", "page title and URL", "until delivery succeeds or you delete them", "In Incognito", "selected Notion workspace"]) {
    assert.match(copy, new RegExp(phrase, "i"));
  }
});
