// The colours and the preset values the properties panel offers (UX specification 6). Names are tk() texts:
// render them with t(entry.label).
import { tk } from "../../../i18n/index.js";

const swatch = (value, label) => Object.freeze({ value, label });

/** The eight colours of every colour control. */
export const SWATCHES = Object.freeze([
  swatch("#000000", tk("Black")),
  swatch("#475569", tk("Slate")),
  swatch("#dc2626", tk("Red")),
  swatch("#ea580c", tk("Orange")),
  swatch("#facc15", tk("Yellow")),
  swatch("#16a34a", tk("Green")),
  swatch("#2563eb", tk("Blue")),
  swatch("#ffffff", tk("White"))
]);

/** The five colours of a highlight (the presets of pdf.js). */
export const HIGHLIGHT_SWATCHES = Object.freeze([swatch("#facc15", tk("Yellow")), swatch("#4ade80", tk("Green")), swatch("#60a5fa", tk("Blue")), swatch("#f472b6", tk("Pink")), swatch("#f87171", tk("Red"))]);

/** What a redaction is usually painted with. */
export const REDACTION_SWATCHES = Object.freeze([swatch("#000000", tk("Black")), swatch("#ffffff", tk("White")), swatch("#9ca3af", tk("Grey"))]);

export const FONT_SIZE_PRESETS = Object.freeze([8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]);
/** The range of font sizes the panel offers (the model allows 4 to 400 pt). */
export const FONT_SIZE_RANGE = Object.freeze({ min: 6, max: 144 });
export const LINE_HEIGHT_PRESETS = Object.freeze([1, 1.15, 1.2, 1.5, 2]);
export const STROKE_WIDTH_PRESETS = Object.freeze([0.5, 1, 2, 3, 4, 6, 8]);
export const PEN_WIDTH_PRESETS = Object.freeze([1, 2, 3, 5, 8]);
export const HIGHLIGHT_THICKNESS_PRESETS = Object.freeze([8, 12, 16, 24]);
