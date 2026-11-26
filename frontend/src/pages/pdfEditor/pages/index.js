// The pages feature of the PDF editor: what the kernel plugs in (the manual is the header of ui/EditorContext.jsx).
//
//   panels            "pages"    thumbnails with selection, drag reordering and the page menu (PagesPanel.jsx)
//                     "outline"  the bookmarks of the source files as a tree (OutlinePanel.jsx)
//   fullScreenViews   "organiser"  the page organiser (PageOrganizer.jsx); the kernel opens it for the key G and
//                     for actions.toggleView("organiser")
//   dialogs           pagesInsertBlank, pagesInsertPdf, pagesInsertImages, pagesExtract, pagesMoveTo
//                     (opened by pageFlows.js with ui.showDialog; each resolves with the user's choice)
//   contextMenu       the page menu and the Add menu (PageMenus.jsx)
//   statusItems       PagesHost.jsx: nothing to see; the live region for announcements and the hidden file inputs
//   commands          the keys of the organiser scope and "openImages" (pageCommands.js)
//   onDocumentClosed  the selection belongs to a document
//
// Where what lives:
//   pageLogic.js      pure arithmetic: ranges, selection, grid, drop positions, sizes, outline mapping
//   pagesState.js     the feature bag in the UI store: selection, focus, thumbnail size, open menu, announcements
//   pageOps.js        the operations (one undo step each): rotate, duplicate, delete, move, insert, extract
//   pageFlows.js      pickers and dialogs in front of the operations
//   usePageGrid.js    pointer and keys on a grid of tiles (selection, marquee, drag reordering)
//   imageFiles.js     pictures into PNG / JPEG bytes for "Image as page"
// Other features may call the operations directly:  import { rotatePages } from "../pages/pageOps.js".
import { tk } from "../../../i18n/index.js";
import ExtractDialog from "./dialogs/ExtractDialog.jsx";
import InsertBlankDialog from "./dialogs/InsertBlankDialog.jsx";
import InsertImagesDialog from "./dialogs/InsertImagesDialog.jsx";
import InsertPdfDialog from "./dialogs/InsertPdfDialog.jsx";
import MoveToDialog from "./dialogs/MoveToDialog.jsx";
import OutlinePanel from "./OutlinePanel.jsx";
import { pageCommands } from "./pageCommands.js";
import PageMenus from "./PageMenus.jsx";
import PageOrganizer from "./PageOrganizer.jsx";
import PagesHost from "./PagesHost.jsx";
import PagesPanel from "./PagesPanel.jsx";
import { resetPagesState } from "./pagesState.js";

export default {
  id: "pages",
  panels: {
    pages: { labelKey: tk("Pages"), icon: "LayoutGrid", component: PagesPanel, order: 10 },
    outline: { labelKey: tk("Outline"), icon: "ListTree", component: OutlinePanel, order: 20 }
  },
  fullScreenViews: { organiser: PageOrganizer },
  dialogs: {
    pagesInsertBlank: InsertBlankDialog,
    pagesInsertPdf: InsertPdfDialog,
    pagesInsertImages: InsertImagesDialog,
    pagesExtract: ExtractDialog,
    pagesMoveTo: MoveToDialog
  },
  contextMenu: PageMenus,
  statusItems: [PagesHost],
  commands: pageCommands,
  onDocumentClosed: (editor) => {
    resetPagesState(editor.ui);
  }
};
