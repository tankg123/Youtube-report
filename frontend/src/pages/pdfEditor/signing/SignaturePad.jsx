import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Eraser, Undo2 } from "lucide-react";
import { useI18n } from "../../../context/I18nContext";
import { addStrokePoint } from "./imageOps.js";
import { INK_COLORS, paintStrokes, pictureFromStrokes } from "./signatureImages.js";

// The "Draw" tab of the signature dialog (UX specification 7.10): a pad with a baseline. The pointer draws
// smooth strokes (a curve through the samples: imageOps.js strokePath), in black or blue, with a thickness
// slider; "Clear" empties the pad and "Undo stroke" (Ctrl+Z while the pad has the keyboard) takes back the
// last stroke. The result is a transparent PNG trimmed to its ink.
// The strokes are kept as points in CSS pixels of the pad, so the picture is painted again at a higher
// resolution than the screen when it is taken.
//
// ref -> { getPicture(): Promise<picture | null>, isEmpty(): boolean }
// Test hooks: pdfx-sig-pad (data-strokes), pdfx-sig-ink-black / -blue, pdfx-sig-thickness,
// pdfx-action-sig-undo, pdfx-action-sig-clear.

const THICKNESS = Object.freeze({ min: 1, max: 6, step: 0.5, default: 2.5 });

export default function SignaturePad({ ref, onChange }) {
  const { t } = useI18n();
  const [ink, setInk] = useState("black");
  const [thickness, setThickness] = useState(THICKNESS.default);
  const [count, setCount] = useState(0);
  const strokes = useRef([]); // [{ points: [{ x, y }] }]
  const drawing = useRef(null); // { pointerId, stroke }
  const canvasRef = useRef(null);
  const padRef = useRef(null);
  const inkGroup = useId();

  const repaint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    const context = canvas.getContext("2d");
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    paintStrokes(context, strokes.current, { color: INK_COLORS[ink], width: thickness, scale: ratio });
  };

  // the canvas has the pixels of the screen; it is painted again whenever something changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const fit = () => {
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      repaint();
    };
    fit();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(canvas);
    return () => observer?.disconnect();
  });

  const changed = () => {
    setCount(strokes.current.length);
    onChange?.(strokes.current.length);
  };
  const undo = () => {
    if (!strokes.current.length) return;
    strokes.current = strokes.current.slice(0, -1);
    changed();
  };
  const clear = () => {
    strokes.current = [];
    changed();
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => strokes.current.length === 0,
    getPicture: () => pictureFromStrokes(strokes.current, { color: INK_COLORS[ink], width: thickness })
  }));

  const pointOf = (event) => {
    const box = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const finish = (event) => {
    const current = drawing.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drawing.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    changed();
  };

  return (
    <>
      <div
        ref={padRef}
        className="pdfx-sig-pad"
        role="img"
        aria-label={count ? t("Signature pad with your drawing") : t("Signature pad: draw your signature here with the mouse, a pen or a finger")}
        tabIndex={0}
        data-strokes={count}
        data-ink={ink}
        data-testid="pdfx-sig-pad"
        onPointerDown={(event) => {
          if (event.button !== 0 || drawing.current) return;
          event.preventDefault();
          padRef.current?.focus({ preventScroll: true });
          const stroke = { points: [pointOf(event)] };
          strokes.current = [...strokes.current, stroke];
          drawing.current = { pointerId: event.pointerId, stroke };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          repaint();
        }}
        onPointerMove={(event) => {
          const current = drawing.current;
          if (!current || current.pointerId !== event.pointerId) return;
          // a fast stroke delivers several samples per frame: all of them make the line smooth
          const samples = typeof event.nativeEvent.getCoalescedEvents === "function" ? event.nativeEvent.getCoalescedEvents() : [];
          for (const sample of samples.length ? samples : [event]) addStrokePoint(current.stroke.points, pointOf(sample));
          repaint();
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
            event.preventDefault();
            event.stopPropagation();
            undo();
          }
        }}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        <span className="pdfx-sig-pad-line" aria-hidden="true" />
        {count ? null : <span className="pdfx-sig-pad-hint">{t("Draw your signature here")}</span>}
      </div>
      <div className="pdfx-sig-controls">
        <span>{t("Ink")}</span>
        <label>
          <input type="radio" name={inkGroup} checked={ink === "black"} data-testid="pdfx-sig-ink-black" onChange={() => setInk("black")} />
          <span className="pdfx-sig-swatch" style={{ background: INK_COLORS.black }} aria-hidden="true" />
          <span>{t("Black")}</span>
        </label>
        <label>
          <input type="radio" name={inkGroup} checked={ink === "blue"} data-testid="pdfx-sig-ink-blue" onChange={() => setInk("blue")} />
          <span className="pdfx-sig-swatch" style={{ background: INK_COLORS.blue }} aria-hidden="true" />
          <span>{t("Blue")}</span>
        </label>
        <label>
          <span>{t("Thickness")}</span>
          <input type="range" min={THICKNESS.min} max={THICKNESS.max} step={THICKNESS.step} value={thickness} data-testid="pdfx-sig-thickness" onChange={(event) => setThickness(Number(event.target.value))} />
        </label>
        <span className="pdfx-sig-buttons">
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={!count} data-testid="pdfx-action-sig-undo" onClick={undo}>
            <Undo2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Undo stroke")}</span>
          </button>
          <button type="button" className="pdfx-btn pdfx-btn-text pdfx-btn-outline" disabled={!count} data-testid="pdfx-action-sig-clear" onClick={clear}>
            <Eraser size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="pdfx-btn-label">{t("Clear")}</span>
          </button>
        </span>
      </div>
    </>
  );
}
