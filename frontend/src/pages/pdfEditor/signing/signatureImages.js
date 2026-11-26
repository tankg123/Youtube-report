// Signature pictures in the browser: from a canvas, a drawn set of strokes or an uploaded file to ONE small
// transparent PNG. The pixel work itself is in imageOps.js (pure); this module is the canvas around it.
//
// A "picture" is { png: Uint8Array, width, height, dataUrl }: pixels, PNG bytes and the same PNG as a data
// URL (for <img> and for the saved signatures of this device).
import { fitWithin, removeWhiteBackground, strokePath, strokesBounds, trimToInk } from "./imageOps.js";
import { MAX_SIGNATURE_CHARS, pngBytesOfDataUrl, pngDataUrl } from "./storage.js";

/** A picture is never kept larger than this (pixels): enough for a stamp at 4 pixels per point. */
export const PICTURE_MAX = Object.freeze({ width: 1200, height: 600 });
/** An upload is scaled down to this before any pixel work. */
export const UPLOAD_MAX_SIDE = 2000;
/** Strokes are painted at this many canvas pixels per CSS pixel of the pad. */
export const STROKE_PIXEL_RATIO = 3;
export const INK_COLORS = Object.freeze({ black: "#111827", blue: "#1d4ed8" });

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) reject(new Error("the canvas could not be encoded"));
      else resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

/** A canvas as a picture, scaled down to PICTURE_MAX when it is larger. */
export async function pictureFromCanvas(source, limits = PICTURE_MAX) {
  const size = fitWithin(source.width, source.height, limits.width, limits.height);
  let canvas = source;
  if (size.scale < 1) {
    canvas = makeCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, size.width, size.height);
  }
  const png = await canvasToPng(canvas);
  return { png, width: canvas.width, height: canvas.height, dataUrl: pngDataUrl(png) };
}

/** RGBA pixels as a picture trimmed to their ink; null when there is no ink at all. */
export async function pictureFromPixels(data, width, height, { padding = 2 } = {}) {
  const trimmed = trimToInk(data, width, height, { padding });
  if (!trimmed) return null;
  const canvas = makeCanvas(trimmed.width, trimmed.height);
  canvas.getContext("2d").putImageData(new ImageData(trimmed.data, trimmed.width, trimmed.height), 0, 0);
  return pictureFromCanvas(canvas);
}

/** Paints strokes ({ points: [{ x, y }] } in CSS pixels of the pad) with round caps and joins. */
export function paintStrokes(context, strokes, { color, width, scale = 1, offsetX = 0, offsetY = 0 }) {
  context.save();
  context.setTransform(scale, 0, 0, scale, -offsetX * scale, -offsetY * scale);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = width;
  for (const stroke of strokes) {
    const path = strokePath(stroke.points);
    if (!path.length) continue;
    context.beginPath();
    for (const [command, ...numbers] of path) {
      if (command === "M") context.moveTo(numbers[0], numbers[1]);
      else if (command === "L") context.lineTo(numbers[0], numbers[1]);
      else context.quadraticCurveTo(numbers[0], numbers[1], numbers[2], numbers[3]);
    }
    context.stroke();
  }
  context.restore();
}

/** A drawn signature as a transparent picture trimmed to its ink; null without strokes. */
export async function pictureFromStrokes(strokes, { color = INK_COLORS.black, width = 2.5 } = {}) {
  const bounds = strokesBounds(strokes, width);
  if (!bounds) return null;
  const margin = 2;
  const canvas = makeCanvas((bounds.width + 2 * margin) * STROKE_PIXEL_RATIO, (bounds.height + 2 * margin) * STROKE_PIXEL_RATIO);
  const context = canvas.getContext("2d");
  paintStrokes(context, strokes, { color, width, scale: STROKE_PIXEL_RATIO, offsetX: bounds.x - margin, offsetY: bounds.y - margin });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return pictureFromPixels(pixels.data, canvas.width, canvas.height);
}

/**
 * Decodes an uploaded picture into a canvas (scaled down to UPLOAD_MAX_SIDE). Rejects when the browser cannot
 * read the file as a picture.
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function canvasFromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("not a picture the browser can read"));
      image.src = url;
    });
    const naturalWidth = image.naturalWidth || 600;
    const naturalHeight = image.naturalHeight || 300;
    const size = fitWithin(naturalWidth, naturalHeight, UPLOAD_MAX_SIDE, UPLOAD_MAX_SIDE);
    const canvas = makeCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * An uploaded picture as a signature picture: optionally without its white background, trimmed to what is left.
 * @param {HTMLCanvasElement} canvas     canvasFromFile(file)
 * @param {{ removeBackground: boolean, threshold: number }} options
 * @returns {Promise<object | null>} a picture, or null when nothing is left (everything was background)
 */
export async function pictureFromUpload(canvas, { removeBackground, threshold }) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = removeBackground ? removeWhiteBackground(pixels.data, canvas.width, canvas.height, { threshold }) : pixels.data;
  return pictureFromPixels(data, canvas.width, canvas.height, { padding: removeBackground ? 2 : 0 });
}

/** PNG bytes (a typed signature of text/raster.js) as a picture. */
export const pictureFromPng = ({ png, width, height }) => ({ png, width, height, dataUrl: pngDataUrl(png) });

/** A saved signature ({ dataUrl, width, height }) as a picture; null when its data is not a PNG. */
export function pictureFromSaved(entry) {
  const png = pngBytesOfDataUrl(entry?.dataUrl);
  return png ? { png, width: entry.width, height: entry.height, dataUrl: entry.dataUrl } : null;
}

/** Loads a data URL (or object URL) into an image element. */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("the picture could not be loaded"));
    image.src = url;
  });
}

/**
 * The same picture small enough for the saved signatures of this device (storage.js MAX_SIGNATURE_CHARS):
 * scaled down step by step. null when even a small version is too large (a photograph with its background).
 */
export async function pictureForStorage(picture) {
  if (picture.dataUrl.length <= MAX_SIGNATURE_CHARS) return picture;
  const image = await loadImage(picture.dataUrl);
  let scale = Math.sqrt(MAX_SIGNATURE_CHARS / picture.dataUrl.length) * 0.95;
  for (let attempt = 0; attempt < 5 && scale > 0.08; attempt += 1, scale *= 0.75) {
    const canvas = makeCanvas(picture.width * scale, picture.height * scale);
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const smaller = await pictureFromCanvas(canvas);
    if (smaller.dataUrl.length <= MAX_SIGNATURE_CHARS) return smaller;
  }
  return null;
}
