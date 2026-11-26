// The pointer and the keyboard on a grid of page tiles (pages/PageGrid.jsx): selection by click, Ctrl and
// Shift, the marquee of the organiser, dragging one or several pages to another place with a bar that shows
// where they land, scrolling while the pointer is near an edge, the page menu, double click.
//
// One set of handlers for the whole grid (on the scrolling element): a tile is found from the event target
// by its data-page-id. What moves with the pointer (the bar, the dragged stack, the marquee) is written to
// the DOM directly, so that a drag over hundreds of tiles re-renders nothing.
//
// Selection follows file managers: a press on a page that is not selected selects it at once; a press on a
// selected page waits for the release (so that several selected pages can be dragged together), Ctrl toggles,
// Shift takes the range from the anchor. A touch does not drag (it scrolls the list); a tap arrives as a
// click. "Move to position…" in the page menu is the way without dragging.
import { useEffect, useMemo, useRef } from "react";
import { t } from "../../../i18n/index.js";
import { useEditor } from "../ui/editorHooks.js";
import { run } from "./pageFlows.js";
import { clickSelection, directionOfKey, dropGapAt, dropTarget, edgeScrollSpeed, extendSelection, gridNeighbour, columnsOf, orderedSelection, tilesInBox } from "./pageLogic.js";
import { movePages } from "./pageOps.js";
import { getPagesState, openMenu, setSelection } from "./pagesState.js";

/** How far (CSS pixels) the pointer travels before a press becomes a drag. */
const DRAG_THRESHOLD = Object.freeze({ mouse: 4, pen: 6 });
const TILE = "[data-page-id]";

const tileOf = (target) => (target instanceof Element ? target.closest(TILE) : null);

/** Puts the keyboard on the tile of a page (and scrolls it into view). */
export function focusTile(grid, pageId, { scroll = true } = {}) {
  const tile = grid?.querySelector(`[data-page-id="${CSS.escape(pageId)}"]`);
  if (!tile) return false;
  tile.focus({ preventScroll: true });
  if (scroll) tile.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/** The tiles of a grid in document order with their top edges (for the columns of the arrow keys). */
export function tilesOf(grid) {
  return grid ? [...grid.querySelectorAll(TILE)] : [];
}

/**
 * @param {object} options
 * @param {"panel" | "organiser"} options.variant   the panel goes to a page on click; the organiser has the marquee
 * @param {{ current: Element | null }} options.scrollRef   the element that scrolls
 * @param {{ current: Element | null }} options.wrapRef     the positioned box around the listbox (bar and marquee live in it)
 * @param {{ current: Element | null }} options.gridRef     the listbox
 * @param {{ current: Element | null }} options.barRef      the drop bar
 * @param {{ current: Element | null }} options.ghostRef    what follows the pointer during a drag
 * @param {{ current: Element | null }} options.marqueeRef
 * @param {(pageId: string) => void} [options.onOpen]       double click on a page
 * @returns {{ onPointerDown, onClick, onDoubleClick, onContextMenu, onKeyDown }} handlers for the scrolling element
 *          (onKeyDown for the listbox)
 */
export function usePageGrid({ variant, scrollRef, wrapRef, gridRef, barRef, ghostRef, marqueeRef, onOpen }) {
  const editor = useEditor();
  const session = useRef(null); // the press, drag or marquee that is going on: { stop(commit) }
  const flags = useRef({ suppressClick: false, pressed: false, pointerType: "mouse" });
  const openRef = useRef(onOpen);

  useEffect(() => {
    openRef.current = onOpen;
  });

  // leaving the grid in the middle of a gesture ends it without a change
  useEffect(() => () => session.current?.stop(false), []);

  return useMemo(() => {
    const { actions, store, ui } = editor;
    const pageIds = () => store.getState().pages.map((page) => page.id);

    /** The boxes of all tiles relative to the positioned wrapper (they move with it when the list scrolls). */
    const measure = () => {
      const base = wrapRef.current.getBoundingClientRect();
      return tilesOf(gridRef.current).map((element) => {
        const box = element.getBoundingClientRect();
        return { id: element.getAttribute("data-page-id"), left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height };
      });
    };

    /** While something is dragged: the list scrolls when the pointer is near its top or bottom edge. */
    const edgeScroller = (onScrolled) => {
      let frame = 0;
      let pointerY = null;
      const tick = () => {
        const scroller = scrollRef.current;
        if (scroller && pointerY !== null) {
          const box = scroller.getBoundingClientRect();
          const speed = edgeScrollSpeed(pointerY - box.top, box.height);
          if (speed) {
            const before = scroller.scrollTop;
            scroller.scrollTop = before + speed;
            if (scroller.scrollTop !== before) onScrolled();
          }
        }
        frame = requestAnimationFrame(tick);
      };
      return {
        start() {
          if (!frame) frame = requestAnimationFrame(tick);
        },
        at(y) {
          pointerY = y;
        },
        stop() {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      };
    };

    const swallowNextClick = () => {
      flags.current.suppressClick = true;
      // the click that follows a release arrives in the same task chain; later clicks are real ones
      setTimeout(() => {
        flags.current.suppressClick = false;
      }, 0);
    };

    /** Window listeners of one gesture; returns the function that removes them. */
    const listen = (pointerId, { move, end }) => {
      const onMove = (event) => {
        if (event.pointerId === pointerId) move(event);
      };
      const onUp = (event) => {
        if (event.pointerId === pointerId) end(true, event);
      };
      const onCancel = (event) => {
        if (event.pointerId === pointerId) end(false, event);
      };
      const onKey = (event) => {
        if (event.key !== "Escape") return;
        // Escape belongs to the gesture: it must not leave the organiser as well
        event.preventDefault();
        event.stopPropagation();
        end(false, event);
      };
      const onBlur = () => end(false, null);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onBlur);
      };
    };

    // --- a press on a tile: a click, or the start of a drag ------------------------------------------------------

    function beginPress(event, pageId, deferred) {
      const start = { x: event.clientX, y: event.clientY };
      const threshold = DRAG_THRESHOLD[event.pointerType] || DRAG_THRESHOLD.mouse;
      let drag = null; // { ids, tiles, gap }
      let last = start;

      const place = () => {
        if (!drag) return;
        const base = wrapRef.current.getBoundingClientRect();
        const drop = dropGapAt(drag.tiles, last.x - base.left, last.y - base.top);
        drag.gap = drop ? drop.gap : null;
        const bar = barRef.current;
        if (bar && drop) {
          bar.hidden = false;
          bar.style.left = `${Math.round(drop.bar.x - 1.5)}px`;
          bar.style.top = `${Math.round(drop.bar.top)}px`;
          bar.style.height = `${Math.round(drop.bar.height)}px`;
        }
        if (drop) gridRef.current?.setAttribute("data-drop-gap", String(drop.gap));
        const ghost = ghostRef.current;
        if (ghost) ghost.style.transform = `translate(${Math.round(last.x + 14)}px, ${Math.round(last.y + 16)}px)`;
      };
      const scroller = edgeScroller(place);

      const startDrag = () => {
        // a document that cannot be changed is not reordered either (the reason was said when it opened)
        if (!actions.canEdit({ silent: true }) || ui.getState().job) return false;
        const list = pageIds();
        const state = getPagesState(ui);
        const together = state.selected.includes(pageId);
        const ids = together ? orderedSelection(list, state.selected) : [pageId];
        if (!together) setSelection(ui, { selected: [pageId], anchor: pageId, focus: pageId });
        drag = { ids, tiles: measure(), gap: null };
        const moving = new Set(ids);
        for (const element of tilesOf(gridRef.current)) if (moving.has(element.getAttribute("data-page-id"))) element.setAttribute("data-dragging", "true");
        gridRef.current?.setAttribute("data-dragging", "true");
        const ghost = ghostRef.current;
        if (ghost) {
          ghost.hidden = false;
          const label = ghost.querySelector("[data-ghost-count]");
          if (label) label.textContent = ids.length === 1 ? t("1 page") : t("{count} pages", { count: ids.length });
        }
        scroller.start();
        return true;
      };

      const clear = () => {
        scroller.stop();
        const grid = gridRef.current;
        grid?.removeAttribute("data-dragging");
        grid?.removeAttribute("data-drop-gap");
        for (const element of tilesOf(grid)) element.removeAttribute("data-dragging");
        if (barRef.current) barRef.current.hidden = true;
        if (ghostRef.current) ghostRef.current.hidden = true;
      };

      const stopListening = listen(event.pointerId, {
        move(moveEvent) {
          last = { x: moveEvent.clientX, y: moveEvent.clientY };
          if (!drag) {
            if (Math.hypot(last.x - start.x, last.y - start.y) < threshold) return;
            if (!startDrag()) return;
          }
          scroller.at(last.y);
          place();
        },
        end(commit) {
          session.current?.stop(commit);
        }
      });

      session.current = {
        stop(commit) {
          session.current = null;
          stopListening();
          const finished = drag;
          clear();
          if (finished) {
            swallowNextClick();
            if (commit && finished.gap !== null) {
              const target = dropTarget(pageIds(), finished.ids, finished.gap);
              if (target.changes) run(editor, movePages(editor, finished.ids, target.toIndex));
            }
          } else if (commit && deferred) {
            // a plain click on one of several selected pages: only that page stays selected
            setSelection(ui, clickSelection(pageIds(), getPagesState(ui), pageId));
          }
        }
      };
    }

    // --- the marquee of the organiser --------------------------------------------------------------------------

    function beginMarquee(event) {
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const base = additive ? [...getPagesState(ui).selected] : [];
      const origin = wrapRef.current.getBoundingClientRect();
      const start = { x: event.clientX - origin.left, y: event.clientY - origin.top, clientX: event.clientX, clientY: event.clientY };
      let last = { x: event.clientX, y: event.clientY };
      let tiles = null;

      const draw = () => {
        if (!tiles) return;
        const box = wrapRef.current.getBoundingClientRect();
        const x = last.x - box.left;
        const y = last.y - box.top;
        const marquee = marqueeRef.current;
        if (marquee) {
          marquee.hidden = false;
          marquee.style.left = `${Math.min(start.x, x)}px`;
          marquee.style.top = `${Math.min(start.y, y)}px`;
          marquee.style.width = `${Math.abs(x - start.x)}px`;
          marquee.style.height = `${Math.abs(y - start.y)}px`;
        }
        const hit = tilesInBox(tiles, start.x, start.y, x, y);
        setSelection(ui, { selected: orderedSelection(pageIds(), [...base, ...hit]) });
      };
      const scroller = edgeScroller(draw);

      const stopListening = listen(event.pointerId, {
        move(moveEvent) {
          last = { x: moveEvent.clientX, y: moveEvent.clientY };
          if (!tiles) {
            if (Math.hypot(last.x - start.clientX, last.y - start.clientY) < DRAG_THRESHOLD.mouse) return;
            tiles = measure();
            scroller.start();
          }
          scroller.at(last.y);
          draw();
        },
        end(commit) {
          session.current?.stop(commit);
        }
      });

      session.current = {
        stop(commit) {
          session.current = null;
          stopListening();
          scroller.stop();
          if (marqueeRef.current) marqueeRef.current.hidden = true;
          if (tiles) {
            swallowNextClick();
            if (!commit) setSelection(ui, { selected: base });
          } else if (commit && !additive) {
            // a click on the empty part of the grid: nothing is selected
            setSelection(ui, { selected: [] });
          }
        }
      };
    }

    // --- handlers ------------------------------------------------------------------------------------------------

    function onPointerDown(event) {
      flags.current.pointerType = event.pointerType || "mouse";
      flags.current.pressed = false;
      if (event.button !== 0 || session.current) return;
      if (event.pointerType === "touch") return; // a tap is handled as a click; a finger that moves scrolls
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest("button, a, input, select")) return;
      const tile = tileOf(target);
      if (!tile) {
        const scroller = scrollRef.current;
        if (variant !== "organiser" || !scroller) return;
        // a press on the scroll bar is not a press on the grid
        const box = scroller.getBoundingClientRect();
        if (event.clientX >= box.left + scroller.clientLeft + scroller.clientWidth || event.clientY >= box.top + scroller.clientTop + scroller.clientHeight) return;
        beginMarquee(event);
        return;
      }
      const pageId = tile.getAttribute("data-page-id");
      const state = getPagesState(ui);
      // the check box of a tile adds the page to the selection or takes it out, like Ctrl + click
      const ctrl = event.ctrlKey || event.metaKey || Boolean(target.closest("[data-pdfx-page-check]"));
      const shift = event.shiftKey;
      const waits = !ctrl && !shift && state.selected.includes(pageId);
      if (waits) setSelection(ui, { focus: pageId });
      else setSelection(ui, clickSelection(pageIds(), state, pageId, { ctrl, shift }));
      flags.current.pressed = true;
      tile.focus({ preventScroll: true });
      beginPress(event, pageId, waits);
    }

    function openPageMenu(tile, x, y) {
      const pageId = tile.getAttribute("data-page-id");
      const state = getPagesState(ui);
      const list = pageIds();
      let ids = orderedSelection(list, state.selected);
      if (!ids.includes(pageId)) {
        ids = [pageId];
        setSelection(ui, { selected: ids, anchor: pageId, focus: pageId });
      }
      openMenu(ui, { kind: "page", x, y, pageIds: ids, origin: tile, token: Date.now() });
    }

    function onClick(event) {
      if (flags.current.suppressClick) {
        flags.current.suppressClick = false;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const tile = tileOf(target);
      if (!tile) return;
      const more = target.closest("[data-pdfx-page-menu]");
      if (more) {
        const box = more.getBoundingClientRect();
        openPageMenu(tile, box.left, box.bottom);
        return;
      }
      const pageId = tile.getAttribute("data-page-id");
      const ctrl = event.ctrlKey || event.metaKey || Boolean(target.closest("[data-pdfx-page-check]"));
      const shift = event.shiftKey;
      if (!flags.current.pressed) {
        // no press came before this click: a tap, or a click made by assistive technology
        const touch = flags.current.pointerType === "touch";
        setSelection(ui, clickSelection(pageIds(), getPagesState(ui), pageId, { ctrl: ctrl || (touch && variant === "organiser"), shift }));
        tile.focus({ preventScroll: true });
      }
      flags.current.pressed = false;
      if (variant === "panel" && !ctrl && !shift) actions.goToPage(pageId);
    }

    function onDoubleClick(event) {
      const tile = tileOf(event.target);
      if (!tile || event.target.closest?.("button")) return;
      openRef.current?.(tile.getAttribute("data-page-id"));
    }

    function onContextMenu(event) {
      const tile = tileOf(event.target);
      if (!tile) return;
      event.preventDefault();
      openPageMenu(tile, event.clientX, event.clientY);
    }

    /** Keys the listbox handles itself; everything else goes to the editor's key dispatcher (pages/pageCommands.js). */
    function onKeyDown(event) {
      const grid = gridRef.current;
      const tile = tileOf(event.target);
      if (!grid || !tile) return;
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        const box = tile.getBoundingClientRect();
        openPageMenu(tile, box.left + 16, box.top + Math.min(40, box.height / 2));
        return;
      }
      const direction = directionOfKey(event.key);
      if ((direction === "home" || direction === "end") && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        const tiles = tilesOf(grid);
        const list = tiles.map((element) => element.getAttribute("data-page-id"));
        const next = list[gridNeighbour(tiles.indexOf(tile), tiles.length, columnsOf(tiles.map((element) => element.offsetTop)), direction)];
        if (!next) return;
        if (event.shiftKey) setSelection(ui, extendSelection(list, getPagesState(ui), next));
        else setSelection(ui, { focus: next, anchor: next });
        focusTile(grid, next);
      }
    }

    return { onPointerDown, onClick, onDoubleClick, onContextMenu, onKeyDown };
  }, [editor, variant, scrollRef, wrapRef, gridRef, barRef, ghostRef, marqueeRef]);
}
