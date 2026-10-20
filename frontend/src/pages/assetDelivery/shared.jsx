import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Globe, Inbox, Loader2, Plus, TriangleAlert, X } from "lucide-react";
import { OWNERSHIP_MODES, TERRITORIES, TERRITORY_NAME_BY_CODE, TERRITORY_PRESETS, TRACK_STATUS_META } from "./constants";
import { clamp, copyToClipboard, cx, getErrorMessage, summarizeOwnership, summarizePolicyRules, unique } from "./utils";
import { useI18n } from "../../context/I18nContext";

// Hooks live in hooks.js so this file only exports components (fast refresh);
// useToast is re-exported here because the page API expects it from shared.jsx.
// eslint-disable-next-line react-refresh/only-export-components
export { useToast } from "./hooks";

// ---------------------------------------------------------------------------
// Tone maps (standard Tailwind utilities only so .theme-dark overrides apply)
// ---------------------------------------------------------------------------

const SOFT_TONES = {
  slate: "bg-slate-100 text-slate-600",
  blue: "bg-blue-50 text-blue-700",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-600",
  indigo: "bg-indigo-50 text-indigo-700"
};

const SOLID_TONES = {
  slate: "bg-slate-600",
  blue: "bg-blue-600",
  emerald: "bg-emerald-600",
  amber: "bg-amber-500",
  red: "bg-red-600",
  indigo: "bg-indigo-600"
};

/* eslint-disable i18n/no-untranslated -- Tailwind class strings keyed by tone, not copy */
const BUTTON_VARIANTS = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-300",
  secondary: "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-300",
  ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-300",
  danger: "bg-red-50 text-red-600 hover:bg-red-100 focus-visible:ring-red-300",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:ring-emerald-300",
  indigo: "bg-indigo-600 text-white hover:bg-indigo-700 focus-visible:ring-indigo-300"
};
/* eslint-enable i18n/no-untranslated */

const BUTTON_SIZES = {
  sm: "h-9 gap-1.5 rounded-xl px-3 text-xs",
  md: "h-11 gap-2 rounded-2xl px-4 text-sm"
};

const CONTROL_BASE =
  "w-full border bg-white font-bold text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60";

const CONTROL_SIZES = {
  md: "h-11 rounded-2xl px-4 text-sm",
  sm: "h-9 rounded-xl px-2.5 text-xs"
};

function controlClass({ size = "md", compact = false, invalid = false, className }) {
  const resolvedSize = compact ? "sm" : size;
  return cx(
    CONTROL_BASE,
    CONTROL_SIZES[resolvedSize] || CONTROL_SIZES.md,
    invalid
      ? "border-red-300 focus:border-red-500 focus:ring-red-100"
      : "border-slate-200 focus:border-blue-500 focus:ring-blue-100",
    className
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

export function Card({ title, subtitle, eyebrow, icon: Icon, actions, children, className, bodyClassName, tone = "emerald" }) {
  const hasHeader = Boolean(title || subtitle || eyebrow || actions);
  return (
    <section className={cx("rounded-3xl border border-slate-200 bg-white p-5 shadow-sm", className)}>
      {hasHeader && (
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            {eyebrow && (
              <p className={cx("inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-black uppercase tracking-wide", SOFT_TONES[tone] || SOFT_TONES.emerald)}>
                {Icon && <Icon size={14} />}
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className={cx("flex items-center gap-2 text-xl font-black text-slate-950", eyebrow && "mt-2")}>
                {!eyebrow && Icon && <Icon size={20} className="text-slate-400" />}
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cx(hasHeader && "mt-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, required, error, children, className, htmlFor, actions }) {
  return (
    <div className={cx("block min-w-0", className)}>
      {(label || actions) && (
        <div className="flex items-center justify-between gap-2">
          {label ? (
            <label htmlFor={htmlFor} className="text-xs font-black uppercase tracking-wide text-slate-400">
              {label}
              {required && <span className="ml-0.5 text-red-500">*</span>}
            </label>
          ) : (
            <span />
          )}
          {actions}
        </div>
      )}
      <div className={cx(label && "mt-1.5")}>{children}</div>
      {error ? (
        <p className="mt-1 text-xs font-bold text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextInput({ invalid = false, size = "md", compact = false, mono = false, className, ...props }) {
  return <input {...props} className={cx(controlClass({ size, compact, invalid }), mono && "font-mono", className)} />;
}

export function Select({ invalid = false, size = "md", compact = false, className, wrapperClassName, options, placeholder, children, ...props }) {
  return (
    <div className={cx("relative", wrapperClassName)}>
      <select {...props} className={cx(controlClass({ size, compact, invalid }), "appearance-none pr-9", className)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {Array.isArray(options) &&
          options.map((option) => {
            const item = typeof option === "object" && option !== null ? option : { value: option, label: String(option) };
            return (
              <option key={String(item.value)} value={item.value} disabled={item.disabled}>
                {item.label ?? String(item.value)}
              </option>
            );
          })}
        {children}
      </select>
      <ChevronDown size={compact || size === "sm" ? 14 : 16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
    </div>
  );
}

export function TextArea({ invalid = false, compact = false, mono = false, className, rows = 4, ...props }) {
  return (
    <textarea
      rows={rows}
      {...props}
      className={cx(
        "w-full border bg-white font-bold text-slate-900 outline-none transition placeholder:text-slate-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60",
        compact ? "rounded-xl px-2.5 py-2 text-xs" : "rounded-2xl px-4 py-3 text-sm",
        invalid ? "border-red-300 focus:border-red-500 focus:ring-red-100" : "border-slate-200 focus:border-blue-500 focus:ring-blue-100",
        mono && "font-mono",
        className
      )}
    />
  );
}

export function Toggle({ checked = false, onChange, label, description, disabled = false, className, size = "md" }) {
  const small = size === "sm";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx(
        "flex items-center gap-3 rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200",
        disabled && "cursor-not-allowed opacity-60",
        className
      )}
    >
      <span className={cx("relative inline-flex shrink-0 rounded-full transition-colors", small ? "h-5 w-9" : "h-6 w-11", checked ? "bg-blue-600" : "bg-slate-300")}>
        <span
          className={cx(
            "absolute left-0.5 top-0.5 rounded-full bg-white shadow transition-transform",
            small ? "h-4 w-4" : "h-5 w-5",
            checked && (small ? "translate-x-4" : "translate-x-5")
          )}
        />
      </span>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className={cx("block font-bold text-slate-800", small ? "text-xs" : "text-sm")}>{label}</span>}
          {description && <span className="block text-xs text-slate-400">{description}</span>}
        </span>
      )}
    </button>
  );
}

export function Button({ variant = "primary", size = "md", loading = false, icon: Icon, iconSize, children, className, type = "button", disabled = false, ...props }) {
  const resolvedIconSize = iconSize || (size === "sm" ? 14 : 17);
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60",
        BUTTON_SIZES[size] || BUTTON_SIZES.md,
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary,
        className
      )}
    >
      {loading ? <Loader2 size={resolvedIconSize} className="animate-spin" /> : Icon ? <Icon size={resolvedIconSize} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, size = "md", tone = "slate", className, loading = false, disabled = false, ...props }) {
  const dims = size === "sm" ? "h-8 w-8 rounded-lg" : "h-9 w-9 rounded-xl";
  const tones = {
    slate: "border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900",
    blue: "border border-blue-100 bg-blue-50 text-blue-700 hover:bg-blue-100",
    red: "border border-red-100 bg-red-50 text-red-600 hover:bg-red-100",
    ghost: "text-slate-400 hover:bg-slate-100 hover:text-slate-800"
  };
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled || loading}
      {...props}
      className={cx(
        "inline-flex shrink-0 items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50",
        dims,
        tones[tone] || tones.slate,
        className
      )}
    >
      {loading ? <Loader2 size={size === "sm" ? 14 : 16} className="animate-spin" /> : Icon ? <Icon size={size === "sm" ? 14 : 16} /> : null}
    </button>
  );
}

/** Hidden file input rendered as a button; supports directory selection. */
export function FilePickerButton({ accept, multiple = false, directory = false, onFiles, children, icon: Icon, variant = "secondary", size = "md", disabled = false, loading = false, className }) {
  const inputRef = useRef(null);
  const directoryProps = directory ? { webkitdirectory: "", directory: "" } : {};
  return (
    <>
      <Button
        variant={variant}
        size={size}
        icon={Icon}
        disabled={disabled}
        loading={loading}
        className={className}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple || directory}
        className="hidden"
        disabled={disabled}
        {...directoryProps}
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          if (files.length) onFiles?.(files);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Badges, tiles, progress, messages
// ---------------------------------------------------------------------------

export function Badge({ tone = "slate", icon: Icon, children, className, title }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide",
        SOFT_TONES[tone] || SOFT_TONES.slate,
        className
      )}
    >
      {Icon && <Icon size={11} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status, meta = TRACK_STATUS_META, className, title }) {
  const { t } = useI18n();
  const entry = (meta && status && meta[status]) || null;
  const label = entry?.label ? t(entry.label) : status ? String(status).replace(/_/g, " ") : t("Unknown");
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide",
        entry?.cls || SOFT_TONES.slate,
        className
      )}
    >
      {entry?.spin && <Loader2 size={11} className="animate-spin" />}
      {label}
    </span>
  );
}

export function StatTile({ label, value, hint, tone = "slate", icon: Icon, className }) {
  return (
    <div className={cx("rounded-2xl border border-slate-200 bg-white p-4", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-1 truncate text-2xl font-black text-slate-950">{value ?? "–"}</p>
          {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
        </div>
        {Icon ? (
          <span className={cx("shrink-0 rounded-xl p-2", SOFT_TONES[tone] || SOFT_TONES.slate)}>
            <Icon size={18} />
          </span>
        ) : (
          <span className={cx("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", SOLID_TONES[tone] || SOLID_TONES.slate)} />
        )}
      </div>
    </div>
  );
}

export function ProgressBar({ value = 0, tone = "blue", label, className, showValue = true, size = "md" }) {
  const percent = Math.round(clamp(value, 0, 100));
  return (
    <div className={className}>
      {(label || showValue) && (
        <div className="mb-1 flex items-center justify-between gap-2 text-xs font-bold text-slate-500">
          <span className="truncate">{label}</span>
          {showValue && <span>{percent}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cx("w-full overflow-hidden rounded-full bg-slate-100", size === "sm" ? "h-1.5" : "h-2.5")}
      >
        <div className={cx("h-full rounded-full transition-all duration-300", SOLID_TONES[tone] || SOLID_TONES.blue)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

/* eslint-disable i18n/no-untranslated -- Tailwind class strings keyed by tone, not copy */
const MESSAGE_TONES = {
  info: "bg-blue-50 text-blue-700",
  error: "bg-red-50 text-red-600",
  warning: "bg-amber-50 text-amber-700",
  success: "bg-emerald-50 text-emerald-700",
  neutral: "bg-slate-50 text-slate-600"
};
/* eslint-enable i18n/no-untranslated */

export function InlineMessage({ tone = "info", icon: Icon, title, children, actions, className }) {
  const ResolvedIcon = Icon || (tone === "warning" || tone === "error" ? TriangleAlert : null);
  return (
    <div className={cx("flex flex-col gap-2 rounded-2xl px-4 py-3 text-sm font-bold md:flex-row md:items-start md:justify-between", MESSAGE_TONES[tone] || MESSAGE_TONES.info, className)}>
      <div className="flex min-w-0 items-start gap-2">
        {ResolvedIcon && <ResolvedIcon size={16} className="mt-0.5 shrink-0" />}
        <div className="min-w-0">
          {title && <p className="font-black">{title}</p>}
          <div className={cx(title && "mt-0.5 font-medium")}>{children}</div>
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ size = 16, className }) {
  return <Loader2 size={size} className={cx("animate-spin text-slate-400", className)} />;
}

// ---------------------------------------------------------------------------
// Modal / confirm / toast / empty state
// ---------------------------------------------------------------------------

const MODAL_SIZES = {
  sm: "max-w-lg",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-6xl"
};

// Elements Tab can reach inside a dialog (disabled controls and tabindex="-1" containers excluded).
const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
// Open dialogs, oldest first: only the top-most one recovers a focus that fell out of every dialog.
const openDialogs = [];

function visibleFocusables(dialog) {
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => element.getClientRects().length > 0);
}

function isTopDialog(dialog) {
  return Boolean(dialog) && openDialogs[openDialogs.length - 1] === dialog;
}

// True when nothing useful has the focus: the focused control was unmounted or disabled (a
// "Release" button that turns into "Cancel run"), which browsers answer by focusing <body>.
function focusIsLost() {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || (typeof active.matches === "function" && active.matches(":disabled"));
}

/**
 * Accessible dialog rendered in place (no portal). `onClose` undefined means "cannot close now":
 * the header X is disabled with `closeHint` (or a default) as its tooltip, Esc / backdrop do nothing.
 */
export function Modal({ open, title, subtitle, onClose, closeHint, footer, children, size = "md", className, bodyClassName, closeOnBackdrop = true }) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef(null);
  const canClose = typeof onClose === "function";

  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
        return;
      }
      // Tab while no control of this dialog has the focus (it fell to <body> after the focused
      // button unmounted or was disabled): the dialog's own handler never sees that key, and the
      // browser would move on to the page behind the backdrop. Only the top-most dialog reacts.
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || !dialog || !isTopDialog(dialog) || dialog.contains(document.activeElement)) return;
      event.preventDefault();
      const focusable = visibleFocusables(dialog);
      const target = focusable.length ? focusable[event.shiftKey ? focusable.length - 1 : 0] : dialog;
      target.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  // Keyboard and screen-reader users land inside the dialog when it opens and get their
  // previous position back when it closes. Only `open` is a dependency: re-rendering the
  // parent with a new onClose must not move the focus around while someone is typing.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
    };
  }, [open]);

  // The stack of open dialogs decides which one owns a lost focus.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    openDialogs.push(dialog);
    return () => {
      const index = openDialogs.lastIndexOf(dialog);
      if (index >= 0) openDialogs.splice(index, 1);
    };
  }, [open]);

  // After every commit (and after a blur to nowhere) the top-most dialog takes a lost focus back,
  // so the next Tab starts inside it instead of on the page behind.
  const recoverFocus = () => {
    const dialog = dialogRef.current;
    if (!open || !dialog || !isTopDialog(dialog) || !focusIsLost()) return;
    dialog.focus({ preventScroll: true });
  };
  useLayoutEffect(recoverFocus);

  // Tab / Shift+Tab cycle inside the dialog so the covered page stays unreachable. Attached to the
  // dialog element, not window: with two dialogs mounted only the one that owns the focus reacts.
  function handleDialogKeyDown(event) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog || event.target.closest?.('[role="dialog"]') !== dialog) return;
    const focusable = visibleFocusables(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    // Not inside: the focus still sits on the freshly opened dialog container (tabIndex -1).
    const inside = focusable.includes(active);
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 m-0 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onKeyDown={handleDialogKeyDown}
        onBlur={(event) => {
          // A disabled control loses the focus a tick later with no relatedTarget; take it back.
          if (event.relatedTarget === null) queueMicrotask(recoverFocus);
        }}
        className={cx("flex max-h-[92vh] w-full flex-col overflow-hidden rounded-3xl bg-white shadow-2xl focus:outline-none", MODAL_SIZES[size] || MODAL_SIZES.md, className)}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
          <div className="min-w-0">
            {title && (
              <h2 id={titleId} className="text-xl font-black text-slate-950">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!canClose}
            aria-label={t("Close")}
            title={canClose ? t("Close") : closeHint || t("Finish or cancel the current action before closing")}
            className="shrink-0 rounded-2xl border border-slate-200 p-2.5 text-slate-500 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>
        <div className={cx("min-h-0 flex-1 overflow-y-auto p-5", bodyClassName)}>{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 p-5">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, tone = "primary", loading = false, onConfirm, onCancel, children, size = "sm" }) {
  const { t } = useI18n();
  // Defaults are resolved here (not as destructuring defaults) so they follow the UI language.
  const resolvedTitle = title === undefined ? t("Are you sure?") : title;
  const resolvedConfirmLabel = confirmLabel === undefined ? t("Confirm") : confirmLabel;
  const resolvedCancelLabel = cancelLabel === undefined ? t("Cancel") : cancelLabel;
  const variant = tone === "danger" || tone === "red" ? "danger" : tone === "success" || tone === "emerald" ? "success" : tone === "indigo" ? "indigo" : "primary";
  return (
    <Modal
      open={open}
      title={resolvedTitle}
      onClose={loading ? undefined : onCancel}
      size={size}
      closeOnBackdrop={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {resolvedCancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={loading}>
            {resolvedConfirmLabel}
          </Button>
        </>
      }
    >
      {message && <p className="text-sm font-medium text-slate-600">{message}</p>}
      {children && <div className={cx(message && "mt-4")}>{children}</div>}
    </Modal>
  );
}

/* eslint-disable i18n/no-untranslated -- Tailwind class strings keyed by tone, not copy */
const TOAST_TONES = {
  dark: "bg-slate-950 text-white",
  success: "bg-emerald-600 text-white",
  error: "bg-red-600 text-white",
  warning: "bg-amber-500 text-white",
  info: "bg-blue-600 text-white"
};
/* eslint-enable i18n/no-untranslated */

/**
 * Toast bubble inside an always-mounted live region: a status element that appears already filled
 * is not announced. Pass the `id` of the useToast state so an identical message shown twice
 * remounts the bubble and is announced again.
 */
export function Toast({ id, message, tone = "dark", className }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="pointer-events-none fixed bottom-5 left-1/2 z-[70] m-0 max-w-[calc(100vw-2rem)] -translate-x-1/2">
      {message ? (
        <div key={id ?? message} className={cx("pointer-events-auto rounded-2xl px-4 py-3 text-sm font-black shadow-2xl", TOAST_TONES[tone] || TOAST_TONES.dark, className)}>
          {message}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, description, action, className, compact = false }) {
  return (
    <div className={cx("flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50 text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      <span className="rounded-2xl bg-white p-3 text-slate-400 shadow-sm">
        <Icon size={compact ? 20 : 26} />
      </span>
      {title && <p className={cx("mt-4 font-black text-slate-800", compact ? "text-sm" : "text-base")}>{title}</p>}
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChipInput
// ---------------------------------------------------------------------------

const SEPARATOR_RE = /[,;\n\r\t]/;

function toSuggestion(item) {
  if (typeof item === "string" || typeof item === "number") {
    return { value: String(item), label: String(item), hint: "" };
  }
  if (!item) return null;
  return { value: String(item.value ?? item.label ?? ""), label: String(item.label ?? item.value ?? ""), hint: item.hint || "" };
}

/**
 * Multi-value chip input with an autocomplete dropdown.
 * - Enter adds the highlighted suggestion (or the typed value); Backspace on empty input removes the last chip.
 * - Comma / semicolon / newline / tab split pasted or typed text into several chips.
 * - `normalize(value)` transforms typed values; `validate(value)` marks chips red when false.
 * - `allowCreate` + `onCreate(value)` shows a "Create «x» in CMS" action; onCreate may return the created name.
 */
export function ChipInput({
  values = [],
  suggestions = [],
  onChange,
  placeholder,
  allowCreate = false,
  onCreate,
  createLabel,
  normalize,
  validate,
  getLabel,
  compact = false,
  disabled = false,
  className,
  maxSuggestions = 60,
  id
}) {
  const { t, tm } = useI18n();
  const generatedId = useId();
  const inputId = id || generatedId;
  const listId = `${inputId}-list`;
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const list = useMemo(() => (Array.isArray(values) ? values.map((value) => String(value)) : []), [values]);
  const valueSet = useMemo(() => new Set(list), [list]);
  const normalizedSuggestions = useMemo(() => suggestions.map(toSuggestion).filter((item) => item && item.value), [suggestions]);
  const query = input.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      normalizedSuggestions
        .filter((item) => !valueSet.has(item.value))
        .filter((item) => !query || item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
        .slice(0, maxSuggestions),
    [normalizedSuggestions, valueSet, query, maxSuggestions]
  );

  const normalizeValue = (raw) => {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return "";
    return normalize ? String(normalize(trimmed) ?? "").trim() : trimmed;
  };

  const typedValue = normalizeValue(input);
  const exactExists = Boolean(query) && normalizedSuggestions.some((item) => item.value.toLowerCase() === query || item.label.toLowerCase() === query);
  const canCreate = allowCreate && Boolean(typedValue) && !exactExists && !valueSet.has(typedValue);
  const items = useMemo(() => {
    const output = filtered.map((item) => ({ type: "suggestion", ...item }));
    if (canCreate) output.push({ type: "create", value: typedValue, label: typedValue, hint: "" });
    return output;
  }, [filtered, canCreate, typedValue]);
  const activeIndex = items.length ? Math.min(highlight, items.length - 1) : -1;

  useEffect(() => {
    if (!open) return undefined;
    const handleClick = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function commit(next) {
    onChange?.(next);
  }

  function addValues(rawValues) {
    const next = [...list];
    rawValues.forEach((raw) => {
      const value = normalizeValue(raw);
      if (!value || next.includes(value)) return;
      next.push(value);
    });
    if (next.length !== list.length) commit(next);
  }

  function removeAt(index) {
    if (disabled) return;
    commit(list.filter((_, position) => position !== index));
  }

  function resetInput() {
    setInput("");
    setHighlight(0);
    setCreateError("");
  }

  async function handleCreate(value) {
    if (!onCreate) {
      addValues([value]);
      resetInput();
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const result = await onCreate(value);
      const created = typeof result === "string" && result.trim() ? result.trim() : typeof result?.labelName === "string" ? result.labelName : value;
      addValues([created]);
      resetInput();
      setOpen(false);
    } catch (error) {
      setCreateError(getErrorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  function selectItem(item) {
    if (!item) return;
    if (item.type === "create") {
      handleCreate(item.value);
      return;
    }
    addValues([item.value]);
    resetInput();
    inputRef.current?.focus();
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0 && items[activeIndex]) {
        selectItem(items[activeIndex]);
      } else if (typedValue) {
        addValues([input]);
        resetInput();
      }
      return;
    }
    if (event.key === "Backspace" && !input && list.length) {
      event.preventDefault();
      removeAt(list.length - 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((current) => Math.min(current + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "," || event.key === ";") {
      event.preventDefault();
      if (typedValue) {
        addValues([input]);
        resetInput();
      }
      return;
    }
    if (event.key === "Tab" && typedValue) {
      addValues([input]);
      resetInput();
    }
  }

  function handleChange(event) {
    const raw = event.target.value;
    if (SEPARATOR_RE.test(raw)) {
      const parts = raw.split(SEPARATOR_RE);
      const last = parts.pop();
      addValues(parts);
      setInput(last || "");
    } else {
      setInput(raw);
    }
    setHighlight(0);
    setCreateError("");
    setOpen(true);
  }

  function handlePaste(event) {
    const text = event.clipboardData?.getData("text") || "";
    if (SEPARATOR_RE.test(text)) {
      event.preventDefault();
      addValues(text.split(SEPARATOR_RE));
      resetInput();
    }
  }

  const createText = typeof createLabel === "function" ? createLabel(typedValue) : createLabel || t("Create «{value}» in CMS", { value: typedValue });
  const showDropdown = open && !disabled && (items.length > 0 || Boolean(query));

  return (
    <div ref={containerRef} className={cx("relative", className)}>
      <div
        onClick={() => {
          if (!disabled) inputRef.current?.focus();
        }}
        className={cx(
          "flex flex-wrap items-center gap-1.5 border bg-white transition focus-within:ring-2",
          compact ? "min-h-9 rounded-xl px-2 py-1" : "min-h-11 rounded-2xl px-3 py-1.5",
          createError ? "border-red-300 focus-within:border-red-500 focus-within:ring-red-100" : "border-slate-200 focus-within:border-blue-500 focus-within:ring-blue-100",
          disabled && "cursor-not-allowed opacity-60"
        )}
      >
        {list.map((value, index) => {
          const valid = validate ? Boolean(validate(value)) : true;
          const title = getLabel ? getLabel(value) : undefined;
          return (
            <span
              key={`${value}-${index}`}
              title={title || (valid ? undefined : t("Invalid value"))}
              className={cx(
                "inline-flex max-w-full items-center gap-1 rounded-full font-bold",
                compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
                valid ? "bg-blue-50 text-blue-700" : "bg-red-50 text-red-600"
              )}
            >
              <span className="truncate">{value}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={t("Remove {value}", { value })}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeAt(index);
                  }}
                  className="rounded-full p-0.5 transition hover:bg-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                >
                  <X size={compact ? 10 : 12} />
                </button>
              )}
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={inputId}
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-autocomplete="list"
          value={input}
          disabled={disabled}
          placeholder={list.length ? "" : placeholder === undefined ? t("Type and press Enter") : placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => setOpen(true)}
          className={cx("min-w-[6rem] flex-1 bg-transparent font-bold text-slate-900 outline-none placeholder:text-slate-400", compact ? "h-6 text-xs" : "h-7 text-sm")}
        />
        {creating && <Loader2 size={14} className="animate-spin text-slate-400" />}
      </div>

      {showDropdown && (
        <div
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-xl"
        >
          {items.map((item, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={`${item.type}-${item.value}`}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => selectItem(item)}
                disabled={creating}
                className={cx(
                  "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-bold transition",
                  active ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50",
                  item.type === "create" && "text-emerald-700"
                )}
              >
                {item.type === "create" ? (
                  <>
                    {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                    <span className="truncate">{createText}</span>
                  </>
                ) : (
                  <>
                    <span className="truncate">{item.label}</span>
                    {item.hint && <span className="ml-auto shrink-0 text-xs font-medium text-slate-400">{item.hint}</span>}
                  </>
                )}
              </button>
            );
          })}
          {!items.length && query && <p className="px-3 py-2 text-xs font-bold text-slate-400">{t("No matches — press Enter to add “{value}”", { value: typedValue || input.trim() })}</p>}
        </div>
      )}
      {createError && <p className="mt-1 text-xs font-bold text-red-600">{tm(createError)}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TerritoryPicker
// ---------------------------------------------------------------------------

const TERRITORY_CODE_SET = new Set(TERRITORIES.map((territory) => territory.code));

function normalizeTerritoryCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
}

// `localize(code, englishName)` (regionName from useI18n) gives the Vietnamese country name;
// English keeps the names of the data table.
function territoryLabel(code, localize) {
  const name = TERRITORY_NAME_BY_CODE[code];
  if (!name) return code;
  return `${code} — ${localize ? localize(code, name) : name}`;
}

function isKnownTerritory(code) {
  return TERRITORY_CODE_SET.has(code);
}

/**
 * Ownership territory selector: Worldwide / Include / Exclude + ISO code chips + presets.
 * onChange receives `{ mode, territories }`.
 */
export function TerritoryPicker({ mode = "worldwide", territories = [], onChange, className, compact = false, disabled = false, modes }) {
  const { t, language, regionName } = useI18n();
  // Vietnamese shows the Intl country names (so typing "Việt" finds VN); English keeps the table's names.
  const localizeName = language === "vi" ? regionName : null;
  const suggestions = useMemo(
    () => TERRITORIES.map((territory) => ({ value: territory.code, label: `${territory.code} — ${localizeName ? localizeName(territory.code, territory.name) : territory.name}` })),
    [localizeName]
  );
  const availableModes = Array.isArray(modes) && modes.length ? OWNERSHIP_MODES.filter((item) => modes.includes(item.value)) : OWNERSHIP_MODES;
  const list = Array.isArray(territories) ? territories : [];
  const unknown = list.filter((code) => !isKnownTerritory(code));
  const needsList = mode !== "worldwide";

  function update(patch) {
    onChange?.({ mode, territories: list, ...patch });
  }

  return (
    <div className={cx("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label={t("Ownership scope")} className="inline-flex rounded-2xl border border-slate-200 bg-slate-50 p-1">
          {availableModes.map((item) => {
            const active = item.value === mode;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={active}
                title={t(item.description)}
                disabled={disabled}
                onClick={() => update({ mode: item.value })}
                className={cx(
                  "rounded-xl px-3 py-1.5 text-xs font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed",
                  active ? "bg-white text-blue-700 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:text-slate-900"
                )}
              >
                {t(item.label)}
              </button>
            );
          })}
        </div>
        <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-500">
          <Globe size={13} />
          {summarizeOwnership(mode, list)}
        </span>
      </div>

      {needsList && (
        <div className="space-y-2">
          <ChipInput
            values={list}
            suggestions={suggestions}
            onChange={(next) => update({ territories: unique(next.map(normalizeTerritoryCode).filter(Boolean)) })}
            normalize={normalizeTerritoryCode}
            validate={isKnownTerritory}
            getLabel={(code) => territoryLabel(code, localizeName)}
            placeholder={t("Type a country code or name…")}
            compact={compact}
            disabled={disabled}
            maxSuggestions={40}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-400">{t("Presets")}</span>
            {TERRITORY_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={disabled}
                onClick={() => update({ territories: unique([...list, ...preset.codes]) })}
                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                + {t(preset.label)}
              </button>
            ))}
            {list.length > 0 && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => update({ territories: [] })}
                className="rounded-full px-2.5 py-1 text-[11px] font-black text-red-600 transition hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
              >
                {t("Clear")}
              </button>
            )}
          </div>
          {mode === "include" && !list.length && <p className="text-xs font-bold text-red-600">{t("Select at least one territory to include.")}</p>}
          {unknown.length > 0 && <p className="text-xs font-bold text-red-600">{t("Unknown territory code(s): {codes}", { codes: unknown.join(", ") })}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PolicySelect
// ---------------------------------------------------------------------------

/**
 * Saved match policy selector. `onChange(policyId, policy | null)`.
 * When the value is not one of `policies`, the manual ID input is shown automatically.
 */
export function PolicySelect({ policies = [], value = "", onChange, loading = false, error = "", allowManual = true, className, compact = false, placeholder, disabled = false }) {
  const { t, tm } = useI18n();
  const [manualMode, setManualMode] = useState(false);
  const list = Array.isArray(policies) ? policies : [];
  const selected = list.find((policy) => String(policy.id) === String(value)) || null;
  const valueIsManual = Boolean(value) && !selected;
  const showManual = allowManual && (manualMode || valueIsManual || (!loading && !error && !list.length));
  const summary = selected ? selected.summary || summarizePolicyRules(selected.rules) : "";

  function toggleManual() {
    const next = !showManual;
    setManualMode(next);
    if (!next && valueIsManual) onChange?.("", null);
  }

  return (
    <div className={cx("space-y-2", className)}>
      {showManual ? (
        <TextInput
          value={value || ""}
          mono
          compact={compact}
          disabled={disabled}
          placeholder={t("Policy ID (e.g. 1234567890)")}
          onChange={(event) => onChange?.(event.target.value.trim(), null)}
        />
      ) : (
        <Select
          value={selected ? String(selected.id) : ""}
          compact={compact}
          disabled={disabled || loading}
          placeholder={loading ? t("Loading saved policies…") : placeholder === undefined ? t("Select a match policy") : placeholder}
          onChange={(event) => {
            const policy = list.find((item) => String(item.id) === event.target.value) || null;
            onChange?.(policy ? String(policy.id) : "", policy);
          }}
          options={list.map((policy) => ({ value: String(policy.id), label: policy.name || policy.id }))}
        />
      )}

      {loading && (
        <p className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-400">
          <Loader2 size={12} className="animate-spin" /> {t("Loading saved policies from CMS…")}
        </p>
      )}
      {!loading && error && <p className="text-xs font-bold text-red-600">{tm(error)}</p>}

      {selected && !showManual && (
        <div className="rounded-2xl bg-slate-50 px-3 py-2 text-xs">
          <p className="font-black text-slate-700">{selected.name}</p>
          {summary && <p className="mt-0.5 font-bold text-slate-500">{tm(summary)}</p>}
          {selected.description && <p className="mt-0.5 text-slate-400">{selected.description}</p>}
        </div>
      )}
      {showManual && valueIsManual && <p className="text-xs font-bold text-slate-400">{t("Using policy ID {value} (not in the saved policy list).", { value })}</p>}

      {allowManual && (
        <button
          type="button"
          onClick={toggleManual}
          disabled={disabled}
          className="text-xs font-black text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
        >
          {showManual ? t("Choose from saved policies") : t("Enter policy ID manually")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON / copy / stepper / tabs
// ---------------------------------------------------------------------------

export function CopyButton({ text, label, copiedLabel, size = "sm", variant = "ghost", className, iconOnly = false }) {
  const { t } = useI18n();
  const resolvedLabel = label === undefined ? t("Copy") : label;
  const resolvedCopiedLabel = copiedLabel === undefined ? t("Copied") : copiedLabel;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  async function handleCopy(event) {
    event.stopPropagation();
    const ok = await copyToClipboard(text);
    setCopied(ok);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? resolvedCopiedLabel : resolvedLabel}
        aria-label={copied ? resolvedCopiedLabel : resolvedLabel}
        className={cx(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200",
          copied ? "bg-emerald-50 text-emerald-700" : "text-slate-400 hover:bg-slate-100 hover:text-slate-800",
          className
        )}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    );
  }

  return (
    <Button variant={copied ? "success" : variant} size={size} icon={copied ? Check : Copy} onClick={handleCopy} className={className}>
      {copied ? resolvedCopiedLabel : resolvedLabel}
    </Button>
  );
}

export function JsonViewer({ value, maxHeight = 320, className, copy = true }) {
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2);
  return (
    <div className={cx("relative", className)}>
      {copy && text && (
        <div className="absolute right-2 top-2">
          <CopyButton text={text} iconOnly className="bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white" />
        </div>
      )}
      <pre style={{ maxHeight }} className="overflow-auto rounded-2xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
        {text || "—"}
      </pre>
    </div>
  );
}

export function Stepper({ steps = [], active, done = [], className, onSelect }) {
  return (
    <ol className={cx("flex flex-col gap-3 md:flex-row md:items-center", className)}>
      {steps.map((step, index) => {
        const isDone = done.includes(step.key);
        const isActive = step.key === active;
        const isLast = index === steps.length - 1;
        return (
          <li key={step.key} className={cx("flex items-center gap-3", !isLast && "md:flex-1")}>
            <button
              type="button"
              disabled={!onSelect}
              onClick={() => onSelect?.(step.key)}
              className={cx(
                "flex items-center gap-3 rounded-2xl px-2 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200",
                onSelect ? "hover:bg-slate-50" : "cursor-default"
              )}
            >
              <span
                className={cx(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-black transition",
                  isDone ? "bg-emerald-600 text-white" : isActive ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"
                )}
              >
                {isDone ? <Check size={16} /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={cx("block text-sm font-black", isActive || isDone ? "text-slate-950" : "text-slate-500")}>{step.label}</span>
                {step.description && <span className="block text-xs text-slate-400">{step.description}</span>}
              </span>
            </button>
            {!isLast && <span className={cx("hidden h-0.5 flex-1 rounded-full md:block", isDone ? "bg-emerald-200" : "bg-slate-100")} />}
          </li>
        );
      })}
    </ol>
  );
}

export function TabBar({ tabs = [], active, onChange, className }) {
  return (
    <div role="tablist" className={cx("flex flex-wrap gap-2 rounded-3xl border border-slate-200 bg-white p-2 shadow-sm", className)}>
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={tab.disabled}
            onClick={() => onChange?.(tab.key)}
            className={cx(
              "inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-50",
              isActive ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
            )}
          >
            {Icon && <Icon size={16} />}
            {tab.label}
            {tab.count !== undefined && tab.count !== null && (
              <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-black", isActive ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600")}>{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
