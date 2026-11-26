import { useState } from "react";

// Only render an explicitly selected uploaded logo. Random-color mode supplies
// no source and leaves the colored circle completely empty.
export default function BrandLogoImage({ src, alt = "ANS Network", className = "" }) {
  const [failedSrc, setFailedSrc] = useState(null);
  if (!src) return null;

  const initials = String(alt).trim().split(/\s+/).filter(Boolean).slice(0, 3)
    .map((word) => Array.from(word)[0]).join("").toUpperCase() || "ANS";

  if (failedSrc === src) {
    return (
      <span
        role="img"
        aria-label={alt}
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-slate-700 text-white text-xs font-black ${className}`}
      >
        {initials}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
      onLoad={() => setFailedSrc(null)}
    />
  );
}
