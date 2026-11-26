import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "../../../../context/I18nContext";
import { cx } from "../classNames.js";
import { focusIsLost, forgetFocus, recallFocus, rememberFocus } from "../focusMemory.js";

// The frame of the editor's own dialogs (UX specification 13), rendered in place inside the editor root:
//   role="dialog" for forms and information, role="alertdialog" for warnings and questions (`alert`),
//   aria-modal, labelled by its title and described by its lead text (`describedBy`: an element id)
//   the keyboard moves in when it opens: to `initialFocusRef`, else to the first control of the body or the
//     footer (never the X), and Tab stays inside
//   Escape and the X call onClose(); `onClose` undefined = the dialog cannot be closed now
//   when it closes the keyboard goes back to the control that opened it (ui/focusMemory.js keeps that control
//     through a chain of dialogs and a running job)
// A press on the backdrop closes a plain dialog; an alert dialog needs an explicit answer.
// The application's shared Modal is not used here: it is always role="dialog" and its colours do not follow
// the tokens of the editor. Dialogs of the features may use either.
//
// Props: title, icon (lucide component), subtitle (the file a question is about), alert, size "sm" | "md" | "lg",
// tone "default" | "warning" | "danger" | "success" (colour of the icon), onClose, initialFocusRef, describedBy,
// scrollBody (a long body without controls of its own: it takes the keyboard so that the arrow keys scroll it),
// footer (the buttons), children. Buttons: <DialogButton variant="outline" | "primary" | "danger">.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const frames = []; // open frames, the newest last

const focusables = (element) => [...element.querySelectorAll(FOCUSABLE)].filter((entry) => entry.getClientRects().length > 0);

/** True when no other dialog of the editor lies over this one (the dialog host renders them in stack order). */
function isOnTop(dialog) {
  if (frames[frames.length - 1] !== dialog) return false;
  const slot = dialog.closest(".pdfx-dialog-slot");
  if (!slot) return true;
  const slots = slot.parentElement ? [...slot.parentElement.children].filter((entry) => entry.classList.contains("pdfx-dialog-slot")) : [slot];
  return slots[slots.length - 1] === slot;
}

/** A button of a dialog footer. variant: "outline" (default) | "primary" | "danger". */
export function DialogButton({ variant = "outline", icon: Icon, className, children, ...rest }) {
  return (
    <button type="button" {...rest} className={cx("pdfx-btn pdfx-btn-text pdfx-dialog-button", variant === "primary" ? "pdfx-btn-primary" : variant === "danger" ? "pdfx-btn-danger" : "pdfx-btn-outline", className)}>
      {Icon ? <Icon size={16} strokeWidth={1.75} aria-hidden="true" /> : null}
      <span className="pdfx-btn-label">{children}</span>
    </button>
  );
}

export default function DialogFrame({ title, icon: Icon, subtitle, alert = false, size = "sm", tone = "default", onClose, initialFocusRef, describedBy, scrollBody = false, footer, children }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  });

  // the keyboard: in when the dialog opens, back to the opener when it closes
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const active = document.activeElement;
    rememberFocus(focusIsLost() ? null : active);
    const opener = focusIsLost() ? recallFocus() : active;
    frames.push(dialog);
    let live = true;
    // one microtask later: a dialog that replaces another one must not fight with the focus return of the first
    queueMicrotask(() => {
      if (!live || dialog.contains(document.activeElement)) return;
      const wanted = initialFocusRef?.current || focusables(dialog).find((entry) => !entry.hasAttribute("data-dialog-close")) || dialog;
      wanted.focus({ preventScroll: true });
    });
    return () => {
      live = false;
      const index = frames.lastIndexOf(dialog);
      if (index >= 0) frames.splice(index, 1);
      setTimeout(() => {
        // a dialog that opened meanwhile has the keyboard and will give it back in its turn
        if (!focusIsLost()) return;
        const below = frames[frames.length - 1];
        if (below) {
          // this dialog lay over another one: back to the control of that dialog that opened this one
          const inside = opener?.isConnected && below.contains(opener) ? opener : focusables(below).find((entry) => !entry.hasAttribute("data-dialog-close")) || below;
          inside.focus({ preventScroll: true });
          return;
        }
        const target = opener?.isConnected ? opener : recallFocus();
        target?.focus?.({ preventScroll: true });
        // a job that started meanwhile keeps the chrome inert: the memory stays for the end of that job
        if (!focusIsLost()) forgetFocus();
      }, 0);
    };
  }, [initialFocusRef]);

  // Escape, and Tab while the focus fell out of the dialog: in the capture phase of the document, so that
  // neither the editor's key dispatcher nor a dialog underneath (the shared Modal listens on window) sees them
  useEffect(() => {
    const onKeyDown = (event) => {
      const dialog = dialogRef.current;
      if (!dialog || !isOnTop(dialog)) return;
      if (event.key === "Escape") {
        // capture phase: a control inside the dialog that needs Escape itself (an open menu, a field that
        // clears) has not seen the key yet. It marks itself with data-dialog-escape="own".
        if (event.target instanceof Element && event.target.closest('[data-dialog-escape="own"], [role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key === "Tab" && !dialog.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        const list = focusables(dialog);
        (list[event.shiftKey ? list.length - 1 : 0] || dialog).focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const trapTab = (event) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    const list = focusables(dialog);
    if (!list.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    const inside = list.includes(active);
    if (event.shiftKey ? !inside || active === first : !inside || active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  };

  return (
    <div
      className="pdfx-dialog-backdrop"
      onMouseDown={(event) => {
        if (!alert && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cx("pdfx-dialog", `pdfx-dialog-${size}`)}
        data-tone={tone}
        onKeyDown={trapTab}
      >
        <header className="pdfx-dialog-head">
          <div className="pdfx-dialog-heading">
            <h2 id={titleId} className="pdfx-dialog-title">
              {Icon ? <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="pdfx-dialog-icon" /> : null}
              <span>{title}</span>
            </h2>
            {subtitle ? <p className="pdfx-dialog-file">{subtitle}</p> : null}
          </div>
          <button type="button" className="pdfx-btn pdfx-dialog-close" aria-label={t("Close")} data-dialog-close="true" data-testid="pdfx-action-dialog-close" disabled={typeof onClose !== "function"} onClick={() => onClose?.()}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="pdfx-dialog-body" tabIndex={scrollBody ? 0 : undefined} role={scrollBody ? "group" : undefined} aria-labelledby={scrollBody ? titleId : undefined}>
          {children}
        </div>
        {footer ? <footer className="pdfx-dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}
