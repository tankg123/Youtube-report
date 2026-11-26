// Codes of the text module (fonts, glyph coverage, layout, rasterisers): every code the module throws as a
// PdfEditorError or attaches to a result, with the names of its parameters. messages.js turns them into
// sentences; the module itself holds no text for the user.

export const CODES = Object.freeze({
  // fonts.js: manifest.json could not be fetched or is not the manifest (status = HTTP status, 0 = no answer)
  TEXT_FONT_MANIFEST_FAILED: Object.freeze(["status"]),
  // a font key that the manifest does not list
  TEXT_FONT_UNKNOWN: Object.freeze(["font"]),
  // the font file could not be fetched (status = HTTP status, 0 = no answer); the next call tries again
  TEXT_FONT_FETCH_FAILED: Object.freeze(["font", "status"]),
  // the bytes do not match the manifest (size or SHA-256) or the browser refused them as a font
  TEXT_FONT_CORRUPT: Object.freeze(["font"]),
  // layout.js / raster.js: a face the text needs (or the manifest) is not loaded yet: measuring now would
  // measure a fallback font. Await service.ensureFonts(object) and try again.
  TEXT_FONT_NOT_LOADED: Object.freeze(["font"]),
  // not a text object the layout can work with (problem = the field)
  TEXT_OBJECT_INVALID: Object.freeze(["problem"]),
  // problem code of a TextLayout: the box holds characters no bundled font can write as real text, so the
  // whole box is exported as a picture (layout.raster)
  TEXT_RASTERIZED: Object.freeze([]),
  // problem code of a TextLayout: the glyph boxes of one line do not share a top edge, so this browser does
  // not report text boxes the way the baseline rule expects (never seen in Chromium)
  TEXT_BASELINE_UNCERTAIN: Object.freeze([]),
  // raster.js: the picture could not be made (reason: "canvas" = no 2D canvas or painting failed, "encode" = no
  // PNG came back, "svg" = the SVG route was demanded and this browser cannot do it)
  TEXT_RASTER_FAILED: Object.freeze(["reason"])
});

export const TEXT_RASTERIZED = "TEXT_RASTERIZED";
export const TEXT_BASELINE_UNCERTAIN = "TEXT_BASELINE_UNCERTAIN";
