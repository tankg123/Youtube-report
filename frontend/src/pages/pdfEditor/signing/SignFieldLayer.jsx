import { useEffect, useRef } from "react";
import { useI18n } from "../../../context/I18nContext";
import { pageScreen } from "../model/shapes.js";
import { resizeCursor } from "../model/transform.js";
import { SIGNATURE_FIELD_ID, SIGNATURE_FIELD_TYPE } from "../tools/interaction.js";
import { useDocument, useEditor, useInteraction } from "../ui/editorHooks.js";
import { clearField, nudgeField } from "./certSignFlow.js";
import { FIELD_HANDLES, fieldScreenBox, liveField } from "./fieldGeometry.js";
import { useSigningBag, useStampPreview } from "./signingHooks.js";
import "../styles/signing.css";

// What the signing feature draws over a page (the `pageOverlay` of its manifest):
//
//   * the rectangle of a visible certificate signature, with the real stamp inside. In the position step of
//     the drawer a layer over every page takes the pointer and feeds the interaction reducer
//     (tools/interaction.js): a drag on empty paper draws a rectangle with the certSign tool; the rectangle
//     itself is the pseudo object SIGNATURE_FIELD_ID, moved by its body and resized by its eight handles like
//     any selected object. The reducer answers with "create" / "move" / "resize" effects, which
//     certSignFlow.js turns into the field of the flow. While a gesture runs the rectangle is drawn from the
//     reducer's gesture (fieldGeometry.js liveField), so what is seen is what the release will give.
//     The layer listens natively and stops the events: the overlay feature under it must not see a gesture
//     that is not about an object of the document.
//   * the outline of "Go to signature" (two seconds).
//
// Keyboard: the rectangle takes the focus (Tab); the arrow keys move it by 1 pt, with Shift by 10 pt; Delete
// removes it. Presets and numbers are in the drawer.
//
// Test hooks: pdfx-sign-capture (the pointer layer of a page), pdfx-sign-field (data-page-id, data-left,
// data-top, data-width, data-height in points as the reader sees the page; data-stamp "true" when the stamp is
// painted), pdfx-sign-handle (data-sign-handle), pdfx-sign-flash.

function Flash({ page, view, rect }) {
  const [left, top, right, bottom] = pageScreen(page).rectToScreen(rect);
  const { scale } = view;
  return <div className="pdfx-sign-flash" data-testid="pdfx-sign-flash" style={{ left: left * scale - 4, top: top * scale - 4, width: (right - left) * scale + 8, height: (bottom - top) * scale + 8 }} />;
}

function FieldOnPage({ page, view, flow }) {
  const { t } = useI18n();
  const editor = useEditor();
  const interaction = useInteraction();
  const pages = useDocument((state) => state.pages);
  const captureRef = useRef(null);
  const fieldRef = useRef(null);
  const { ui, viewer } = editor;
  const capturing = flow.positioning && (interaction.tool === "certSign" || interaction.tool === "select") && !interaction.spaceHeld;
  const scaleOf = (pageId) => (pageId === page.id ? view.scale : viewer.getPageView(pageId)?.scale || view.scale);
  const field = flow.positioning ? liveField(flow.field, interaction, { pages, scaleOf }) : flow.field;
  const box = field && field.pageId === page.id ? fieldScreenBox(field, page) : null;
  const preview = useStampPreview(box?.width, box?.height, Boolean(box));
  const pageId = page.id;

  useEffect(() => {
    const element = captureRef.current;
    if (!element || !capturing) return undefined;
    let pointer = null;
    const place = (event) => {
      const origin = element.getBoundingClientRect();
      return { x: event.clientX - origin.left, y: event.clientY - origin.top };
    };
    // the page under the pointer and the position inside IT: a rectangle can be dragged to another page
    const over = (event) => {
      const id = viewer.pageAtPoint(event.clientX, event.clientY);
      const target = id ? viewer.getPageView(id)?.element : null;
      if (!target) return null;
      const origin = target.getBoundingClientRect();
      return { pageId: id, x: event.clientX - origin.left, y: event.clientY - origin.top };
    };
    const targetOf = (event) => {
      const node = event.target instanceof Element ? event.target : null;
      const handle = node?.closest("[data-sign-handle]");
      if (handle) return { kind: "handle", id: SIGNATURE_FIELD_ID, handle: handle.getAttribute("data-sign-handle") };
      if (node?.closest("[data-sign-field]")) return { kind: "object", id: SIGNATURE_FIELD_ID, type: SIGNATURE_FIELD_TYPE };
      return { kind: "page" };
    };
    const onDown = (event) => {
      if (event.button !== 0 || pointer !== null) return;
      event.stopPropagation();
      event.preventDefault();
      const target = targetOf(event);
      if (target.kind === "page") {
        // empty paper: a new rectangle is drawn (it replaces the one that is there)
        if (ui.getState().interaction.tool !== "certSign") ui.runInteraction({ type: "tool", tool: "certSign" });
      } else {
        if (ui.getState().interaction.tool !== "select") ui.runInteraction({ type: "tool", tool: "select" });
        if (!ui.getState().interaction.selection.includes(SIGNATURE_FIELD_ID)) ui.runInteraction({ type: "setSelection", ids: [SIGNATURE_FIELD_ID] });
        fieldRef.current?.focus({ preventScroll: true });
      }
      pointer = event.pointerId;
      element.setPointerCapture?.(pointer);
      ui.runInteraction({ type: "pointerdown", pageId, ...place(event), button: 0, pointerType: event.pointerType || "mouse", target, shift: event.shiftKey, alt: false });
    };
    const onMove = (event) => {
      if (event.pointerId !== pointer) return;
      event.stopPropagation();
      ui.runInteraction({ type: "pointermove", ...place(event), shift: event.shiftKey, over: over(event) });
    };
    const release = () => {
      if (pointer !== null && element.hasPointerCapture?.(pointer)) element.releasePointerCapture(pointer);
      pointer = null;
    };
    const onUp = (event) => {
      if (event.pointerId !== pointer) return;
      event.stopPropagation();
      const position = place(event);
      const target = over(event);
      release();
      ui.runInteraction({ type: "pointerup", ...position, over: target });
    };
    const onCancel = (event) => {
      if (event.pointerId !== pointer) return;
      release();
      ui.runInteraction({ type: "pointercancel" });
    };
    // a click must not reach what lies under the layer either
    const swallow = (event) => event.stopPropagation();
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onCancel);
    element.addEventListener("click", swallow);
    element.addEventListener("dblclick", swallow);
    element.addEventListener("contextmenu", swallow);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.removeEventListener("click", swallow);
      element.removeEventListener("dblclick", swallow);
      element.removeEventListener("contextmenu", swallow);
      if (pointer !== null) {
        release();
        ui.runInteraction({ type: "pointercancel" });
      }
    };
  }, [capturing, pageId, ui, viewer]);

  const { scale } = view;
  const pageNumber = pages.findIndex((candidate) => candidate.id === page.id) + 1;
  const rectangle = box ? (
    <div
      ref={fieldRef}
      className="pdfx-sign-field"
      role="group"
      aria-label={t("Signature rectangle on page {number}", { number: pageNumber })}
      tabIndex={flow.positioning ? 0 : undefined}
      data-sign-field="true"
      data-object-id={capturing ? SIGNATURE_FIELD_ID : undefined}
      data-kind={capturing ? SIGNATURE_FIELD_TYPE : undefined}
      data-active={flow.positioning ? "true" : "false"}
      data-page-id={page.id}
      data-left={box.left.toFixed(2)}
      data-top={box.top.toFixed(2)}
      data-width={box.width.toFixed(2)}
      data-height={box.height.toFixed(2)}
      data-stamp={preview && !preview.empty ? "true" : "false"}
      data-testid="pdfx-sign-field"
      style={{ left: box.left * scale, top: box.top * scale, width: box.width * scale, height: box.height * scale }}
      onKeyDown={(event) => {
        if (!flow.positioning) return;
        if (event.key.startsWith("Arrow")) {
          if (nudgeField(editor, event.key, event.shiftKey ? 10 : 1)) {
            event.preventDefault();
            event.stopPropagation();
          }
        } else if (event.key === "Delete") {
          event.preventDefault();
          event.stopPropagation();
          clearField(editor);
        }
      }}
    >
      {preview && !preview.empty ? <img src={preview.url} alt="" draggable={false} /> : null}
      {flow.positioning ? FIELD_HANDLES.map((handle) => <span key={handle} className="pdfx-sign-handle" data-sign-handle={handle} data-testid="pdfx-sign-handle" style={{ cursor: resizeCursor(handle, 0) }} />) : null}
    </div>
  ) : null;

  if (!capturing) return rectangle;
  return (
    <div ref={captureRef} className="pdfx-sign-capture" data-tool={interaction.tool} data-testid="pdfx-sign-capture">
      {rectangle}
    </div>
  );
}

export default function SignFieldLayer({ page, view }) {
  const bag = useSigningBag();
  const flow = bag?.flow || null;
  const flash = bag?.flash && bag.flash.pageId === page.id ? bag.flash : null;
  const shown = Boolean(flow && flow.visible && (flow.positioning || flow.field?.pageId === page.id));
  if (!shown && !flash) return null;
  return (
    <>
      {shown ? <FieldOnPage page={page} view={view} flow={flow} /> : null}
      {flash ? <Flash key={flash.token} page={page} view={view} rect={flash.rect} /> : null}
    </>
  );
}
