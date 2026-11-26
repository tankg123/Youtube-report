import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { sourcesInUse } from "../../model/selectors.js";
import { byteSize, parsePdfDate, restrictedChanges } from "../documentFacts.js";
import { useDocument, useEditor, useViewer } from "../editorHooks.js";
import { FILE_EXTENSION } from "../fileNames.js";
import { describePageSize } from "../pageSize.js";
import DialogFrame, { DialogButton } from "./DialogFrame.jsx";

// Document properties (UX specification 7.2): the working document (name of the download, pages, size of the
// current page, signatures) and, for every file its pages come from, what that file says about itself: size,
// title, author, subject, keywords, the program that made it, dates, PDF version, protection.
// Read-only: the properties of the download are those of the first file (or none, when the user leaves them
// out in the download options).
// The dates and the PDF version are read from the open pdf.js document of the viewer (never changed).
// Test hooks: pdfx-dialog-properties; pdfx-properties-document, pdfx-properties-source (data-source-id) with
// rows [data-property="title" | "pages" | ...]; pdfx-action-properties-close.

/** The part of the metadata of a source that the viewer facts do not hold. */
function useSourceMetadata(viewer, sourceIds) {
  const [metadata, setMetadata] = useState({});
  const key = sourceIds.join("|");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split("|") : []) {
      const doc = viewer.getPdfDocument?.(id);
      if (!doc || typeof doc.getMetadata !== "function") continue;
      doc
        .getMetadata()
        .then((result) => {
          if (!live) return;
          const info = result?.info || {};
          setMetadata((known) => ({ ...known, [id]: { version: info.PDFFormatVersion || "", created: parsePdfDate(info.CreationDate), modified: parsePdfDate(info.ModDate) } }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [viewer, key]);
  return metadata;
}

function Rows({ rows }) {
  return (
    <dl className="pdfx-properties-list">
      {rows
        .filter(([, , value]) => value !== null && value !== undefined && value !== "")
        .map(([id, term, value]) => (
          <div key={id} className="pdfx-properties-row" data-property={id}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export default function PropertiesDialog({ onClose }) {
  const { t, formatNumber, formatDateTime } = useI18n();
  const { viewer } = useEditor();
  const fileName = useDocument((state) => state.fileName);
  const pages = useDocument((state) => state.pages);
  const sources = useDocument((state) => state.sources);
  const currentPageId = useViewer((state) => state.currentPageId);
  const closeRef = useRef(null);
  const used = sourcesInUse({ pages, sources });
  const metadata = useSourceMetadata(viewer, used.map((source) => source.id));
  const page = pages.find((entry) => entry.id === currentPageId) || pages[0] || null;
  const size = page ? describePageSize(page) : null;
  const millimetres = (value) => formatNumber(value, { maximumFractionDigits: value % 1 ? 1 : 0 });
  const signatures = used.reduce((sum, source) => sum + (source.signatureCount || 0), 0);
  const blank = pages.filter((entry) => entry.kind !== "pdf").length;
  const none = <span className="pdfx-properties-none">{t("Not set")}</span>;

  const documentRows = [
    ["name", t("Name of the download"), `${fileName || t("Untitled")}${FILE_EXTENSION}`],
    ["pages", t("Pages"), formatNumber(pages.length)],
    ["page-size", t("Size of this page"), size ? `${size.format ? `${size.format}, ` : ""}${t("{width} × {height} mm", { width: millimetres(size.width), height: millimetres(size.height) })}` : ""],
    ["signatures", t("Digital signatures"), formatNumber(signatures)],
    ["sources", t("Source files"), formatNumber(used.length)],
    ["blank", t("Pages that come from no file"), blank ? formatNumber(blank) : ""]
  ];

  const protection = (source, facts) => {
    if (!source.encrypted) return t("No");
    const limits = restrictedChanges(facts?.permissions);
    if (limits.length) return t("Yes: the author restricted changes");
    return viewer.getSourcePassword?.(source.id) ? t("Yes: a password is needed to open it") : t("Yes");
  };

  return (
    <DialogFrame
      size="md"
      scrollBody
      icon={Info}
      title={t("Document properties")}
      initialFocusRef={closeRef}
      onClose={() => onClose()}
      footer={
        <DialogButton ref={closeRef} variant="primary" data-testid="pdfx-action-properties-close" onClick={() => onClose()}>
          {t("Close")}
        </DialogButton>
      }
    >
      <section className="pdfx-properties-section" data-testid="pdfx-properties-document">
        <h3>{t("This document")}</h3>
        <Rows rows={documentRows} />
      </section>
      {used.map((source) => {
        const facts = viewer.getSourceFacts?.(source.id) || null;
        const info = facts?.info || source.info || {};
        const extra = metadata[source.id] || {};
        const rows = [
          ["file-size", t("File size"), byteSize(source.byteLength, formatNumber)],
          ["file-pages", t("Pages"), formatNumber(source.pageCount)],
          ["title", t("Title"), info.title || none],
          ["author", t("Author"), info.author || none],
          ["subject", t("Subject"), info.subject || none],
          ["keywords", t("Keywords"), info.keywords || none],
          ["creator", t("Created with"), info.creator || ""],
          ["producer", t("PDF producer"), info.producer || ""],
          ["created", t("Created"), extra.created ? formatDateTime(extra.created) : ""],
          ["modified", t("Modified"), extra.modified ? formatDateTime(extra.modified) : ""],
          ["version", t("PDF version"), extra.version || ""],
          ["protected", t("Protected"), protection(source, facts)],
          ["file-signatures", t("Digital signatures"), formatNumber(source.signatureCount || 0)]
        ];
        return (
          <section key={source.id} className="pdfx-properties-section" data-testid="pdfx-properties-source" data-source-id={source.id}>
            <h3 className="pdfx-dialog-file">{source.name || t("Untitled")}</h3>
            <Rows rows={rows} />
          </section>
        );
      })}
      <p className="pdfx-dialog-note">{t("The file you download carries the title, author, subject and keywords of the first file, unless you leave them out in the download options.")}</p>
    </DialogFrame>
  );
}
