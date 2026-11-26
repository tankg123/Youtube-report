// The hooks of the editor context (the manual is the header of ui/EditorContext.jsx). They live in a plain
// module so that component files export components only (fast refresh).
import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export const EditorReactContext = createContext(null);

/** The editor: { store, viewer, ui, actions, textService, fonts, features, messages, loadPipeline, ... }. */
export function useEditor() {
  const editor = useContext(EditorReactContext);
  if (!editor) throw new Error("useEditor must be used inside EditorProvider");
  return editor;
}

const identity = (value) => value;

/**
 * The document (model/store.js getState()), or a part of it.
 * `select` must return something that stays `===` while that part did not change: a slice of the state
 * (state.pages, state.objects[id]) or a primitive. Never build a new object or array in it.
 */
export function useDocument(select = identity) {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

/** { canUndo, canRedo, undoDepth, redoDepth, dirty } of the document store. */
export function useHistoryState() {
  const { store } = useEditor();
  return useSyncExternalStore(store.subscribe, store.getHistoryState);
}

/** The UI store (ui/uiStore.js getState()), or a part of it: the same rule for `select` as useDocument. */
export function useUi(select = identity) {
  const { ui } = useEditor();
  return useSyncExternalStore(ui.subscribe, () => select(ui.getState()));
}

/** The interaction state of tools/interaction.js: { tool, toolLocked, mode, selection, gesture, editingId, spaceHeld }. */
export function useInteraction() {
  return useUi((state) => state.interaction);
}

/** The bag of a feature in the UI store and its setter: [value, set(valueOrUpdater)]. */
export function useFeatureState(featureId) {
  const { ui } = useEditor();
  const value = useSyncExternalStore(ui.subscribe, () => ui.getState().features[featureId]);
  const set = useCallback((next) => ui.setFeatureState(featureId, next), [ui, featureId]);
  return [value, set];
}

/**
 * The snapshot of the viewer controller, or a part of it: { scale, zoom, zoomMode, currentPageId,
 * currentPageNumber, pageCount, search, busy }. The same rule for `select` as useDocument.
 */
export function useViewer(select = identity) {
  const { viewer } = useEditor();
  return useSyncExternalStore(viewer.subscribe, () => select(viewer.getSnapshot()));
}
