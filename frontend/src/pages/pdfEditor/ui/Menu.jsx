import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cx } from "./classNames.js";
import { BarButton } from "./controls.jsx";

// Menus of the chrome (overflow menu, zoom menu, the Shapes menu): a button with aria-haspopup="menu" and a
// list of role="menuitem" / "menuitemradio" / "menuitemcheckbox" rendered in place (no portal).
// Keys inside an open menu: Up / Down / Home / End move, Enter / Space choose, Escape closes and gives the focus
// back to the button, Tab closes. The editor's key dispatcher ignores everything inside role="menu".
//
// items: [{ id, label, kind?: "item" | "radio" | "check" | "separator" | "heading", icon?, shortcut?, checked?,
//           disabled?, hint?, testId?, onSelect? }]

const ITEM_ROLES = { item: "menuitem", radio: "menuitemradio", check: "menuitemcheckbox" };
const ENABLED_ITEMS = '[role^="menuitem"]:not([aria-disabled="true"])';

/**
 * The list of a menu. Put it next to its button inside an element with class "pdfx-menu-anchor".
 * onClose({ focus }) is called when the menu wants to close; focus: true = give the keyboard back to the button.
 */
export function MenuPopup({ open, onClose, items, align = "start", side = "bottom", label, labelledBy, testId, id }) {
  const listRef = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  });

  // Only `open` is a dependency: a re-render of the owner must not move the focus back to the first item.
  useEffect(() => {
    if (!open) return undefined;
    const list = listRef.current;
    const first = list?.querySelector(`${ENABLED_ITEMS}[aria-checked="true"]`) || list?.querySelector(ENABLED_ITEMS);
    first?.focus({ preventScroll: true });
    const onPointerDown = (event) => {
      // the button toggles the menu itself: only a press outside both of them closes it here
      if (!list?.parentElement?.contains(event.target)) closeRef.current({ focus: false });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event) => {
    const list = listRef.current;
    const entries = [...list.querySelectorAll(ENABLED_ITEMS)];
    const index = entries.indexOf(document.activeElement);
    let target = null;
    if (event.key === "ArrowDown") target = entries[(index + 1) % entries.length];
    else if (event.key === "ArrowUp") target = entries[(index - 1 + entries.length) % entries.length];
    else if (event.key === "Home") target = entries[0];
    else if (event.key === "End") target = entries[entries.length - 1];
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose({ focus: true });
      return;
    } else if (event.key === "Tab") {
      onClose({ focus: false });
      return;
    }
    // the keys of a menu never reach the tool bar around it (roving focus) or the editor's dispatcher
    event.stopPropagation();
    if (target) {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
  };

  return (
    <div
      ref={listRef}
      id={id}
      role="menu"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cx("pdfx-menu", align === "end" ? "pdfx-menu-end" : null, side === "top" ? "pdfx-menu-top" : null)}
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        if (item.kind === "separator") return <div key={item.id} role="separator" className="pdfx-menu-separator" />;
        if (item.kind === "heading") {
          return (
            <div key={item.id} role="presentation" className="pdfx-menu-heading">
              {item.label}
            </div>
          );
        }
        const Icon = item.icon;
        const checkable = item.kind === "radio" || item.kind === "check";
        return (
          <button
            key={item.id}
            type="button"
            role={ITEM_ROLES[item.kind] || ITEM_ROLES.item}
            aria-checked={checkable ? (item.checked ? "true" : "false") : undefined}
            aria-disabled={item.disabled ? "true" : undefined}
            tabIndex={-1}
            className="pdfx-menu-item"
            data-testid={item.testId}
            data-tip={item.disabled ? item.hint : undefined}
            onClick={() => {
              if (item.disabled) return;
              onClose({ focus: true });
              item.onSelect?.();
            }}
          >
            <span className="pdfx-menu-mark" aria-hidden="true">
              {checkable && item.checked ? <Check size={14} strokeWidth={2.25} /> : Icon ? <Icon size={16} strokeWidth={1.75} /> : null}
            </span>
            <span className="pdfx-menu-label">{item.label}</span>
            {item.shortcut ? <kbd className="pdfx-menu-shortcut">{item.shortcut}</kbd> : null}
          </button>
        );
      })}
    </div>
  );
}

/** A button of the chrome that opens a menu. Button props as BarButton; `items`, `align`, `side` as MenuPopup. */
export function MenuButton({ items, align, side, menuTestId, onKeyDown, ...button }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const menuId = useId();
  const close = ({ focus } = {}) => {
    setOpen(false);
    if (focus) buttonRef.current?.focus({ preventScroll: true });
  };
  return (
    <span className="pdfx-menu-anchor">
      <BarButton
        {...button}
        ref={buttonRef}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open && !button.disabled) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            return;
          }
          onKeyDown?.(event);
        }}
      />
      <MenuPopup id={menuId} open={open} onClose={close} items={items} align={align} side={side} label={button.label} testId={menuTestId} />
    </span>
  );
}
