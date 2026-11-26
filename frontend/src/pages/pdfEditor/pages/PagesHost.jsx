import { useEffect, useRef } from "react";
import { useEditor, useFeatureState } from "../ui/editorHooks.js";
import { continueInsertImages, continueInsertPdf, run } from "./pageFlows.js";
import { pruneSelection } from "./pageOps.js";
import { FEATURE_ID } from "./pagesState.js";
import "../styles/pages.css";

// What the pages feature keeps mounted for the whole life of the editor (it sits in the status bar slot of
// the kernel and shows nothing):
//   * the live region that announces page operations to screen readers ("Page 3 moved to position 5")
//   * the two hidden file inputs behind "Pages from PDF" and "Image as page" (pages/pageFlows.js clicks them)
//   * the selection of pages follows the document: a page that is gone (undo, a new document) is not selected
//
// Test hooks: pdfx-pages-live (the announcement), pdfx-pages-input-pdf, pdfx-pages-input-image.

const PDF_TYPES = "application/pdf,.pdf";
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg";

export default function PagesHost() {
  const editor = useEditor();
  const [bag] = useFeatureState(FEATURE_ID);
  const pdfRef = useRef(null);
  const imageRef = useRef(null);

  useEffect(() => {
    const undo = [editor.registerElement("pagesPdfInput", pdfRef.current), editor.registerElement("pagesImageInput", imageRef.current)];
    return () => undo.forEach((unregister) => unregister());
  }, [editor]);

  useEffect(() => editor.store.subscribe(() => pruneSelection(editor)), [editor]);

  const take = (event) => {
    const files = [...event.target.files];
    event.target.value = ""; // the same file can be chosen again
    return files;
  };

  return (
    <span className="pdfx-pages-host">
      <span className="pdfx-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="pdfx-pages-live" data-token={bag?.announcement?.token || 0}>
        {/* a new node per announcement: the same sentence twice in a row is said twice */}
        <span key={bag?.announcement?.token || 0}>{bag?.announcement?.text || ""}</span>
      </span>
      <input
        ref={pdfRef}
        type="file"
        accept={PDF_TYPES}
        hidden
        tabIndex={-1}
        data-testid="pdfx-pages-input-pdf"
        onChange={(event) => {
          const [file] = take(event);
          if (file) run(editor, continueInsertPdf(editor, file));
        }}
      />
      <input
        ref={imageRef}
        type="file"
        accept={IMAGE_TYPES}
        multiple
        hidden
        tabIndex={-1}
        data-testid="pdfx-pages-input-image"
        onChange={(event) => {
          const files = take(event);
          if (files.length) run(editor, continueInsertImages(editor, files));
        }}
      />
    </span>
  );
}
