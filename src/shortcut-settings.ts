export const SHORTCUT_SETTINGS_URL = "chrome://extensions/shortcuts";

export interface ShortcutSettingsState {
  status: "assigned" | "unassigned" | "error";
  statusLabel: "Assigned" | "Not assigned" | "Unavailable";
  shortcut: string;
  keycaps: string[];
  warning?: string;
}

const KEYCAP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Command: "⌘",
  Ctrl: "Ctrl",
  MacCtrl: "⌃",
  Option: "⌥",
  Shift: "⇧",
  Space: "Space",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→"
});

type Listener = () => void | Promise<void>;

interface ListenerSource {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

interface VisibilitySource extends ListenerSource {
  visibilityState: string;
}

interface ShortcutSettingsDependencies {
  commands: { getAll(): Promise<Array<{ name?: string; shortcut?: string }>> };
  tabs: { create(details: { url: string }): Promise<unknown> };
  view: {
    render(state: ShortcutSettingsState): void;
    showManualInstructions(url: string): void;
  };
  focusSource: ListenerSource;
  visibilitySource: VisibilitySource;
}

export function formatShortcutKeycaps(shortcut: string): string[] {
  const keys = String(shortcut || "")
    .split("+")
    .map((key) => key.trim())
    .filter(Boolean);
  const isMacShortcut = keys.some((key) => key === "Command" || key === "MacCtrl" || key === "Option");
  return keys.map((key) => key === "Alt" && isMacShortcut ? "⌥" : KEYCAP_LABELS[key] || key);
}

export function createShortcutSettingsController(dependencies: ShortcutSettingsDependencies) {
  let started = false;

  async function refresh(): Promise<void> {
    try {
      const commands = await dependencies.commands.getAll();
      const shortcut = String(commands.find((command) => command.name === "_execute_action")?.shortcut || "").trim();
      if (shortcut) {
        dependencies.view.render({
          status: "assigned",
          statusLabel: "Assigned",
          shortcut,
          keycaps: formatShortcutKeycaps(shortcut)
        });
        return;
      }
      dependencies.view.render({
        status: "unassigned",
        statusLabel: "Not assigned",
        shortcut: "",
        keycaps: [],
        warning: "Quick Note does not have a keyboard shortcut. Assign one to avoid extension conflicts."
      });
    } catch {
      dependencies.view.render({
        status: "error",
        statusLabel: "Unavailable",
        shortcut: "",
        keycaps: [],
        warning: "Quick Note could not read the current shortcut. Open the browser shortcut editor to check it."
      });
    }
  }

  const handleFocus = () => refresh();
  const handleVisibilityChange = () => dependencies.visibilitySource.visibilityState === "visible"
    ? refresh()
    : undefined;

  return {
    async start(): Promise<void> {
      if (!started) {
        started = true;
        dependencies.focusSource.addEventListener("focus", handleFocus);
        dependencies.visibilitySource.addEventListener("visibilitychange", handleVisibilityChange);
      }
      await refresh();
    },
    async openEditor(): Promise<void> {
      try {
        await dependencies.tabs.create({ url: SHORTCUT_SETTINGS_URL });
      } catch {
        dependencies.view.showManualInstructions(SHORTCUT_SETTINGS_URL);
      }
    },
    destroy(): void {
      if (!started) return;
      started = false;
      dependencies.focusSource.removeEventListener("focus", handleFocus);
      dependencies.visibilitySource.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };
}
