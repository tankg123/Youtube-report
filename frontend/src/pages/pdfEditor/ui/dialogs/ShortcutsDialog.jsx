import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Keyboard, Search } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { useEditor, useUi } from "../editorHooks.js";
import { filterShortcutHelp, shortcutHelp } from "../shortcutHelp.js";
import { platformIsMac } from "../shortcutLabels.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// Keyboard shortcuts (UX specification 12): the table of tools/keymap.js by section, in the language of the
// interface, with a search field and the switch that turns all single-key shortcuts off (WCAG 2.1.4: a
// shortcut that is one letter must be possible to switch off). The switch is kept in localStorage
// (ui.setPreference("singleKeys")) and the dispatcher of the shell obeys it at once.
// Opened with the key "?" and from the overflow menu.
// Test hooks: pdfx-dialog-shortcuts; pdfx-shortcuts-search, pdfx-shortcuts-single-keys (role switch),
// pdfx-shortcuts-section (data-section), pdfx-shortcut (data-shortcut-id, data-single), pdfx-shortcuts-empty,
// pdfx-action-shortcuts-close.
export default function ShortcutsDialog({ onClose }) {
  const { t } = useI18n();
  const { features, ui } = useEditor();
  const singleKeys = useUi((state) => state.preferences.singleKeys);
  const [query, setQuery] = useState("");
  const searchRef = useRef(null);
  const switchId = useId();
  const mac = platformIsMac();
  const sections = useMemo(
    () => shortcutHelp({ mac, hasCommand: (id) => Boolean(features.commands?.[id]?.length), hasOrganiser: Boolean(features.fullScreenViews?.organiser) }),
    [features, mac]
  );
  const shown = filterShortcutHelp(sections, query);

  return (
    <DialogFrame
      size="lg"
      scrollBody
      icon={Keyboard}
      title={t("Keyboard shortcuts")}
      initialFocusRef={searchRef}
      onClose={() => onClose()}
      footer={
        <DialogButton variant="primary" data-testid="pdfx-action-shortcuts-close" onClick={() => onClose()}>
          {t("Close")}
        </DialogButton>
      }
    >
      <div className="pdfx-shortcuts-head">
        <label className="pdfx-shortcuts-search">
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            className="pdfx-input"
            placeholder={t("Search the shortcuts")}
            aria-label={t("Search the shortcuts")}
            autoComplete="off"
            spellCheck="false"
            data-dialog-escape={query ? "own" : undefined}
            data-testid="pdfx-shortcuts-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape empties the field first, and closes the dialog only when it is empty
              if (event.key !== "Escape" || !query) return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
          />
        </label>
        <div className="pdfx-switch-row">
          <button type="button" role="switch" id={switchId} className="pdfx-switch" aria-checked={singleKeys ? "true" : "false"} data-testid="pdfx-shortcuts-single-keys" onClick={() => ui.setPreference("singleKeys", !singleKeys)}>
            <span className="pdfx-switch-knob" aria-hidden="true" />
          </button>
          <label htmlFor={switchId}>
            <strong>{t("Single-key shortcuts")}</strong>
            <span>{t("Keys that work without Ctrl or Alt, such as V, T or 1. Switch them off if they get in your way, for example with a Vietnamese input method.")}</span>
          </label>
        </div>
      </div>
      {shown.length ? (
        <div className="pdfx-shortcuts-grid">
          {shown.map((section) => (
            <section key={section.id} className="pdfx-shortcuts-section" data-testid="pdfx-shortcuts-section" data-section={section.id}>
              <h3>{t(section.label)}</h3>
              <table>
                <thead className="pdfx-visually-hidden">
                  <tr>
                    <th scope="col">{t("Action")}</th>
                    <th scope="col">{t("Keys")}</th>
                    <th scope="col">{t("Active in")}</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row) => (
                    <tr key={row.id} data-testid="pdfx-shortcut" data-shortcut-id={row.id} data-single={row.single ? "true" : "false"} data-off={row.single && !singleKeys ? "true" : "false"}>
                      <th scope="row">{t(row.label)}</th>
                      <td className="pdfx-shortcut-keys">
                        {row.combos.map((caps, index) => (
                          <Fragment key={caps.join("+")}>
                            {index ? <span className="pdfx-shortcut-or">{t("or")}</span> : null}
                            <span className="pdfx-shortcut-combo">
                              {caps.map((cap, position) => (
                                <kbd key={`${cap}:${position}`}>{cap}</kbd>
                              ))}
                            </span>
                          </Fragment>
                        ))}
                        {row.hold ? <span className="pdfx-shortcut-or">{t("(hold)")}</span> : null}
                      </td>
                      <td className="pdfx-shortcut-scope">
                        {row.single && !singleKeys ? t("Switched off") : row.everywhere ? t("Everywhere") : row.scopes.map((scope) => t(scope)).join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      ) : (
        <p className="pdfx-dialog-note" role="status" data-testid="pdfx-shortcuts-empty">
          {t("No shortcut matches your search.")}
        </p>
      )}
    </DialogFrame>
  );
}
