// The keyboard help (UX specification 12), generated from the shortcut table of tools/keymap.js: sections in
// display order, every shortcut with its key caps for this platform and the place where it is active.
// Pure: tests/pdfUiShortcutHelp.test.mjs. The labels are tk() texts of the keymap: render them with t().
import { t } from "../../../i18n/index.js";
import { SCOPES, SCOPE_LABELS, SHORTCUT_SECTIONS, comboKeyCaps, keysOfShortcut, shortcutsOfSection } from "../tools/keymap.js";

/** Shortcuts that exist in the table but only do something when a feature answers their command. */
const NEEDS_FEATURE = Object.freeze(["rotateView"]);

/**
 * @param {object} [options]
 * @param {boolean} [options.mac]                    key caps of macOS
 * @param {(id: string) => boolean} [options.hasCommand]   true when a feature implements the command `id`
 * @param {boolean} [options.hasOrganiser]           the page organiser exists (the key G)
 * @returns {Array<{ id: string, label: string, rows: Array<{ id: string, label: string, combos: string[][],
 *   single: boolean, hold: boolean, everywhere: boolean, scopes: string[] }> }>}
 *   label / scopes are tk() texts; combos: one list of key caps per alternative
 */
export function shortcutHelp({ mac = false, hasCommand = () => false, hasOrganiser = true } = {}) {
  return SHORTCUT_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    rows: shortcutsOfSection(section.id)
      .filter((entry) => !(NEEDS_FEATURE.includes(entry.id) && !hasCommand(entry.id)))
      .filter((entry) => entry.id !== "organise" || hasOrganiser)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        combos: keysOfShortcut(entry.id, { mac }).map((combo) => comboKeyCaps(combo, { mac })),
        single: Boolean(entry.single),
        hold: Boolean(entry.hold),
        everywhere: entry.scopes.length === SCOPES.length,
        scopes: entry.scopes.map((scope) => SCOPE_LABELS[scope])
      }))
  })).filter((section) => section.rows.length > 0);
}

// built from code points: no combining or exotic character is written into this file
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const D_WITH_STROKE = new RegExp(`[${String.fromCharCode(0x111)}${String.fromCharCode(0x110)}]`, "g");

const fold = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(D_WITH_STROKE, "d")
    .toLowerCase();

/**
 * The sections narrowed to the rows that match what the user typed. A row matches when every word is in its
 * translated label or in the place it is active, or when one of its key combinations holds every word as a
 * key ("ctrl+s", "ctrl s": only Ctrl+S, not every label with an s). Diacritics do not matter ("phong to"
 * finds the Vietnamese label for Zoom in).
 */
export function filterShortcutHelp(sections, query) {
  const words = fold(query).split(/[\s+]+/).filter(Boolean);
  if (!words.length) return sections;
  return sections
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        const places = row.everywhere ? [t("Everywhere")] : row.scopes.map((scope) => t(scope));
        const haystack = fold([t(row.label), ...places].join(" "));
        if (words.every((word) => haystack.includes(word))) return true;
        return row.combos.some((caps) => {
          const keys = caps.map(fold);
          return words.every((word) => keys.includes(word));
        });
      })
    }))
    .filter((section) => section.rows.length > 0);
}
