// Key caps for tooltips and menus, from the shortcut table of tools/keymap.js.
import { formatCombo, isMacPlatform, keysOfShortcut } from "../tools/keymap.js";

/** True on macOS / iOS, where "Ctrl" in a combo means the Command key. */
export function platformIsMac() {
  if (typeof navigator === "undefined") return false;
  return isMacPlatform(navigator.userAgentData?.platform || navigator.platform);
}

/** The first key combination of a shortcut as it is printed on this platform ("Ctrl+O"), or "" when it has none. */
export function shortcutLabel(id) {
  const mac = platformIsMac();
  const [combo] = keysOfShortcut(id, { mac });
  return combo ? formatCombo(combo, { mac }) : "";
}
