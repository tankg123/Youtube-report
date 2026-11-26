import { missingBrowserFeatures } from "./ui/browserSupport.js";
import { EditorProvider } from "./ui/EditorContext.jsx";
import Shell from "./ui/Shell.jsx";
import ShellBoundary from "./ui/ShellBoundary.jsx";
import UnsupportedBrowser from "./ui/UnsupportedBrowser.jsx";

// /pdf: the PDF editor, a stand-alone full-screen route outside the application shell (App.jsx loads it
// lazily and keeps it mounted when the session ends: the work it holds lives only in memory).
//
//   EditorProvider   creates and owns the editor for the life of the page: document store, viewer, text
//                    service, UI store, actions, the feature manifests (ui/EditorContext.jsx: its header is
//                    the manual of the editor)
//   Shell            the frame: bars, panels, page area, dialogs, keyboard, guards (ui/Shell.jsx)
//
// Two error boundaries: the inner one sits BELOW the provider, so a failure of the frame leaves the document
// in memory and "Try again" draws the frame again around the same document; the outer one catches a failure
// of the provider itself. A browser that lacks something the editor needs gets a page that says what
// (ui/browserSupport.js) instead of an editor that fails half way.
const MISSING = missingBrowserFeatures();

export default function PdfEditorPage() {
  if (MISSING.length) return <UnsupportedBrowser missing={MISSING} />;
  return (
    <ShellBoundary>
      <EditorProvider>
        <ShellBoundary withDocument>
          <Shell />
        </ShellBoundary>
      </EditorProvider>
    </ShellBoundary>
  );
}
