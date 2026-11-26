import { useMemo } from "react";
import { useI18n } from "../../../context/I18nContext";
import { countPendingMarks, sourcesInUse } from "../model/selectors.js";
import { byteSize } from "./documentFacts.js";
import { useDocument, useEditor, useViewer } from "./editorHooks.js";
import { describePageSize } from "./pageSize.js";

// What the properties panel shows while nothing is selected and no tool has settings (UX specification 3.1 F):
// a short summary of the document. The kernel renders it when no feature brings a properties panel; the
// real panel can render it for its own "nothing selected" state:  import DocumentSummary from "../ui/DocumentSummary.jsx";
//
// Test hooks: pdfx-summary with data-pages, data-objects, data-marks, data-signatures, data-sources.
export default function DocumentSummary() {
  const { t, formatNumber } = useI18n();
  const { store } = useEditor();
  const pages = useDocument((state) => state.pages);
  const objects = useDocument((state) => state.objects);
  const sources = useDocument((state) => state.sources);
  const currentPageId = useViewer((state) => state.currentPageId);
  const facts = useMemo(() => {
    const used = sourcesInUse({ pages, sources });
    const marks = countPendingMarks({ pages, objects });
    return {
      used,
      marks: marks.total,
      added: Object.keys(objects).length - marks.total,
      signatures: used.reduce((sum, source) => sum + (source.signatureCount || 0), 0),
      bytes: used.reduce((sum, source) => sum + (source.byteLength || 0), 0)
    };
  }, [pages, objects, sources]);
  if (!pages.length) return null;
  const page = pages.find((entry) => entry.id === currentPageId) || pages[0];
  const size = describePageSize(page);
  const millimetres = (value) => formatNumber(value, { maximumFractionDigits: value % 1 ? 1 : 0 });

  const rows = [
    [t("Pages"), formatNumber(pages.length)],
    [t("Size of this page"), `${size.format ? `${size.format}, ` : ""}${t("{width} × {height} mm", { width: millimetres(size.width), height: millimetres(size.height) })}`],
    [t("Objects you added"), formatNumber(facts.added)],
    [t("Pending redaction and blur marks"), formatNumber(facts.marks)],
    [t("Digital signatures"), formatNumber(facts.signatures)]
  ];
  // (bytes, kilobytes or megabytes as the size asks: a small file is not "0 MB")
  if (facts.used.length) rows.push([t("Size of the source files"), byteSize(facts.bytes, formatNumber)]);

  return (
    <section className="pdfx-summary" data-testid="pdfx-summary" data-pages={pages.length} data-objects={facts.added} data-marks={facts.marks} data-signatures={facts.signatures} data-sources={facts.used.length} data-pristine={store.isPristine() ? "true" : "false"}>
      <h3>{t("Document")}</h3>
      <dl className="pdfx-summary-list">
        {rows.map(([term, value]) => (
          <div key={term} className="pdfx-summary-row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {facts.used.length > 1 ? (
        <>
          <h3>{t("Source files")}</h3>
          <ul className="pdfx-summary-files">
            {facts.used.map((source) => (
              <li key={source.id}>
                <span className="pdfx-summary-file">{source.name || t("Untitled")}</span>
                <span>{source.pageCount === 1 ? t("1 page") : t("{count} pages", { count: source.pageCount })}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="pdfx-summary-note">{t("Choose a tool to add something to a page, or select an object to change it.")}</p>
    </section>
  );
}
