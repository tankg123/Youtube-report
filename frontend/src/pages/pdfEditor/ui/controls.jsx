import { Component } from "react";
import { cx } from "./classNames.js";

// The small controls of the editor chrome (app bar, tool bar, status bar, rails): 36 px targets, 18 px icons,
// a tooltip with the label and the shortcut, a visible focus ring. Styles: styles/shell.css (.pdfx-btn).
//
// The tooltip is CSS only (data-tip): it appears 500 ms after the pointer rests on the control and at once
// when the keyboard focuses it. The accessible name is aria-label; no title attribute (two tooltips).

/**
 * A button of the chrome.
 *   icon        a lucide-react component          label      the accessible name (translated)
 *   shortcut    shown after the label in the tooltip ("Ctrl+O")
 *   hint        replaces the tooltip text (why a control is disabled)
 *   text        a visible caption next to the icon
 *   pressed     aria-pressed (toggles, tools)
 *   disabled    with `soft` the button stays focusable and only says aria-disabled (tool bar: a keyboard user
 *               can still reach it and hear why it does nothing)
 */
export function BarButton({ icon: Icon, label, shortcut, hint, text, pressed, disabled = false, soft = false, primary = false, testId, tipSide, tipAlign, className, onClick, children, iconSize = 18, ...rest }) {
  const tip = hint || (shortcut ? `${label}  ${shortcut}` : label);
  return (
    <button
      type="button"
      {...rest}
      className={cx("pdfx-btn", text ? "pdfx-btn-text" : null, primary ? "pdfx-btn-primary" : null, className)}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed ? "true" : "false"}
      aria-disabled={soft && disabled ? "true" : undefined}
      disabled={!soft && disabled}
      data-tip={tip}
      data-tip-side={tipSide}
      data-tip-align={tipAlign}
      data-testid={testId}
      onClick={(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {Icon ? <Icon size={iconSize} strokeWidth={1.75} aria-hidden="true" /> : null}
      {text ? <span className="pdfx-btn-label">{text}</span> : null}
      {children}
    </button>
  );
}

/** A thin vertical rule between groups of a bar. */
export function BarSeparator() {
  return <span className="pdfx-bar-separator" role="separator" aria-orientation="vertical" />;
}

/** A small status label: tone "neutral" | "info" | "success" | "warning" | "danger". */
export function Chip({ tone = "neutral", icon: Icon, hint, testId, children, ...rest }) {
  return (
    <span {...rest} className={cx("pdfx-chip", `pdfx-chip-${tone}`)} data-tip={hint} data-testid={testId} tabIndex={hint ? 0 : undefined}>
      {Icon ? <Icon size={13} strokeWidth={2} aria-hidden="true" /> : null}
      <span>{children}</span>
    </span>
  );
}

/**
 * Keeps a failure of one feature slot (a panel, a banner, the overlay of one page) inside that slot.
 * `fallback` is what the slot shows instead: a node, or (retry) => node. `onError` hears about it once.
 */
export class SlotBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
    this.retry = () => this.setState({ failed: false });
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { fallback = null } = this.props;
    return typeof fallback === "function" ? fallback(this.retry) : fallback;
  }
}
