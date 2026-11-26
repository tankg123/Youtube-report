// The text module, for plain modules: everything that makes text added by the user look the same on screen and
// in the PDF. No JSX is exported from here (this file can be imported under `node --test`, and nothing in it
// touches the DOM at import time): the two components are imported directly,
//   import TextBox from ".../text/TextBox.jsx";  import TextEditor from ".../text/TextEditor.jsx";
//
//   codes.js        CODES of the module (TEXT_ prefix) with their parameters
//   fontSupport.js  pure: normalizeText, glyph coverage from the manifest, real text / fallback run / picture
//   textStyle.js    pure: the one inline style of a text box (layout scale 8, pinned language, feature switches)
//   layoutCore.js   pure: a measurement -> the TextLayout of model/schema.js; the frame of a box for a layout
//   fonts.js        browser: the font registry (one fetch per face, the same bytes for FontFace and for the PDF)
//   layout.js       browser: the layout service (hidden DOM host; the single truth for size, screen and PDF)
//   raster.js       browser: the picture of a box no bundled font can write, typed signatures
//   caret.js        browser: helpers of the editor (reading the editable element, the caret)
export { CODES, TEXT_BASELINE_UNCERTAIN, TEXT_RASTERIZED } from "./codes.js";
export {
  TAB_SPACES,
  checkText,
  exportProblem,
  facesNeeded,
  fallbackKeyFor,
  findFont,
  fontPlan,
  fontsThatCover,
  graphemes,
  hasGlyph,
  isBlankText,
  normalizeText,
  splitRuns
} from "./fontSupport.js";
export { createFontRegistry, sharedFontRegistry } from "./fonts.js";
export { createTextLayoutService } from "./layout.js";
export { buildTextLayout, frameForLayout, hardLines, textAnchor, withRaster } from "./layoutCore.js";
export { rasterizeTextBox, renderTypedSignature } from "./raster.js";
export { CSS_FAMILY_PREFIX, LAYOUT_SCALE, TEXT_BOX_ATTRIBUTES, TEXT_BOX_STYLE, TEXT_LANG, boxDomText, cssFaceOf, fontStack, layoutKey, layoutScaleTransform, textBoxStyle } from "./textStyle.js";
