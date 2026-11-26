// The signing feature of the PDF editor: how it plugs into the kernel (the manual is the header of
// ui/EditorContext.jsx). Two separate things that the interface never mixes up:
//
//   "Signature" (Chữ ký)               a PICTURE of a handwritten signature placed on a page. It proves nothing.
//                                      SignatureDialog.jsx (Draw / Type it / Upload, saved signatures),
//                                      signaturePlacement.js (the picture goes to the overlay's placing flow
//                                      through the reducer's "placeReady"; "Add date").
//   "Sign with certificate" (Ký số)    a cryptographic digital signature. CertificateDrawer.jsx with its four
//                                      steps, certSignFlow.js (checks before the drawer, the signing job),
//                                      SignFieldLayer.jsx (the rectangle of a visible signature on a page).
// and what a signed document shows: SignaturesPanel.jsx (every signature with its honest level, the trusted
// certificates of this device) and SignatureBanner.jsx (the overall result under the tool bar).
//
// Where things live:
//   identity.js            the signing identity of the tab: module variables only, never a store
//   state.js               the feature bag (reports, flow, flash), inspection of signed sources in idle time,
//                          the two lists of this device (saved signatures, trusted certificates: storage.js)
//   verdict.js             level, integrity and banner text from an inspectSignatures() report (pure)
//   appearanceLayout.js    the lines and the layout of the stamp (pure); appearanceRender.js paints ONE PNG
//   fieldGeometry.js       the signature rectangle from the reducer's effects and gestures (pure)
//   imageOps.js            white-background removal, trimming, stroke paths on pixel arrays (pure)
// The engines (engine/sign, engine/pipeline) are never imported statically: editor.loadSigning() and
// editor.loadPipeline() load them on first use.
import { tk } from "../../../i18n/index.js";
import { SIGNATURE_FIELD_ID } from "../tools/interaction.js";
import CertificateDrawer from "./CertificateDrawer.jsx";
import { closeFlow, nudgeField, runSigningEffects, startCertSign } from "./certSignFlow.js";
import SignatureBanner from "./SignatureBanner.jsx";
import SignatureDateBar from "./SignatureDateBar.jsx";
import SignatureDialog from "./SignatureDialog.jsx";
import { addDateStamp, startSignature } from "./signaturePlacement.js";
import SignaturesPanel from "./SignaturesPanel.jsx";
import SignChoiceDialog from "./SignChoiceDialog.jsx";
import SignFieldLayer from "./SignFieldLayer.jsx";
import { DRAWER_ID, PANEL_ID, SIGNATURE_DIALOG, SIGN_CHOICE_DIALOG, dropReports, readBag, scheduleInspection } from "./state.js";

/** Arrow keys while the signature rectangle is selected in the position step. */
const nudge = (distance) => (editor, event) => {
  if (!readBag(editor.ui).flow?.positioning || !editor.ui.getState().interaction.selection.includes(SIGNATURE_FIELD_ID)) return false;
  return nudgeField(editor, event.keyEvent?.key, distance);
};

export default {
  id: "signing",
  pageOverlay: SignFieldLayer,
  selectionBar: SignatureDateBar,
  panels: {
    [PANEL_ID]: { labelKey: tk("Signatures"), icon: "ShieldCheck", component: SignaturesPanel, order: 30 }
  },
  dialogs: {
    [SIGNATURE_DIALOG]: SignatureDialog,
    [SIGN_CHOICE_DIALOG]: SignChoiceDialog
  },
  drawers: {
    [DRAWER_ID]: CertificateDrawer
  },
  banners: [SignatureBanner],
  toolActivators: {
    signature: startSignature,
    certSign: startCertSign
  },
  commands: {
    dateStamp: (editor) => {
      addDateStamp(editor);
      return true;
    },
    nudge: nudge(1),
    nudgeBig: nudge(10)
  },
  effectExecutor: runSigningEffects,
  onDocumentOpened(editor, { sourceId, facts }) {
    const signatures = facts?.signatureCount || 0;
    if (!signatures && !(facts?.signatureFieldCount > 0)) return;
    scheduleInspection(editor, sourceId);
    // a signed document shows its signatures once, where there is room for the panel next to the pages
    if (signatures > 0 && editor.ui.getState().layout === "wide") editor.actions.openLeftPanel(PANEL_ID);
  },
  onDocumentClosed(editor) {
    closeFlow(editor);
    dropReports(editor);
  }
};
