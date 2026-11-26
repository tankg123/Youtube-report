// Tool and command registry of the PDF editor: the one list that the tool bar, the menus, the keyboard map
// and the keyboard help are built from. Pure data: no DOM, no React (it runs under `node --test`).
//
// Labels are canonical English texts marked with tk(): render them with t(entry.label). Icons are export
// names of lucide-react (`import * as icons from "lucide-react"; const Icon = icons[entry.icon]`, or a named
// import per icon); tests/pdfToolsRegistry.test.mjs proves that every name exists in the installed version.
//
// A tool:
//   id        also the id of its tool-bar button (data-testid="pdfx-tool-<id>") and of its shortcut "tool:<id>"
//   group     one of TOOL_GROUPS
//   key       its single-key shortcut (Telex-safe: never W, [ or ]); active only in the page area
//   mode      "sticky"   stays active until another tool is chosen or Escape is pressed
//             "one-shot" back to Select after one object (a double-click on the button locks it)
//   cursor    CSS cursor over a page while the tool is active (interaction.js cursorFor() refines it)
//   creates   what it puts on the page: an object type of model/schema.js, "signatureField" (the rectangle of
//             a visible certificate signature, kept by the signing flow, not by the document) or null
//   menu      the menu button it is listed under (TOOL_MENUS)
//   picker    true: choosing the tool first opens a picker (a file, a saved signature); the reducer answers
//             with an "openPicker" effect and waits for a "placeReady" event
//   flow      "signing": the tool-bar button starts the certificate signing drawer; the tool itself is only
//             activated for its position step
//   edits     false for the tools that never change the document (they stay enabled on a read-only document)
import { tk } from "../../../i18n/index.js";

export const TOOL_GROUPS = Object.freeze([
  Object.freeze({ id: "navigate", label: tk("Navigate") }),
  Object.freeze({ id: "insert", label: tk("Insert") }),
  Object.freeze({ id: "draw", label: tk("Draw") }),
  Object.freeze({ id: "protect", label: tk("Protect") }),
  Object.freeze({ id: "sign", label: tk("Sign") })
]);

const tool = (entry) => Object.freeze({ menu: null, picker: false, flow: null, edits: true, ...entry });

export const TOOLS = Object.freeze([
  tool({ id: "select", group: "navigate", label: tk("Select"), icon: "MousePointer2", key: "V", mode: "sticky", cursor: "default", creates: null, edits: false }),
  tool({ id: "hand", group: "navigate", label: tk("Hand"), icon: "Hand", key: "H", mode: "sticky", cursor: "grab", creates: null, edits: false }),

  tool({ id: "text", group: "insert", label: tk("Text"), icon: "Type", key: "T", mode: "one-shot", cursor: "text", creates: "text" }),
  tool({ id: "editText", group: "insert", label: tk("Edit text"), icon: "TextCursorInput", key: "E", mode: "sticky", cursor: "text", creates: "text" }),
  tool({ id: "image", group: "insert", label: tk("Image"), icon: "Image", key: "I", mode: "one-shot", cursor: "copy", creates: "image", picker: true }),
  tool({ id: "rect", group: "insert", label: tk("Rectangle"), icon: "Square", key: "R", mode: "one-shot", cursor: "crosshair", creates: "rect", menu: "shapes" }),
  tool({ id: "ellipse", group: "insert", label: tk("Ellipse"), icon: "Circle", key: "O", mode: "one-shot", cursor: "crosshair", creates: "ellipse", menu: "shapes" }),
  tool({ id: "line", group: "insert", label: tk("Line"), icon: "Minus", key: "L", mode: "one-shot", cursor: "crosshair", creates: "line", menu: "shapes" }),
  tool({ id: "arrow", group: "insert", label: tk("Arrow"), icon: "MoveUpRight", key: "A", mode: "one-shot", cursor: "crosshair", creates: "line", menu: "shapes" }),

  tool({ id: "pen", group: "draw", label: tk("Pen"), icon: "Pencil", key: "P", mode: "sticky", cursor: "crosshair", creates: "pen" }),
  tool({ id: "highlighter", group: "draw", label: tk("Highlighter"), icon: "Highlighter", key: "M", mode: "sticky", cursor: "crosshair", creates: "highlight" }),
  tool({ id: "eraser", group: "draw", label: tk("Eraser"), icon: "Eraser", key: "Shift+E", mode: "sticky", cursor: "cell", creates: null }),

  tool({ id: "redact", group: "protect", label: tk("Redact"), icon: "EyeOff", key: "X", mode: "sticky", cursor: "crosshair", creates: "redact" }),
  tool({ id: "blur", group: "protect", label: tk("Blur"), icon: "Droplets", key: "B", mode: "sticky", cursor: "crosshair", creates: "blur" }),

  tool({ id: "signature", group: "sign", label: tk("Signature"), icon: "Signature", key: "S", mode: "one-shot", cursor: "copy", creates: "image", picker: true }),
  tool({ id: "certSign", group: "sign", label: tk("Sign with certificate"), icon: "FileBadge", key: "C", mode: "one-shot", cursor: "crosshair", creates: "signatureField", flow: "signing" })
]);

/** Menu buttons of the tool bar: "shapes" lists rect / ellipse / line / arrow and shows the one used last. */
export const TOOL_MENUS = Object.freeze([Object.freeze({ id: "shapes", label: tk("Shapes"), icon: "Shapes" })]);

const command = (id, label, icon) => Object.freeze({ id, label, icon });

/** Commands that are not tools (data-testid="pdfx-action-<id>"). */
export const COMMANDS = Object.freeze([
  // file
  command("open", tk("Open"), "FolderOpen"),
  command("addFiles", tk("Add files"), "FilePlus2"),
  command("download", tk("Download"), "Download"),
  command("print", tk("Print"), "Printer"),
  command("properties", tk("Document properties"), "Info"),
  command("closeDocument", tk("Close document"), "X"),
  command("shortcuts", tk("Keyboard shortcuts"), "Keyboard"),
  command("language", tk("Language"), "Languages"),
  // history
  command("undo", tk("Undo"), "Undo2"),
  command("redo", tk("Redo"), "Redo2"),
  // view
  command("search", tk("Search"), "Search"),
  command("zoomIn", tk("Zoom in"), "ZoomIn"),
  command("zoomOut", tk("Zoom out"), "ZoomOut"),
  command("rotateView", tk("Rotate view"), "RotateCw"),
  command("fullScreen", tk("Full screen"), "Maximize"),
  command("exitFullScreen", tk("Exit full screen"), "Minimize"),
  command("previousPage", tk("Previous page"), "ChevronUp"),
  command("nextPage", tk("Next page"), "ChevronDown"),
  // panels
  command("panelPages", tk("Pages"), "LayoutGrid"),
  command("panelOutline", tk("Outline"), "ListTree"),
  command("panelSignatures", tk("Signatures"), "ShieldCheck"),
  command("toggleLeftPanel", tk("Toggle side panel"), "PanelLeft"),
  command("toggleInspector", tk("Toggle properties panel"), "PanelRight"),
  // objects
  command("editObject", tk("Edit text"), "TextCursorInput"),
  command("duplicate", tk("Duplicate object"), "Copy"),
  command("delete", tk("Delete"), "Trash2"),
  command("copy", tk("Copy"), "Clipboard"),
  command("cut", tk("Cut"), "Scissors"),
  command("paste", tk("Paste"), "ClipboardPaste"),
  command("selectAll", tk("Select all"), "SquareDashedMousePointer"),
  command("bringToFront", tk("Bring to front"), "BringToFront"),
  command("bringForward", tk("Bring forward"), "ArrowUp"),
  command("sendBackward", tk("Send backward"), "ArrowDown"),
  command("sendToBack", tk("Send to back"), "SendToBack"),
  command("moreActions", tk("More actions"), "EllipsisVertical"),
  // alignment of several objects, as seen on screen (model/selectors.js alignObjects)
  command("alignObjectsLeft", tk("Align left edges"), "AlignStartVertical"),
  command("alignObjectsCenter", tk("Align centres horizontally"), "AlignCenterVertical"),
  command("alignObjectsRight", tk("Align right edges"), "AlignEndVertical"),
  command("alignObjectsTop", tk("Align top edges"), "AlignStartHorizontal"),
  command("alignObjectsMiddle", tk("Align centres vertically"), "AlignCenterHorizontal"),
  command("alignObjectsBottom", tk("Align bottom edges"), "AlignEndHorizontal"),
  // text formatting
  command("bold", tk("Bold"), "Bold"),
  command("italic", tk("Italic"), "Italic"),
  command("underline", tk("Underline"), "Underline"),
  command("alignLeft", tk("Align left"), "AlignLeft"),
  command("alignCenter", tk("Align center"), "AlignCenter"),
  command("alignRight", tk("Align right"), "AlignRight"),
  command("textColor", tk("Text colour"), "Baseline"),
  command("fillColor", tk("Fill colour"), "PaintBucket"),
  command("strokeColor", tk("Stroke colour"), "Palette"),
  // text selection popover
  command("highlightSelection", tk("Highlight"), "Highlighter"),
  command("redactSelection", tk("Redact"), "EyeOff"),
  // page organiser
  command("organise", tk("Organise pages"), "LayoutGrid"),
  command("rotateCw", tk("Rotate clockwise"), "RotateCw"),
  command("rotateCcw", tk("Rotate counterclockwise"), "RotateCcw"),
  command("duplicatePage", tk("Duplicate page"), "Copy"),
  command("deletePage", tk("Delete page"), "Trash2"),
  command("insertBlank", tk("Blank page"), "FilePlus2"),
  command("insertPdf", tk("Pages from PDF"), "FileInput"),
  command("insertImagePage", tk("Image as page"), "ImagePlus"),
  command("extract", tk("Extract"), "FileOutput"),
  command("dragHandle", tk("Drag to reorder"), "GripVertical"),
  // signatures
  command("sigDraw", tk("Draw"), "PenLine"),
  command("sigType", tk("Type it"), "Keyboard"),
  command("sigUpload", tk("Upload"), "Upload"),
  command("dateStamp", tk("Date"), "CalendarDays"),
  command("chooseP12", tk("Certificate file"), "FileKey2"),
  command("certPassword", tk("Password"), "KeyRound"),
  command("createSelfSigned", tk("Create a self-signed certificate"), "IdCard"),
  command("lockDocument", tk("Lock document after signing"), "Lock"),
  // status
  command("statusValid", tk("Valid"), "CircleCheck"),
  command("statusUnverified", tk("Valid, signer not verified"), "TriangleAlert"),
  command("statusInvalid", tk("Invalid"), "CircleX"),
  command("statusUnknown", tk("Cannot be verified"), "CircleHelp"),
  command("statusBusy", tk("Working…"), "LoaderCircle"),
  command("statusEncrypted", tk("Password required"), "FileLock2"),
  command("statusCorrupt", tk("Could not open this file"), "FileWarning")
]);

const TOOLS_BY_ID = new Map(TOOLS.map((entry) => [entry.id, entry]));
const COMMANDS_BY_ID = new Map(COMMANDS.map((entry) => [entry.id, entry]));

export const toolById = (id) => TOOLS_BY_ID.get(id) ?? null;
export const commandById = (id) => COMMANDS_BY_ID.get(id) ?? null;
export const toolsOfGroup = (groupId) => TOOLS.filter((entry) => entry.group === groupId);
export const toolsOfMenu = (menuId) => TOOLS.filter((entry) => entry.menu === menuId);

/** Every icon name the registry uses, sorted. */
export const allIconNames = () => [...new Set([...TOOLS, ...TOOL_MENUS, ...COMMANDS].map((entry) => entry.icon))].sort();
