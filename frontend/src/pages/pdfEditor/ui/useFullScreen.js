import { useSyncExternalStore } from "react";

function subscribe(listener) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

const isFullScreen = () => Boolean(document.fullscreenElement);

/** True while the browser shows something in full-screen mode (the editor root, after actions.toggleFullScreen()). */
export function useFullScreen() {
  return useSyncExternalStore(subscribe, isFullScreen, () => false);
}
