import { useCallback, useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { isMark } from "../model/schema.js";
import TextEditor from "../text/TextEditor.jsx";
import { NEW_ID } from "../tools/interaction.js";
import { useEditor } from "../ui/editorHooks.js";
import { HANDLE_HIT, outlineOf, polygonPath, quadToPixels, selectionLayout, userRectToPixels } from "./geometry.js";
import { MarkReach } from "./MarkReach.jsx";
import { MarkView, ObjectView } from "./ObjectView.jsx";
import { GHOST_ID } from "./preview.js";
import { getRuntime } from "./runtime.js";
import "../styles/overlay.css";

// Everything the user added to ONE page, drawn over it where the export will draw it (UX specification 5):
//
//   div.pdfx-ov
//     marks            pending redactions and blur areas: they act on the original page, so they lie lowest;
//                      with each, the outline of the letters it takes beyond its own rectangle (MarkReach.jsx)
//     covers           the original line of every replaced text, painted over in its background colour
//     objects          bottom to top, each with data-object-id and data-kind (ObjectView.jsx); the object
//                      that is being typed in is a text/TextEditor.jsx instead of a TextBox
//     previews         what the running gesture would create (same components, same factories as the commit)
//     svg.pdfx-ov-chrome   outlines: selection, selection rectangle, the text a tool is about to take
//     handles          8 px squares on the outline of the ONE selected object, and its rotation handle
//
// While a gesture runs nothing of this is in the document: the overlay draws the preview that
// runtime.preview() computes from the interaction state, and the document changes once, on pointer-up.
// The pointer itself is handled for all pages together in overlay/pointer.js.
//
// The component renders from two snapshots: the objects of its page (stable while they do not change) and
// runtime.pageSlice(page.id), the part of the UI state this page shows. A drag on one page therefore
// re-renders one overlay, however many pages the document has.

/** The handles and the outline of the selection (and everything else that is only an outline). */
function Chrome({ page, view, selected, slice, runtime }) {
  const { t } = useI18n();
  const { scale } = view;
  const { preview, hover } = slice;
  const editing = slice.mode === "editingText";
  const layouts = selected.filter((object) => object.id !== slice.editingId).map((object) => ({ object, layout: selectionLayout(object, page, scale) }));
  const withHandles = slice.single && !editing && layouts.length === 1 ? layouts[0] : null;
  const lines = hover?.kind === "line" || preview?.textMark ? runtime.linesNow(page.id) : null;
  const hoverLine = hover?.kind === "line" && lines ? lines[hover.index] : null;
  const hoverErase = hover?.kind === "erase" ? runtime.editor.store.getState().objects[hover.id] : null;
  const marquee = preview?.marquee?.pageId === page.id ? preview.marquee.rect : null;
  const textArea = preview?.textArea?.pageId === page.id ? preview.textArea.frame : null;
  const textMark = preview?.textMark?.pageId === page.id ? preview.textMark : null;
  const erased = preview?.erased?.size ? [...preview.erased].map((id) => runtime.editor.store.getState().objects[id]).filter((object) => object && object.pageId === page.id) : [];
  const nothing = !layouts.length && !hoverLine && !hoverErase && !marquee && !textArea && !textMark && !erased.length;
  if (nothing) return null;
  return (
    <>
      <svg className="pdfx-ov-chrome" width={view.width} height={view.height} aria-hidden="true">
        {textMark
          ? textMark.quads.map((quad, index) => <path key={`mark${index}`} className="pdfx-ov-textmark" data-tool={textMark.tool} d={polygonPath(quadToPixels(page, quad, scale))} />)
          : null}
        {hoverLine ? <path className="pdfx-ov-hover-line" data-testid="pdfx-hover-line" d={polygonPath(quadToPixels(page, hoverLine.quad, scale))} /> : null}
        {[hoverErase, ...erased].filter(Boolean).flatMap((object) => outlineOf(object, page, scale).map((polygon, index) => <path key={`erase${object.id}${index}`} className="pdfx-ov-erase" d={polygonPath(polygon, polygon.length > 2)} />))}
        {layouts.flatMap(({ object, layout }) =>
          layout.polygons.map((polygon, index) => <path key={`${object.id}:${index}`} className="pdfx-ov-outline" data-outline-of={object.id} d={polygonPath(polygon, polygon.length > 2)} />)
        )}
        {withHandles?.layout.rotate ? (
          <line className="pdfx-ov-stem" x1={withHandles.layout.rotate.anchorX} y1={withHandles.layout.rotate.anchorY} x2={withHandles.layout.rotate.x} y2={withHandles.layout.rotate.y} />
        ) : null}
        {textArea ? <path className="pdfx-ov-rubber" d={polygonPath(outlineOf({ frame: textArea }, page, scale)[0])} /> : null}
        {marquee ? <rect className="pdfx-ov-marquee" x={marquee.x} y={marquee.y} width={marquee.width} height={marquee.height} /> : null}
      </svg>
      {withHandles
        ? withHandles.layout.handles.map((handle) => (
            <div
              key={handle.id}
              className="pdfx-ov-handle"
              data-handle={handle.id}
              data-handle-of={withHandles.object.id}
              style={{ left: `${handle.x - HANDLE_HIT / 2}px`, top: `${handle.y - HANDLE_HIT / 2}px`, cursor: handle.cursor }}
            />
          ))
        : null}
      {withHandles?.layout.rotate ? (
        <div
          className="pdfx-ov-handle pdfx-ov-handle-rotate"
          data-handle="rotate"
          data-handle-of={withHandles.object.id}
          style={{ left: `${withHandles.layout.rotate.x - HANDLE_HIT / 2}px`, top: `${withHandles.layout.rotate.y - HANDLE_HIT / 2}px` }}
        />
      ) : null}
      {layouts.map(({ object, layout }) => {
        // in the file an annotation of the source page (a form field, a stamp, a note) is painted ABOVE what the user added
        const annotation = layout.box && slice.mode === "idle" ? runtime.annotationUnder(object, page) : null;
        if (!annotation) return null;
        return (
          <div
            key={`note${object.id}`}
            className="pdfx-ov-notice"
            role="note"
            tabIndex={-1}
            data-testid="pdfx-annotation-notice"
            data-notice-of={object.id}
            data-subtype={annotation.subtype}
            aria-label={t("In the downloaded file this object lies under a form field, stamp or comment of the original page.")}
            data-tip={t("In the downloaded file this object lies under a form field, stamp or comment of the original page.")}
            data-tip-align="end"
            style={{ left: `${layout.box[2]}px`, top: `${layout.box[1]}px` }}
          >
            <TriangleAlert size={12} strokeWidth={2.25} aria-hidden="true" />
          </div>
        );
      })}
    </>
  );
}

/** The text box that is being typed in: a new one (a draft) or an existing one. */
function EditorHost({ object, view, editor }) {
  const { t } = useI18n();
  const { actions, messages, textService } = editor;
  // the session of the box lives in the runtime (overlay/runtime.js): the component only reports to it
  const attach = useCallback((handle) => getRuntime(editor).setEditorHandle(handle), [editor]);
  const changed = useCallback((text, details) => getRuntime(editor).editorChanged(text, details), [editor]);
  const ended = useCallback((first, second) => getRuntime(editor).endEditing((second || first)?.reason), [editor]);
  return (
    <TextEditor
      key={object.id}
      ref={attach}
      object={object}
      service={textService}
      geometry={view.geometry}
      scale={view.scale}
      extraRotation={view.extraRotation}
      ariaLabel={t("Text of the text box")}
      onChange={changed}
      onCommit={ended}
      onCancel={ended}
      onError={(error) => actions.hint("textFont", messages.describeError(error), "error")}
    />
  );
}

/** The original line of a replaced text, covered on screen as the export covers or removes it. */
function Cover({ object, page, view }) {
  const [left, top, right, bottom] = userRectToPixels(page, object.replaces.rect, view.scale);
  return <div className="pdfx-ov-cover" data-cover-of={object.id} style={{ left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`, backgroundColor: object.replaces.cover || "#ffffff" }} />;
}

export default function PageOverlay({ page, view }) {
  const editor = useEditor();
  const runtime = getRuntime(editor);
  const { store, ui } = editor;
  const layers = useSyncExternalStore(store.subscribe, () => runtime.objectsOfPage(page.id));
  const slice = useSyncExternalStore(ui.subscribe, () => runtime.pageSlice(page.id));
  const { preview } = slice;
  const draft = slice.draft;
  if (!layers.marks.length && !layers.objects.length && !draft && !preview && !slice.hover) return null;

  const shown = (object) => preview?.patched.get(object.id) || object;
  const hidden = (object) => Boolean(preview?.hidden.has(object.id));
  const extras = preview?.extras.get(page.id) || [];
  const isSelected = (object) => slice.selection.includes(object.id);
  const replaced = layers.objects.filter((object) => object.type === "text" && object.replaces);
  const selected = [...layers.marks, ...layers.objects].filter(isSelected).filter((object) => !hidden(object)).map(shown);
  const common = { page, view, runtime };

  return (
    <div className="pdfx-ov" data-overlay-of={page.id} data-mode={slice.mode}>
      {layers.marks.map((mark) => (hidden(mark) ? null : <MarkView key={mark.id} mark={shown(mark)} selected={isSelected(mark)} {...common} />))}
      {extras.filter(isMark).map((mark) => (
        <MarkView key={mark.id} mark={mark} flag="preview" {...common} />
      ))}
      {/* what a mark at rest takes beyond its own rectangle (not while it is being dragged: the preview moves) */}
      {layers.marks.map((mark) => (hidden(mark) || preview?.patched.has(mark.id) ? null : <MarkReach key={`reach${mark.id}`} mark={mark} {...common} />))}
      {replaced.map((object) => (
        <Cover key={object.id} object={object} page={page} view={view} />
      ))}
      {draft?.replaces ? <Cover object={draft} page={page} view={view} /> : null}
      {layers.objects.map((object) => {
        if (hidden(object)) return null;
        if (object.id === slice.editingId) return <EditorHost key={object.id} object={object} view={view} editor={editor} />;
        return <ObjectView key={object.id} object={shown(object)} {...common} />;
      })}
      {draft ? <EditorHost key={NEW_ID} object={draft} view={view} editor={editor} /> : null}
      {extras
        .filter((object) => !isMark(object))
        .map((object) =>
          object.id === GHOST_ID ? (
            <div key={object.id} className="pdfx-ov-ghost">
              <ObjectView object={object} flag="ghost" {...common} />
            </div>
          ) : (
            <ObjectView key={object.id} object={object} flag="preview" {...common} />
          )
        )}
      <Chrome page={page} view={view} selected={selected} slice={slice} runtime={runtime} />
    </div>
  );
}
