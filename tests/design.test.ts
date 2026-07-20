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
  assert.match(background, /chrome\.action\.onClicked\.addListener\(\(tab\) => openQuickNote\(tab\)\)/);
  assert.doesNotMatch(background, /chrome\.commands\.onCommand|QUICK_NOTE_COMMANDS|windows\.update/);
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

test("persistent side panel opens by window and tracks active tabs only while connected", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const background = await read("src/background.ts");
  const sidepanel = await read("sidepanel/sidepanel.ts");

  assert.ok(manifest.permissions.includes("tabs"));
  assert.equal(manifest.action.default_popup, undefined);
  assert.match(background, /chrome\.sidePanel\.open\(\{ windowId:/);
  assert.match(background, /chrome\.tabs\.onActivated\.addListener/);
  assert.match(background, /chrome\.tabs\.onUpdated\.addListener/);
  assert.match(sidepanel, /chrome\.runtime\.connect\(\{ name: "notion-quick-note-panel" \}\)/);
  assert.match(sidepanel, /await openComposer\(\)/);
});

test("window-scoped panel routing uses the typed coordinator without injection or tab-specific opening", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const background = await read("src/background.ts");
  const sidepanel = await read("sidepanel/sidepanel.ts");
  const bundleCheck = await read("scripts/check-bundle-size.ts");

  assert.deepEqual(manifest.permissions, ["alarms", "contextMenus", "identity", "sidePanel", "storage", "tabs"]);
  assert.match(background, /createPanelCoordinator/);
  assert.match(background, /isPanelRegistrationMessage/);
  assert.match(background, /panelCoordinator\.register/);
  assert.match(background, /panelCoordinator\.unregister/);
  assert.match(background, /panelCoordinator\.navigate/);
  assert.match(background, /panelCoordinator\.publishContext/);
  assert.doesNotMatch(background, /panelPorts|sidePanel\.setOptions|sidePanel\.open\(\{\s*tabId|scripting\.executeScript/);
  for (const command of ["SHOW_COMPOSER", "SHOW_ACTIVITY", "ACTIVE_PAGE_CONTEXT"]) {
    assert.match(`${background}\n${sidepanel}`, new RegExp(command));
  }
  assert.match(sidepanel, /WorkerToPanelMessage/);
  assert.doesNotMatch(sidepanel, /OPEN_DRAFT/);
  assert.doesNotMatch(bundleCheck, /content-loader/);
  assert.match(bundleCheck, /background,[\s\S]*executeScript/);
  await assert.rejects(read("src/content-loader.ts"), { code: "ENOENT" });
  await assert.rejects(read("tests/content-loader.test.ts"), { code: "ENOENT" });
});

test("both surfaces consume shared tokens and keep the compact Notion page geometry", async () => {
  const options = await read("options/options.html");
  const content = await read("src/content.ts");
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
  const runtime = `${await read("options/options.css")}\n${await read("options/options.html")}\n${await read("src/content.ts")}\n${await read("styles/composer.css")}\n${await read("sidepanel/sidepanel.css")}\n${await read("sidepanel/index.html")}`;
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

test("persistent side panel documentation matches automatic context behavior", async () => {
  const storeListing = await read("docs/STORE_LISTING.md");
  const readme = await read("README.md");

  assert.match(storeListing, /\| `tabs` \|/);
  assert.match(storeListing, /while the Quick Note side panel is open/i);
  assert.doesNotMatch(storeListing, /reads active-page details only when you invoke it/i);
  assert.match(readme, /remains open while you switch tabs/i);
  assert.match(readme, /remove.*source.*does not reappear/i);
});
