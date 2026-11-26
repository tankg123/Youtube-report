// Editing a text object in place. ONE element at the layout scale serves for typing and for the committed
// text (TextBox.jsx renders the same element with the same style), so nothing moves when editing ends: not a
// line break, not a pixel. The other design, typing at the real size and showing the layout afterwards, was
// measured and rejected: in Chrome and Edge 157 it changes the line breaks of about 1 box in 100 and moves
// lines by one to two device pixels when editing ends.
//
// The price of the layout scale is what the browser itself draws inside the element: the transform thins
// its caret and its composition underline to a fraction of a device pixel. The caret is therefore hidden
// (caret-color: transparent) and drawn here, from the box the browser reports for the collapsed selection:
// one CSS pixel wide, on the device pixel grid, in a layer of its own that is NOT scaled (a browser snaps
// boxes to whole pixels of their own coordinate system before it applies transforms, so a caret inside the
// scaled box would be thin or smeared at most zoom levels). The text an input method is composing gets a
// line of the same kind under it.
//
// The element is contenteditable="plaintext-only" ("true" where a browser does not know that value, with
// Enter turned into a line break and formatting commands refused). Its content belongs to the browser:
// React never renders into it, and nothing here writes to the DOM or to the selection while the user types
// or an input method composes (Unikey Telex / VNI send Backspace plus the composed letter, the Windows
// keyboards use composition events: both just work). Paste and drop are taken over, because the browser's
// own paste leaves <div> children behind: the text is normalised and inserted as plain text in one undo step.
//
// Props
//   object         the text object being edited (model/schema.js); its `text` is the starting text
//   service        the text layout service (required): live size, fonts
//   geometry       { view, rotate, userUnit } of the page (schema.pageGeometry)
//   scale          CSS pixels per point of the page view (default 1)
//   extraRotation  the rotation the user added to the page (default 0)
//   ariaLabel      the accessible name of the text field (a translated sentence from the caller)
//   onChange(text, { composing })        after every input: the normalised text so far
//   onResize({ w, h }, frame, layout)    when the size of the box changes: the size in points, the frame the
//                                        box now occupies (layoutCore.frameForLayout: w and h are its
//                                        w / h, a wrapping box keeps its width) and the live layout
//   onCommit(text, { reason })           editing ended and the text differs from the one it started with;
//                                        a blank text (fontSupport.isBlankText) means: remove the box
//   onCancel({ reason })                 editing ended and nothing changed (a new box left empty included)
//                                        reason: "escape" | "enter" (Ctrl / Cmd + Enter) | "tab" | "blur" | "api"
//   onError(error)                       a font could not be loaded: a PdfEditorError with a TEXT_FONT_ code
//   autoFocus      focus the field when it appears (default true)
//   selectAll      select the whole text instead of putting the caret at its end (default false)
//   ref            { commit(reason?), focus(), getText(), element }: call commit() before a tool change
//                  takes the editor away (unmounting alone does not commit)
// Mount one editor per editing session (key it by the object's id): `object.text` is read once. The other
// fields of `object` may change while it is open (font, size, colour, alignment, a new wrap width): the
// text in the element stays, with its caret and its undo history.
// Escape, Ctrl / Cmd + Enter, Tab and losing the focus end the session (UX specification 5.2 and 7.3); nothing
// discards what was typed. A control that must not end it (a font button) keeps the focus where it is by
// preventing the default of its pointerdown / mousedown.
// The component renders two siblings into the page element: the box and the caret layer.
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { frameToCssMatrix } from "../engine/geometry.js";
import { MARKER_SPAN, caretPoint, editableDomText, editableModelText, insertPlainText, localMap, rangeOfText, selectAllText, setCaretOffset, supportsPlaintextOnly, textOffsetOf } from "./caret.js";
import { normalizeText } from "./fontSupport.js";
import { frameForLayout } from "./layoutCore.js";
import { LAYOUT_SCALE, TEXT_BOX_ATTRIBUTES, layoutScaleTransform, textBoxStyle } from "./textStyle.js";
import "../styles/text.css";

const px = (points) => `${points * LAYOUT_SCALE}px`;
const MARKER_STYLE = { position: "absolute", width: 0, height: 0, visibility: "hidden", pointerEvents: "none" };
const LAYER_STYLE = { position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none" };
const TAKEN_OVER = new Set(["insertFromPaste", "insertFromDrop", "insertFromYank"]);

function tryLayout(service, object, fontsVersion) {
  void fontsVersion; // a face that finished loading makes a layout possible that was not before
  try {
    return service.layout(object);
  } catch {
    return null;
  }
}

/** A caret that shows on white paper: the text colour, unless that is too light to see. */
function caretColor(color) {
  const value = /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000";
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#1f2937" : value;
}

export default function TextEditor({ object, service, geometry, scale = 1, extraRotation = 0, ariaLabel, onChange, onResize, onCommit, onCancel, onError, autoFocus = true, selectAll = false, ref }) {
  const editableRef = useRef(null);
  const caretRef = useRef(null);
  const marksRef = useRef(null);
  // zero-size markers at known positions: of the box (scaled, perhaps turned) and of the caret layer
  const boxOriginRef = useRef(null);
  const boxXRef = useRef(null);
  const boxYRef = useRef(null);
  const layerOriginRef = useRef(null);
  const layerXRef = useRef(null);
  const layerYRef = useRef(null);
  // `composition`: where the text an input method is composing starts, and how long it is (UTF-16 units)
  const session = useRef({ started: object.text, done: false, composing: false, composition: null, reported: null });
  const latest = useRef(null);

  const [text, setText] = useState(object.text);
  const [plaintextOnly] = useState(() => supportsPlaintextOnly(document));
  const fonts = service.fonts;
  const fontsVersion = useSyncExternalStore(fonts.subscribe, fonts.getVersion);
  const liveObject = useMemo(() => (text === object.text ? object : { ...object, text }), [object, text]);
  const live = useMemo(() => tryLayout(service, liveObject, fontsVersion), [service, liveObject, fontsVersion]);
  const frame = live ? frameForLayout(liveObject, live, geometry.userUnit || 1) : object.frame;
  const ink = caretColor(object.color);

  /** Draws the editor's own caret, and the line under composing text, where the browser's (too thin) ones are. */
  const updateCaret = (restartBlink) => {
    const caret = caretRef.current;
    const marks = marksRef.current;
    const editable = editableRef.current;
    const state = latest.current;
    if (!caret || !marks || !editable || !state) return;
    const doc = editable.ownerDocument;
    const focused = doc.activeElement === editable && Boolean(state.live);
    const box = focused ? localMap(boxOriginRef.current, boxXRef.current, boxYRef.current) : null;
    const layer = focused ? localMap(layerOriginRef.current, layerXRef.current, layerYRef.current) : null;
    const ratio = doc.defaultView.devicePixelRatio || 1;
    const onePixel = Math.max(1, Math.round(ratio)) / ratio; // one CSS pixel, a whole number of device pixels
    const snap = (value) => Math.round(value * ratio) / ratio;

    // the line under the text of a running composition (upright boxes: range boxes are axis-aligned)
    const composing = session.current.composition;
    const lines = [];
    if (composing && composing.length > 0 && box && layer && box.upright) {
      for (const rect of rangeOfText(doc, editable, composing.start, composing.start + composing.length).getClientRects()) {
        if (rect.width <= 0) continue;
        const [x, y] = layer.toLocal(snap(rect.left), snap(rect.bottom - Math.max(onePixel, rect.height * 0.08)));
        lines.push(`left:${x}px;top:${y}px;width:${rect.width / layer.scale}px;height:${onePixel / layer.scale}px`);
      }
    }
    while (marks.childNodes.length > lines.length) marks.lastChild.remove();
    lines.forEach((style, index) => {
      const line = marks.childNodes[index] || marks.appendChild(doc.createElement("div"));
      line.style.cssText = `position:absolute;${style};background-color:${state.ink}`;
    });

    const point = box && layer ? caretPoint(doc, editable) : null;
    if (!point) {
      caret.style.display = "none";
      return;
    }
    const metrics = state.live.metrics;
    const width = onePixel / box.scale; // in layout pixels
    const height = metrics.textHeight * LAYOUT_SCALE;
    const boxWidth = editable.offsetWidth;
    // the top end of the caret line in the box's own coordinates
    let left;
    let top;
    if (point.unknown) {
      // no box from the browser: the start of the last line, by the alignment
      const pitch = metrics.lineHeight * LAYOUT_SCALE;
      const align = state.object.align;
      left = align === "center" ? boxWidth / 2 : align === "right" ? boxWidth : 0;
      top = Math.max(0, editable.offsetHeight - pitch) + (pitch - height) / 2;
    } else {
      [left, top] = box.toLocal(point.x, point.y);
      top -= height / 2;
      // in a turned box the line is centred on the position, in an upright one it starts there
      if (!box.upright) left -= width / 2;
    }
    // like a native caret it stays inside the box at the right edge ...
    if (box.upright) left = Math.max(0, Math.min(left, boxWidth - width));
    let [clientX, clientY] = box.toClient(left, top);
    if (box.upright) {
      // ... and sits on the device pixel grid, so that it is one crisp line
      clientX = snap(clientX);
      clientY = snap(clientY);
    }
    const [x, y] = layer.toLocal(clientX, clientY);
    caret.style.width = `${onePixel / layer.scale}px`;
    caret.style.height = `${Math.max(1, (height * box.scale) / layer.scale)}px`;
    caret.style.transform = `translate(${x}px, ${y}px) rotate(${box.angle - layer.angle}rad)`;
    caret.style.display = "block";
    if (restartBlink) {
      // solid right after a key or a click, as a native caret is
      caret.style.animationName = "none";
      void caret.offsetWidth;
      caret.style.animationName = "";
    }
  };

  /** Ends the session once: onCommit when the text changed since it began, onCancel otherwise. */
  const finish = (reason) => {
    const state = session.current;
    const editable = editableRef.current;
    if (state.done || !editable) return;
    state.done = true;
    const final = editableModelText(editable);
    const callbacks = latest.current || {};
    if (final === state.started) callbacks.onCancel?.({ reason });
    else callbacks.onCommit?.(final, { reason });
    state.started = final;
  };

  const readInput = () => {
    const editable = editableRef.current;
    if (!editable) return;
    const next = editableModelText(editable);
    session.current.done = false; // typing after a commit the owner did not act on is a new session
    setText(next);
    latest.current?.onChange?.(next, { composing: session.current.composing });
  };

  // the newest props and layout for the listeners below, which are attached once
  useLayoutEffect(() => {
    latest.current = { object: liveObject, live, frame, ink, onChange, onResize, onCommit, onCancel, onError, autoFocus, selectAll, updateCaret };
  });

  useImperativeHandle(ref, () => ({
    commit: (reason = "api") => finish(reason),
    focus: () => editableRef.current?.focus({ preventScroll: true }),
    getText: () => (editableRef.current ? editableModelText(editableRef.current) : ""),
    get element() {
      return editableRef.current;
    }
  }));

  // the content of the editable element is set once and belongs to the browser from then on
  useLayoutEffect(() => {
    const editable = editableRef.current;
    const doc = editable.ownerDocument;
    if (editable.dataset.pdfxFilled !== "true") {
      editable.textContent = editableDomText(session.current.started);
      editable.dataset.pdfxFilled = "true";
    }
    if (latest.current.autoFocus) {
      editable.focus({ preventScroll: true });
      if (latest.current.selectAll) selectAllText(doc, editable);
      else setCaretOffset(doc, editable, session.current.started.length);
    }
  }, []);

  // listeners React has no good equivalent for
  useEffect(() => {
    const editable = editableRef.current;
    const doc = editable.ownerDocument;
    const onBeforeInput = (event) => {
      if (event.isComposing) return;
      const type = event.inputType || "";
      if (TAKEN_OVER.has(type)) {
        event.preventDefault();
        if (type === "insertFromDrop") {
          // the selection is not at the drop position yet
          const target = event.getTargetRanges?.()[0];
          if (!target) return;
          const range = doc.createRange();
          range.setStart(target.startContainer, target.startOffset);
          range.setEnd(target.endContainer, target.endOffset);
          const selection = doc.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        insertPlainText(doc, normalizeText(event.data ?? event.dataTransfer?.getData("text/plain") ?? ""));
      } else if (editable.contentEditable !== "plaintext-only") {
        // the fallback element is a rich text field: keep it to plain lines
        if (type === "insertParagraph") {
          event.preventDefault();
          doc.execCommand("insertLineBreak");
        } else if (type.startsWith("format")) {
          event.preventDefault();
        }
      }
    };
    const onSelectionChange = () => latest.current?.updateCaret(true);
    editable.addEventListener("beforeinput", onBeforeInput);
    doc.addEventListener("selectionchange", onSelectionChange);
    return () => {
      editable.removeEventListener("beforeinput", onBeforeInput);
      doc.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  // fonts: the box face, and the fallback face at once so that the first Greek or Cyrillic letter does not
  // have to wait for a download
  const { font, bold, italic } = object;
  useEffect(() => {
    let cancelled = false;
    service.ensureFonts({ font, bold, italic, text: "" }, { fallback: true }).catch((error) => {
      if (!cancelled) latest.current?.onError?.(error);
    });
    return () => {
      cancelled = true;
    };
  }, [service, font, bold, italic]);

  // tell the owner when the box changes size: the size of the frame the box occupies (a wrapping box keeps
  // its width and only its height follows the text)
  useEffect(() => {
    if (!live) return;
    const state = session.current;
    const current = latest.current;
    const size = { w: current.frame.w, h: current.frame.h };
    if (state.reported && state.reported.w === size.w && state.reported.h === size.h) return;
    const first = state.reported === null;
    state.reported = size;
    // the size the owner already has is no news
    if (first && size.w === current.object.frame.w && size.h === current.object.frame.h) return;
    current.onResize?.(size, current.frame, live);
  }, [live]);

  // after every render (new text, zoom, rotation, fonts): the caret follows
  useLayoutEffect(() => {
    updateCaret(false);
  });

  const onKeyDown = (event) => {
    // an input method owns the keyboard while it composes (Escape and Enter belong to it then)
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const commit = event.key === "Escape" ? "escape" : event.key === "Tab" ? "tab" : event.key === "Enter" && (event.ctrlKey || event.metaKey) ? "enter" : null;
    if (!commit) return;
    event.preventDefault();
    event.stopPropagation(); // one Escape, one level: the editor's owner must not also clear the selection
    finish(commit);
  };

  const onBlur = (event) => {
    updateCaret(false);
    // the window lost the focus, not the field: typing goes on when the user comes back
    if (!event.currentTarget.ownerDocument.hasFocus()) return;
    finish("blur");
  };

  const onFocus = () => {
    session.current.done = false;
    updateCaret(true);
  };

  const onCompositionStart = (event) => {
    const editable = event.currentTarget;
    const doc = editable.ownerDocument;
    const selection = doc.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    session.current.composing = true;
    // reading only: the selection and the text are the input method's while it composes
    session.current.composition = range && editable.contains(range.startContainer) ? { start: textOffsetOf(doc, editable, range.startContainer, range.startOffset), length: 0 } : null;
  };

  const onCompositionUpdate = (event) => {
    if (session.current.composition) session.current.composition.length = (event.data || "").length;
  };

  const onCompositionEnd = () => {
    session.current.composing = false;
    session.current.composition = null;
    readInput();
    updateCaret(true);
  };

  const matrix = frameToCssMatrix(geometry, frame, scale, extraRotation);
  return (
    <>
      <div
        className="pdfx-text-editor"
        data-object-id={object.id}
        data-kind="text"
        data-editing="true"
        data-ready={live ? "true" : "false"}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: px(frame.w),
          height: px(frame.h),
          transformOrigin: "0 0",
          transform: layoutScaleTransform(matrix),
          "--pdfx-text-unit": LAYOUT_SCALE / scale
        }}
      >
        <div
          ref={editableRef}
          className="pdfx-text-editor-input"
          contentEditable={plaintextOnly ? "plaintext-only" : "true"}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          {...TEXT_BOX_ATTRIBUTES}
          style={{
            ...textBoxStyle(liveObject),
            outline: "none",
            caretColor: "transparent",
            cursor: "text",
            userSelect: "text",
            WebkitUserSelect: "text",
            // typing works before the faces are there, but nothing is shown in a wrong font
            opacity: live ? object.opacity : 0
          }}
          onInput={readInput}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          onFocus={onFocus}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionUpdate}
          onCompositionEnd={onCompositionEnd}
          onDragStart={(event) => event.preventDefault()}
        />
        {live?.underlines.map((rect, index) => (
          <div
            key={index}
            className="pdfx-textbox-rule"
            style={{ position: "absolute", left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h), backgroundColor: object.color, opacity: object.opacity, pointerEvents: "none" }}
          />
        ))}
        <span ref={boxOriginRef} aria-hidden="true" style={{ ...MARKER_STYLE, left: 0, top: 0 }} />
        <span ref={boxXRef} aria-hidden="true" style={{ ...MARKER_STYLE, left: MARKER_SPAN, top: 0 }} />
        <span ref={boxYRef} aria-hidden="true" style={{ ...MARKER_STYLE, left: 0, top: MARKER_SPAN }} />
      </div>
      <div className="pdfx-text-caret-layer" aria-hidden="true" style={LAYER_STYLE}>
        <span ref={layerOriginRef} style={{ ...MARKER_STYLE, left: 0, top: 0 }} />
        <span ref={layerXRef} style={{ ...MARKER_STYLE, left: MARKER_SPAN, top: 0 }} />
        <span ref={layerYRef} style={{ ...MARKER_STYLE, left: 0, top: MARKER_SPAN }} />
        <div ref={marksRef} className="pdfx-text-composition" style={LAYER_STYLE} />
        <div ref={caretRef} className="pdfx-text-caret" style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", display: "none", backgroundColor: ink }} />
      </div>
    </>
  );
}
