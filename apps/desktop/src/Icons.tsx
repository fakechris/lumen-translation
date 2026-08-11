/** Inline icons — no icon font or sprite sheet to ship with the bundle. */

const base = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CopyIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

export function SpeakIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M8.5 2.5 5 5.5H2.5v5H5l3.5 3z" />
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function LumenIcon() {
  return (
    <svg {...base} width={15} height={15} aria-hidden="true">
      {/* Speech bubble with a character stroke — the same motif as the macOS
          status-bar item. */}
      <path d="M13.5 9.5a2 2 0 0 1-2 2H7l-3.5 2.5V11.5h-.5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2z" />
      <path d="M5 5.5h5M7.5 5.5v4" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
    </svg>
  );
}
