import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, ListTree } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { sourcesInUse } from "../model/selectors.js";
import { useDocument, useEditor, useViewer } from "../ui/editorHooks.js";
import { buildOutlineTree, countOutline, currentOutlineKey, expandableKeys, outlineKeyAction, visibleOutlineRows } from "./pageLogic.js";
import "../styles/pages.css";

// The Outline panel (UX specification 7.2): the bookmarks of the source files as a tree, read-only. With
// several source files each outline hangs under its file name. An entry points at the page of the working
// document that shows its page of the source: it follows pages that were moved and disappears with pages
// that were deleted (an entry that still has entries under it stays as a heading). A click, Enter or Space
// goes to the page; the entry the reader is in is marked.
//
// Keyboard (the APG tree view): Up / Down between the rows, Right opens a node or goes to its first child,
// Left closes it or goes to its parent, Home / End, * opens the nodes of a level. One tab stop.
//
// Test hooks: pdfx-outline (data-entries), pdfx-outline-empty, pdfx-outline-row (data-key, data-level,
// data-page-number, data-current, aria-expanded), pdfx-outline-toggle.

/** A small outline starts fully open; a large one shows its first level. */
const OPEN_ALL_BELOW = 40;

export default function OutlinePanel() {
  const { t } = useI18n();
  const { actions, viewer } = useEditor();
  const pages = useDocument((state) => state.pages);
  const sources = useDocument((state) => state.sources);
  const currentPageNumber = useViewer((state) => state.currentPageNumber);
  const treeRef = useRef(null);

  const used = useMemo(() => sourcesInUse({ pages, sources }), [pages, sources]);
  // the facts of a file never change while it is open: the list of ids says when to read them again
  const usedKey = used.map((source) => source.id).join("|");
  const nodes = useMemo(
    () =>
      buildOutlineTree(
        used.map((source) => ({ id: source.id, name: source.name, outline: viewer.getSourceFacts(source.id)?.outline || [] })),
        pages
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `used` changes identity with every page operation; its ids are what matter
    [usedKey, pages, viewer]
  );
  const total = useMemo(() => countOutline(nodes), [nodes]);

  // what the user opened or closed by hand; until then a default by the size of the outline
  const [toggled, setToggled] = useState(() => new Map());
  const [focusKey, setFocusKey] = useState(null);
  const expanded = useMemo(() => {
    const open = new Set(expandableKeys(nodes, total <= OPEN_ALL_BELOW ? Infinity : 1));
    for (const [key, state] of toggled) {
      if (state) open.add(key);
      else open.delete(key);
    }
    return open;
  }, [nodes, total, toggled]);
  const rows = useMemo(() => visibleOutlineRows(nodes, expanded), [nodes, expanded]);
  const currentKey = useMemo(() => currentOutlineKey(nodes, currentPageNumber), [nodes, currentPageNumber]);

  if (!pages.length || !rows.length) {
    return (
      <div className="pdfx-outline-empty" data-testid="pdfx-outline-empty">
        <ListTree size={24} strokeWidth={1.5} aria-hidden="true" />
        <p>{t("This document has no outline.")}</p>
      </div>
    );
  }

  const tabbable = rows.some((row) => row.key === focusKey) ? focusKey : rows[0].key;
  const setOpen = (key, open) => setToggled((current) => new Map(current).set(key, open));
  const focusRow = (key) => {
    setFocusKey(key);
    // the row exists already unless a node was just opened: then it is focused after the next paint
    const find = () => treeRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`);
    const row = find();
    if (row) row.focus();
    else requestAnimationFrame(() => find()?.focus());
  };
  const activate = (row) => {
    if (!row.node.pageId) return;
    setFocusKey(row.key);
    if (!viewer.scrollToPage(row.node.pageId, row.node.rect ? { rect: row.node.rect } : {})) actions.goToPage(row.node.pageId);
  };

  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.target.closest?.("[data-key]")?.getAttribute("data-key") || tabbable;
    const action = outlineKeyAction(rows, key, event.key);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.focus) focusRow(action.focus);
    if (action.expand) setOpen(action.expand, true);
    if (action.collapse) setOpen(action.collapse, false);
    if (action.expandSiblings) setToggled((current) => {
      const next = new Map(current);
      for (const sibling of action.expandSiblings) next.set(sibling, true);
      return next;
    });
    if (action.activate) activate(rows.find((row) => row.key === action.activate));
  };

  return (
    <div className="pdfx-outline" data-testid="pdfx-outline" data-entries={total}>
      <ul ref={treeRef} role="tree" aria-label={t("Outline")} className="pdfx-outline-tree" onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const { node } = row;
          const Twisty = row.expanded ? ChevronDown : ChevronRight;
          return (
            <li
              key={row.key}
              role="treeitem"
              aria-level={row.level}
              aria-setsize={row.setSize}
              aria-posinset={row.posInSet}
              aria-expanded={row.expandable ? (row.expanded ? "true" : "false") : undefined}
              aria-current={row.key === currentKey ? "location" : undefined}
              aria-label={node.pageNumber ? t("{title}, page {page}", { title: node.title || t("Untitled"), page: node.pageNumber }) : node.title || t("Untitled")}
              tabIndex={row.key === tabbable ? 0 : -1}
              className="pdfx-outline-row"
              style={{ "--pdfx-outline-level": row.level }}
              data-key={row.key}
              data-level={row.level}
              data-page-number={node.pageNumber || ""}
              data-has-page={node.pageId ? "true" : "false"}
              data-file={node.file ? "true" : "false"}
              data-current={row.key === currentKey ? "true" : "false"}
              data-testid="pdfx-outline-row"
              onClick={(event) => {
                if (event.target.closest("[data-outline-toggle]")) {
                  setOpen(row.key, !row.expanded);
                  setFocusKey(row.key);
                  return;
                }
                if (node.pageId) activate(row);
                else if (row.expandable) setOpen(row.key, !row.expanded);
                setFocusKey(row.key);
              }}
            >
              <span className="pdfx-outline-twisty" aria-hidden="true" data-expandable={row.expandable ? "true" : "false"} data-outline-toggle={row.expandable ? "true" : undefined} data-testid={row.expandable ? "pdfx-outline-toggle" : undefined}>
                {row.expandable ? <Twisty size={14} strokeWidth={2} /> : node.file ? <FileText size={13} strokeWidth={1.75} /> : null}
              </span>
              <span className="pdfx-outline-title">{node.title || t("Untitled")}</span>
              {node.pageNumber ? <span className="pdfx-outline-page">{node.pageNumber}</span> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
