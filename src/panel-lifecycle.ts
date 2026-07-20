import type { PanelNavigationMessage } from "./contracts.js";

interface DraftIdentity {
  id: string;
}

export interface ComposerTerminalEvent {
  draftId: string;
  reason: "saved" | "discarded";
}

export function composerNavigationForDraft(draft: { id: string; tabId?: number | null }): Extract<PanelNavigationMessage, { type: "SHOW_COMPOSER" }> {
  return {
    type: "SHOW_COMPOSER",
    draftId: draft.id,
    ...(draft.tabId === null || draft.tabId === undefined ? {} : { tabId: draft.tabId })
  };
}

export function shouldRegisterPanel(_params: URLSearchParams): boolean {
  return !_params.has("view");
}

export function shouldPublishExplicitContext(selection: string, _reusedActiveDraft: boolean): boolean {
  return Boolean(selection && _reusedActiveDraft);
}

interface PreparePanelDraftOptions<T> {
  connected: boolean;
  getActiveDraft(): Promise<T | null>;
  createDraft(): Promise<T>;
}

export async function preparePanelDraft<T>({
  connected,
  getActiveDraft,
  createDraft
}: PreparePanelDraftOptions<T>): Promise<T> {
  const activeDraft = connected ? await getActiveDraft() : null;
  return activeDraft ?? createDraft();
}

interface RouteShowComposerOptions<T extends DraftIdentity> {
  activeDraft: T | null;
  message: Extract<PanelNavigationMessage, { type: "SHOW_COMPOSER" }>;
  loadDraft(): Promise<T>;
  openDraft(draft: T): void | Promise<void>;
  activateDraft?(draft: T): Promise<T>;
  syncDraft?(draft: T): void | Promise<void>;
  refreshDraft?(draft: T): Promise<T>;
  restoreDraft?(draft: T): void | Promise<void>;
}

export async function routeShowComposer<T extends DraftIdentity>({
  activeDraft,
  message,
  loadDraft,
  openDraft,
  activateDraft,
  syncDraft,
  refreshDraft,
  restoreDraft
}: RouteShowComposerOptions<T>): Promise<T> {
  if (activeDraft && message.draftId && message.draftId === activeDraft.id) {
    await openDraft(activeDraft);
    return activeDraft;
  }
  const draft = await loadDraft();
  await openDraft(draft);
  if (!message.draftId || !activateDraft) return draft;

  let activatedDraft: T;
  try {
    activatedDraft = await activateDraft(draft);
  } catch (error) {
    if (activeDraft && restoreDraft) {
      const latestActiveDraft = refreshDraft ? await refreshDraft(activeDraft) : activeDraft;
      await restoreDraft(latestActiveDraft);
    }
    throw error;
  }

  try {
    await syncDraft?.(activatedDraft);
    return activatedDraft;
  } catch (error) {
    if (activeDraft) {
      const restoredDraft = await activateDraft(activeDraft);
      await restoreDraft?.(restoredDraft);
    }
    throw error;
  }
}

export function clearTerminalDraft<T extends DraftIdentity>(
  activeDraft: T | null,
  event: ComposerTerminalEvent
): T | null {
  return activeDraft?.id === event.draftId ? null : activeDraft;
}
