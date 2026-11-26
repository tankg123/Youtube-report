import { useEffect, useId, useRef } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Search, WholeWord, X } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { BarButton } from "./controls.jsx";
import { useDocument, useEditor, useUi, useViewer } from "./editorHooks.js";
import { shortcutLabel } from "./shortcutLabels.js";

// Search in the document (UX specification 7.2): the field with the count ("3 / 17"), previous / next and the
// three options. "Match diacritics" is off by default, so "hop dong" finds the accented words. The search
// reads the text of the source pages (viewer.search); text the user added is not searched yet, and the hint
// of the field says so.
//
// Keys in the field: Enter = next result, Shift+Enter = previous, Escape = clear, then close.
// Below 1200 px the field is folded into a Search button and opens over the tool bar.
// Test hooks: pdfx-search-input, pdfx-search-count (data-total, data-current), pdfx-action-search-previous /
// -next, pdfx-search-option-matchCase / -wholeWord / -matchDiacritics (aria-pressed), pdfx-action-search.

const TYPING_DELAY_MS = 200;
const ACCENTED_A = String.fromCharCode(0xe1);

export default function SearchBox() {
  const { t } = useI18n();
  const editor = useEditor();
  const { actions, ui, viewer } = editor;
  const search = useUi((state) => state.search);
  const layout = useUi((state) => state.layout);
  const found = useViewer((state) => state.search);
  const hasDocument = useDocument((state) => state.pages.length > 0);
  const inputRef = useRef(null);
  const typing = useRef({ timer: 0 }); // the search runs a moment after the last key
  const hintId = useId();

  // Ctrl+F (or the Search button) puts the keyboard in the field and selects what is in it
  useEffect(() => {
    if (!search.focusToken) return;
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.select();
  }, [search.focusToken]);

  useEffect(() => {
    const pending = typing.current;
    return () => clearTimeout(pending.timer);
  }, []);

  const folded = layout !== "wide" && !search.open;
  const query = search.query;
  const settled = Boolean(found.query) && !found.running && found.query === query;
  const empty = settled && found.total === 0;

  const searchNow = (value, options) => {
    clearTimeout(typing.current.timer);
    actions.search(value, options);
  };

  const close = () => {
    clearTimeout(typing.current.timer);
    actions.closeSearch();
    editor.getElement("viewer")?.focus({ preventScroll: true });
  };

  if (folded) {
    return (
      <div className="pdfx-search pdfx-search-folded" role="search">
        <BarButton icon={Search} label={t("Search")} shortcut={shortcutLabel("search")} disabled={!hasDocument} testId="pdfx-action-search" tipAlign="end" onClick={() => actions.openSearch()} />
      </div>
    );
  }

  const options = [
    { key: "matchCase", label: t("Match case"), icon: CaseSensitive },
    { key: "wholeWord", label: t("Whole words"), icon: WholeWord },
    { key: "matchDiacritics", label: t("Match diacritics"), glyph: ACCENTED_A }
  ];

  return (
    <div className="pdfx-search" role="search" data-empty={empty ? "true" : "false"} data-floating={layout !== "wide" ? "true" : "false"} data-testid="pdfx-search">
      {/* only the field is the "search" scope of the keyboard: the buttons next to it keep Enter for themselves */}
      <label className="pdfx-search-field" data-pdfx-scope="search" data-tip={t("Searches the text of the original pages. Text you added is not searched.")}>
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          className="pdfx-search-input"
          placeholder={t("Search in document")}
          aria-label={t("Search in document")}
          aria-describedby={hintId}
          aria-invalid={empty ? "true" : undefined}
          autoComplete="off"
          spellCheck="false"
          disabled={!hasDocument}
          data-testid="pdfx-search-input"
          value={query}
          onChange={(event) => {
            const { value } = event.target;
            ui.setSearch({ query: value });
            clearTimeout(typing.current.timer);
            typing.current.timer = setTimeout(() => actions.search(value), value.trim() ? TYPING_DELAY_MS : 0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              clearTimeout(typing.current.timer);
              if (event.shiftKey) actions.findPrevious();
              else actions.findNext();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (query) searchNow("");
              else close();
            }
          }}
        />
        <span id={hintId} className="pdfx-visually-hidden">
          {t("Searches the text of the original pages. Text you added is not searched.")}
        </span>
      </label>
      <span className="pdfx-search-count" aria-live="polite" data-testid="pdfx-search-count" data-total={settled ? found.total : ""} data-current={settled && found.total ? found.current + 1 : ""} data-running={found.running ? "true" : "false"}>
        {settled ? (found.total ? `${found.current + 1} / ${found.total}` : t("No results")) : null}
      </span>
      <BarButton icon={ChevronUp} label={t("Previous result")} shortcut={shortcutLabel("findPrevious")} disabled={!found.total} testId="pdfx-action-search-previous" onClick={() => viewer.searchPrevious()} />
      <BarButton icon={ChevronDown} label={t("Next result")} shortcut={shortcutLabel("findNext")} disabled={!found.total} testId="pdfx-action-search-next" onClick={() => viewer.searchNext()} />
      <span className="pdfx-search-options" role="group" aria-label={t("Search options")}>
        {options.map((option) => (
          <BarButton
            key={option.key}
            icon={option.icon}
            label={option.label}
            pressed={search.options[option.key]}
            disabled={!hasDocument}
            testId={`pdfx-search-option-${option.key}`}
            tipAlign="end"
            onClick={() => {
              const next = { [option.key]: !search.options[option.key] };
              if (query.trim()) searchNow(query, next);
              else ui.setSearch({ options: next });
            }}
          >
            {option.glyph ? (
              <span className="pdfx-glyph" aria-hidden="true">
                {option.glyph}
              </span>
            ) : null}
          </BarButton>
        ))}
      </span>
      {layout !== "wide" ? <BarButton icon={X} label={t("Close search")} testId="pdfx-action-search-close" tipAlign="end" onClick={close} /> : null}
    </div>
  );
}
