import type { SVGProps } from 'react'

// 16px line icons drawn on a 16-unit grid; stroke follows currentColor.
const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false
}

export const ChevronIcon = () => (
  <svg {...base}>
    <path d="M6 4l4 4-4 4" />
  </svg>
)

export const FileIcon = () => (
  <svg {...base}>
    <path d="M9.25 1.75H4.5c-.4 0-.75.35-.75.75v11c0 .4.35.75.75.75h7c.4 0 .75-.35.75-.75V4.75z" />
    <path d="M9.25 1.75v3h3" />
  </svg>
)

export const HardDriveIcon = () => (
  <svg {...base}>
    <rect x="1.75" y="8.75" width="12.5" height="4.5" rx="1" />
    <path d="M1.75 9.75l1.9-5.4c.1-.3.4-.6.8-.6h7.1c.4 0 .7.3.8.6l1.9 5.4" />
    <path d="M11.5 11h.01M9.5 11h.01" strokeWidth={1.75} />
  </svg>
)

export const WarningIcon = () => (
  <svg {...base}>
    <path d="M8 2.25l6.25 11H1.75z" />
    <path d="M8 6.5v3M8 11.25h.01" />
  </svg>
)

/** Rows of names with their details alongside, for showing or hiding tree details. */
export const DetailsIcon = () => (
  <svg {...base}>
    <path d="M2 4h6M2 8h6M2 12h6M11 4h3M11 8h3M11 12h3" />
  </svg>
)

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
)

export const CloseIcon = () => (
  <svg {...base}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
)

export const TrashIcon = () => (
  <svg {...base}>
    <path d="M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 8.6c.03.4.36.65.75.65h4.8c.39 0 .72-.25.75-.65l.6-8.6" />
    <path d="M6.75 7v4M9.25 7v4" />
  </svg>
)

export const ReloadIcon = () => (
  <svg {...base}>
    <path d="M13 8a5 5 0 1 1-1.5-3.55" />
    <path d="M12.25 2v2.75H9.5" />
  </svg>
)

export const GearIcon = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2" />
    <path d="M6.9 1.75h2.2l.35 1.7 1.2.7 1.65-.55 1.1 1.9-1.3 1.15v1.4l1.3 1.15-1.1 1.9-1.65-.55-1.2.7-.35 1.7H6.9l-.35-1.7-1.2-.7-1.65.55-1.1-1.9 1.3-1.15v-1.4L2.6 5.5l1.1-1.9 1.65.55 1.2-.7z" />
  </svg>
)

/** The Polyscope mark: many small lenses inside one aperture. */
export const ApertureMark = () => (
  <svg className="aperture" width="148" height="148" viewBox="0 0 148 148" aria-hidden="true" focusable="false">
    <circle className="aperture-ring" cx="74" cy="74" r="70" />
    <circle className="aperture-ring aperture-ring--inner" cx="74" cy="74" r="62" />
    {[
      [74, 74],
      [74, 38],
      [105.2, 56],
      [105.2, 92],
      [74, 110],
      [42.8, 92],
      [42.8, 56]
    ].map(([cx, cy], i) => (
      <circle key={i} className={i === 0 ? 'aperture-lens aperture-lens--centre' : 'aperture-lens'} cx={cx} cy={cy} r="17" style={{ animationDelay: `${i * 70}ms` }} />
    ))}
  </svg>
)
