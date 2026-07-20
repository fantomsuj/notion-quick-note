import assert from "node:assert/strict";
import test from "node:test";
import {
  createShortcutSettingsController,
  formatShortcutKeycaps,
  SHORTCUT_SETTINGS_URL,
  type ShortcutSettingsState
} from "../src/shortcut-settings.js";

test("assigned action shortcuts render as readable keycaps", async () => {
  const states: ShortcutSettingsState[] = [];
  const controller = createShortcutSettingsController({
    commands: { async getAll() { return [{ name: "_execute_action", shortcut: "Command+Shift+Space" }]; } },
    tabs: { async create() { return undefined; } },
    view: { render: (state) => states.push(state), showManualInstructions() {} },
    focusSource: eventSource(),
    visibilitySource: visibilitySource()
  });

  await controller.start();

  assert.deepEqual(formatShortcutKeycaps("Command+Shift+Space"), ["⌘", "⇧", "Space"]);
  assert.deepEqual(formatShortcutKeycaps("Alt+Shift+Y"), ["Alt", "⇧", "Y"]);
  assert.deepEqual(states.at(-1), {
    status: "assigned",
    statusLabel: "Assigned",
    shortcut: "Command+Shift+Space",
    keycaps: ["⌘", "⇧", "Space"]
  });
});

test("an unassigned or conflicted action shortcut renders a remediation warning", async () => {
  const states: ShortcutSettingsState[] = [];
  const controller = createShortcutSettingsController({
    commands: { async getAll() { return [{ name: "_execute_action", shortcut: "" }]; } },
    tabs: { async create() { return undefined; } },
    view: { render: (state) => states.push(state), showManualInstructions() {} },
    focusSource: eventSource(),
    visibilitySource: visibilitySource()
  });

  await controller.start();

  assert.deepEqual(states.at(-1), {
    status: "unassigned",
    statusLabel: "Not assigned",
    shortcut: "",
    keycaps: [],
    warning: "Quick Note does not have a keyboard shortcut. Assign one to avoid extension conflicts."
  });
});

test("command API errors render an unavailable state without hiding remediation", async () => {
  const states: ShortcutSettingsState[] = [];
  const controller = createShortcutSettingsController({
    commands: { async getAll() { throw new Error("commands unavailable"); } },
    tabs: { async create() { return undefined; } },
    view: { render: (state) => states.push(state), showManualInstructions() {} },
    focusSource: eventSource(),
    visibilitySource: visibilitySource()
  });

  await controller.start();

  assert.deepEqual(states.at(-1), {
    status: "error",
    statusLabel: "Unavailable",
    shortcut: "",
    keycaps: [],
    warning: "Quick Note could not read the current shortcut. Open the browser shortcut editor to check it."
  });
});

test("focus and visible-page events refresh the live browser assignment", async () => {
  let shortcut = "Command+Shift+Space";
  let reads = 0;
  const states: ShortcutSettingsState[] = [];
  const focus = eventSource();
  const visibility = visibilitySource();
  const controller = createShortcutSettingsController({
    commands: { async getAll() { reads += 1; return [{ name: "_execute_action", shortcut }]; } },
    tabs: { async create() { return undefined; } },
    view: { render: (state) => states.push(state), showManualInstructions() {} },
    focusSource: focus,
    visibilitySource: visibility
  });
  await controller.start();

  shortcut = "Command+Alt+Y";
  await focus.dispatch("focus");
  assert.equal(states.at(-1)?.shortcut, "Command+Alt+Y");

  visibility.visibilityState = "hidden";
  await visibility.dispatch("visibilitychange");
  assert.equal(reads, 2);

  shortcut = "";
  visibility.visibilityState = "visible";
  await visibility.dispatch("visibilitychange");
  assert.equal(reads, 3);
  assert.equal(states.at(-1)?.status, "unassigned");
});

test("the change button opens the native editor and exposes manual instructions on failure", async () => {
  const opened: string[] = [];
  const manual: string[] = [];
  const controller = createShortcutSettingsController({
    commands: { async getAll() { return []; } },
    tabs: { async create({ url }) { opened.push(url); throw new Error("blocked"); } },
    view: { render() {}, showManualInstructions: (url) => manual.push(url) },
    focusSource: eventSource(),
    visibilitySource: visibilitySource()
  });

  await controller.openEditor();

  assert.deepEqual(opened, [SHORTCUT_SETTINGS_URL]);
  assert.deepEqual(manual, [SHORTCUT_SETTINGS_URL]);
});

type Listener = () => void | Promise<void>;

function eventSource() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, listener: Listener) {
      const group = listeners.get(type) || new Set<Listener>();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    async dispatch(type: string) {
      await Promise.all([...listeners.get(type) || []].map((listener) => listener()));
    }
  };
}

function visibilitySource() {
  return Object.assign(eventSource(), { visibilityState: "visible" });
}
