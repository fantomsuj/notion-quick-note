import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("shared tokens define approved light and dark roles", async () => {
  const css = await read("styles/tokens.css");
  for (const value of ["#fff", "#f9f8f7", "#f0efed", "#191919", "#202020", "#252525"]) {
    assert.match(css, new RegExp(value.replace("#", "#"), "i"));
  }
  assert.match(css, /--nqn-text-secondary:\s*#5f5e59/i);
  assert.match(css, /--nqn-action:\s*#0077d4/i);
  assert.match(css, /--nqn-focus:\s*#2383e2/i);
});

test("composer defines distinct light and dark Notion text and background colors", async () => {
  const tokens = await read("styles/tokens.css");
  const composer = await read("styles/composer.css");
  const colorNames = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];
  for (const name of colorNames) {
    assert.match(tokens, new RegExp(`--nqn-notion-${name}:\\s*#[0-9a-f]{6}`, "i"));
    assert.match(tokens, new RegExp(`--nqn-notion-${name}-background:\\s*#[0-9a-f]{6}`, "i"));
    assert.match(composer, new RegExp(`\\.notion-color-${name}(?:\\s|,|\\{)`));
    assert.match(composer, new RegExp(`\\.notion-color-${name}_background(?:\\s|,|\\{)`));
  }
  const darkTokens = tokens.match(/@media \(prefers-color-scheme: dark\)[\s\S]+/)?.[0] || "";
  for (const name of colorNames) {
    assert.match(darkTokens, new RegExp(`--nqn-notion-${name}:\\s*#[0-9a-f]{6}`, "i"));
    assert.match(darkTokens, new RegExp(`--nqn-notion-${name}-background:\\s*#[0-9a-f]{6}`, "i"));
  }
});

test("title overrides the global blue focus ring with a neutral focus treatment", async () => {
  const composer = await read("styles/composer.css");
  const globalFocus = composer.indexOf(":focus-visible");
  const titleFocus = composer.indexOf(".page-title:focus-visible");
  assert.ok(globalFocus >= 0 && titleFocus > globalFocus, "title focus override must follow the global focus rule");
  assert.match(composer.slice(titleFocus), /\.page-title:focus-visible\s*\{[^}]*outline:\s*(?:0|none)[^}]*box-shadow:\s*[^;}]*var\(--nqn-border-strong\)/);
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

test("Quick Note uses one browser-scoped action shortcut with cross-platform defaults", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const options = await read("options/options.html");
  const background = await read("src/background.ts");

  assert.deepEqual(Object.keys(manifest.commands), ["_execute_action"]);
  assert.deepEqual(manifest.commands._execute_action, {
    suggested_key: {
      default: "Ctrl+Shift+Space",
      mac: "Command+Shift+Space"
    }
  });
  assert.equal(manifest.commands._execute_action.global, undefined);
  assert.match(background, /chrome\.action\.onClicked\.addListener\(\(tab\) => \{[\s\S]*?logDiagnostic\("worker\.toolbar\.click"[\s\S]*?void openQuickNote\(tab\);[\s\S]*?\}\);/);
  assert.match(background, /chrome\.commands\.onCommand\.addListener/);
  assert.match(background, /command !== "toggle-quick-note"/);
  assert.doesNotMatch(background, /QUICK_NOTE_COMMANDS|windows\.update/);
  assert.match(options, /id="keyboard-shortcut-heading"/);
  assert.match(options, /id="shortcut-assignment-status"/);
  assert.match(options, /id="shortcut-keycaps"/);
  assert.match(options, /id="change-shortcut"/);
  assert.match(options, /id="shortcut-warning"[^>]+hidden/);
  assert.match(options, /id="shortcut-manual-instructions"[^>]+hidden/);
  assert.doesNotMatch(options, /⌥ Z|⌘ ⇧ 0|Browser active · From any app/);
});

test("shortcut documentation describes browser-only customization through the native editor", async () => {
  const readme = await read("README.md");
  const product = await read("docs/PRODUCT.md");
  const listing = await read("docs/STORE_LISTING.md");
  const copy = `${readme}\n${product}\n${listing}`;

  assert.match(copy, /Command\+Shift\+Space/);
  assert.match(copy, /Ctrl\+Shift\+Space/);
  assert.match(copy, /chrome:\/\/extensions\/shortcuts/);
  assert.match(copy, /browser(?:-| )scoped/i);
  assert.match(copy, /customiz/i);
  assert.doesNotMatch(copy, /Option\+Z|system-wide keyboard shortcut|global shortcuts?/i);
});

test("Quick Note injects its composer after a user gesture without a persistent browser surface", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const background = await read("src/background.ts");

  assert.deepEqual(manifest.permissions, ["activeTab", "alarms", "contextMenus", "identity", "notifications", "scripting", "storage"]);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel, undefined);
  assert.match(background, /(?:chrome\.)?scripting\.executeScript/);
  assert.match(background, /createUnavailableNotice\(chrome\.notifications\)/);
  assert.doesNotMatch(background, /chrome\.sidePanel|panelCoordinator|REGISTER_PANEL|SHOW_COMPOSER|SHOW_ACTIVITY|ACTIVE_PAGE_CONTEXT/);
});

test("composer visibility recovers when its stylesheet was already loaded", async () => {
  const content = await read("src/content.ts");

  assert.match(content, /const revealComposerSheet = \(\) => \{/);
  assert.match(content, /if \(stylesheet\.sheet\) revealComposerSheet\(\);/);
});

test("the build and release checks contain no Side Panel artifacts", async () => {
  const background = await read("src/background.ts");
  const bundleCheck = await read("scripts/check-bundle-size.ts");
  const releaseFiles = await read("scripts/release-files.ts");
  const releaseCheck = await read("scripts/check-release.ts");

  for (const source of [background, releaseFiles, releaseCheck]) {
    assert.doesNotMatch(source, /sidePanel|sidepanel|panelCoordinator|REGISTER_PANEL|SHOW_COMPOSER|SHOW_ACTIVITY|ACTIVE_PAGE_CONTEXT/);
  }
  assert.match(bundleCheck, /content-loader/);
  assert.match(bundleCheck, /executeScript/);
  await assert.rejects(read("sidepanel/index.html"), { code: "ENOENT" });
  await assert.rejects(read("sidepanel/sidepanel.ts"), { code: "ENOENT" });
  await assert.rejects(read("src/panel-coordinator.ts"), { code: "ENOENT" });
  await assert.rejects(read("src/panel-lifecycle.ts"), { code: "ENOENT" });
});

test("both surfaces consume shared tokens and keep the resizable compact Notion page geometry", async () => {
  const options = await read("options/options.html");
  const content = await read("src/content.ts");
  const composer = await read("styles/composer.css");
  assert.match(options, /href="\.\.\/styles\/tokens\.css"/);
  assert.match(content, /getURL\("styles\/composer\.css"\)/);
  assert.match(composer, /@import url\("tokens\.css"\)/);
  assert.match(content, /setAttribute\("popover", "manual"\)/);
  assert.match(content, /showPopover\(\)/);
  assert.doesNotMatch(content, /showModal\(\)|aria-modal/);
  assert.match(composer, /\.sheet\s*\{[\s\S]*?width:\s*100%[\s\S]*?height:\s*100%/);
  assert.match(composer, /\.drag-region\s*\{[\s\S]*?cursor:\s*grab/);
  assert.match(composer, /\.resize-handle\s*\{[\s\S]*?cursor:\s*nwse-resize/);
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
  const runtime = `${await read("options/options.css")}\n${await read("options/options.html")}\n${await read("src/content.ts")}\n${await read("styles/composer.css")}`;
  assert.doesNotMatch(runtime, /Georgia|Avenir|SF Pro|backdrop-filter|#e8b44d|#fff4cf/i);
  assert.doesNotMatch(runtime, />\s*(?:N|•••|×|⌕|↻|✓)\s*</);
});

test("privacy handling is explained in settings, Notes, policy, and store copy", async () => {
  const options = await read("options/options.html");
  const policy = await read("PRIVACY.md");
  const listing = await read("docs/STORE_LISTING.md");
  const copy = `${options}\n${policy}\n${listing}`;

  assert.match(options, /What stays here, and what goes to Notion/);
  for (const phrase of ["note text", "selected text", "page title and URL", "until delivery succeeds or you delete them", "In Incognito", "selected Notion workspace"]) {
    assert.match(copy, new RegExp(phrase, "i"));
  }
});

test("documentation describes explicit, invocation-time context", async () => {
  const storeListing = await read("docs/STORE_LISTING.md");
  const readme = await read("README.md");

  assert.match(storeListing, /\| `activeTab` \|/);
  assert.match(storeListing, /injected into the current eligible page/i);
  assert.match(storeListing, /only when you invoke it/i);
  assert.match(readme, /in-page composer/i);
  assert.doesNotMatch(`${storeListing}\n${readme}`, /side panel|automatic(?:ally)? attach(?:ing)? each active page/i);
});
