import type {
  PanelContextMessage,
  PanelNavigationMessage,
  WorkerToPanelMessage
} from "./contracts.js";

export interface PanelPort {
  postMessage(message: WorkerToPanelMessage): void;
}

export interface PanelCoordinator {
  register(windowId: number, port: PanelPort): void;
  unregister(windowId: number, port: PanelPort): void;
  has(windowId: number): boolean;
  navigate(windowId: number, message: PanelNavigationMessage): void;
  publishContext(windowId: number, message: PanelContextMessage): void;
}

export function createPanelCoordinator(): PanelCoordinator {
  const ports = new Map<number, PanelPort>();
  const pendingNavigation = new Map<number, PanelNavigationMessage>();

  function unregister(windowId: number, port: PanelPort): void {
    if (ports.get(windowId) === port) ports.delete(windowId);
  }

  function post(windowId: number, port: PanelPort, message: WorkerToPanelMessage): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      unregister(windowId, port);
      return false;
    }
  }

  return {
    register(windowId, port) {
      ports.set(windowId, port);
      const queued = pendingNavigation.get(windowId);
      if (queued && post(windowId, port, queued)) pendingNavigation.delete(windowId);
    },

    unregister,

    has(windowId) {
      return ports.has(windowId);
    },

    navigate(windowId, message) {
      const port = ports.get(windowId);
      if (!port || !post(windowId, port, message)) {
        pendingNavigation.set(windowId, message);
      }
    },

    publishContext(windowId, message) {
      const port = ports.get(windowId);
      if (port) post(windowId, port, message);
    }
  };
}
