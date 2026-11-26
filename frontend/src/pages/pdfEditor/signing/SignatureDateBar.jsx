import { useLayoutEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { objectScreenBox } from "../model/shapes.js";
import { useDocument, useEditor, useInteraction, useViewer } from "../ui/editorHooks.js";
import { addDateStamp } from "./signaturePlacement.js";
import "../styles/signing.css";

// "Add date" (UX specification 7.10): while exactly one signature picture is selected, a small button under
// it adds an ordinary text box with today's date (20/11/2026 in Vietnamese, the short date of the locale in
// English). It is the signing feature's own piece of the selection bar: rendered in the layer that scrolls
// with the pages, positioned in the coordinates of the scrolled content.
// The same action is the command "dateStamp" (actions.runCommand("dateStamp")), for a menu or a bar of the
// overlay feature.
//
// Test hooks: pdfx-sig-datebar, pdfx-action-add-date.
export default function SignatureDateBar() {
  const { t } = useI18n();
  const editor = useEditor();
  const interaction = useInteraction();
  const objects = useDocument((state) => state.objects);
  const pages = useDocument((state) => state.pages);
  const scale = useViewer((state) => state.scale);
  const anchor = useRef(null);
  const [place, setPlace] = useState(null);

  const id = interaction.mode === "idle" && interaction.selection.length === 1 ? interaction.selection[0] : null;
  const candidate = id ? objects[id] : null;
  const signature = candidate && candidate.type === "image" && candidate.role === "signature" ? candidate : null;
  const page = signature ? pages.find((entry) => entry.id === signature.pageId) : null;

  useLayoutEffect(() => {
    const host = anchor.current?.parentElement;
    const view = page ? editor.viewer.getPageView(page.id) : null;
    if (!signature || !page || !host || !view?.element) {
      setPlace(null);
      return;
    }
    const origin = host.getBoundingClientRect();
    const paper = view.element.getBoundingClientRect();
    const [left, , , bottom] = objectScreenBox(signature, page);
    const next = { left: Math.round(paper.left - origin.left + left * view.scale), top: Math.round(paper.top - origin.top + bottom * view.scale + 8) };
    setPlace((current) => (current && current.left === next.left && current.top === next.top ? current : next));
  }, [editor, signature, page, scale]);

  return (
    <>
      <span ref={anchor} hidden />
      {signature && place ? (
        <div className="pdfx-sig-datebar" style={{ left: place.left, top: place.top }} data-testid="pdfx-sig-datebar">
          <button type="button" className="pdfx-btn pdfx-btn-text" data-testid="pdfx-action-add-date" onPointerDown={(event) => event.stopPropagation()} onClick={() => addDateStamp(editor)}>
            <CalendarDays size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Add date")}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
