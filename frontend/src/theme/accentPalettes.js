export const ACCENT_PALETTES = [
  {
    id: "mint",
    label: "Light green",
    description: "Fresh and balanced",
    primary: "#167A4A",
    primaryHover: "#11633C",
    soft: "#DDF8E8",
    softStrong: "#B9EDCF",
    border: "#78D7A3",
    ink: "#12623E",
    swatch: "#58CE8D",
    rgb: "22, 122, 74"
  },
  {
    id: "orange",
    label: "Orange",
    description: "Warm and energetic",
    primary: "#C85012",
    primaryHover: "#A63F0B",
    soft: "#FFF0E5",
    softStrong: "#FFD8BD",
    border: "#F7A46D",
    ink: "#9A3D0C",
    swatch: "#F47A32",
    rgb: "200, 80, 18"
  },
  {
    id: "blue",
    label: "Blue",
    description: "Clear and dependable",
    primary: "#2563EB",
    primaryHover: "#1D4ED8",
    soft: "#E5EFFF",
    softStrong: "#C7DBFF",
    border: "#8BB5FF",
    ink: "#1D4ED8",
    swatch: "#4D8BFA",
    rgb: "37, 99, 235"
  },
  {
    id: "violet",
    label: "Violet",
    description: "Creative and premium",
    primary: "#7C3AED",
    primaryHover: "#6D28D9",
    soft: "#F1EAFE",
    softStrong: "#DED0FC",
    border: "#B9A0F7",
    ink: "#6330BF",
    swatch: "#9666F1",
    rgb: "124, 58, 237"
  },
  {
    id: "rose",
    label: "Rose",
    description: "Bold and expressive",
    primary: "#BE123C",
    primaryHover: "#9F1239",
    soft: "#FFE8EE",
    softStrong: "#FFC9D5",
    border: "#F58AA1",
    ink: "#9F1239",
    swatch: "#E84C70",
    rgb: "190, 18, 60"
  },
  {
    id: "teal",
    label: "Teal",
    description: "Modern and focused",
    primary: "#0F766E",
    primaryHover: "#115E59",
    soft: "#DDF8F5",
    softStrong: "#B9ECE7",
    border: "#70D1C8",
    ink: "#115E59",
    swatch: "#35B8AC",
    rgb: "15, 118, 110"
  }
];

export const DEFAULT_ACCENT_ID = "mint";

export function getAccentPalette(value) {
  return ACCENT_PALETTES.find((palette) => palette.id === value) || ACCENT_PALETTES[0];
}

export function applyAccentPalette(value) {
  if (typeof document === "undefined") return;

  const palette = getAccentPalette(value);
  const root = document.documentElement;
  root.dataset.uiAccent = palette.id;
  root.style.setProperty("--ui-primary", palette.primary);
  root.style.setProperty("--ui-primary-hover", palette.primaryHover);
  root.style.setProperty("--ui-soft", palette.soft);
  root.style.setProperty("--ui-soft-strong", palette.softStrong);
  root.style.setProperty("--ui-border", palette.border);
  root.style.setProperty("--ui-ink", palette.ink);
  root.style.setProperty("--ui-accent-rgb", palette.rgb);
}
