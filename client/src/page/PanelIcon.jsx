import React from 'react'

/**
 * Sidebar glyph for `sidebar.panellist`.
 *
 * The sidebar renders this with `{ size, active }` and `only: id`; it must fit
 * the host's 16/18 px glyph box and paint entirely with `currentColor` so the
 * button's own theme colour shows through.
 */
export function PanelIcon({ size = 18, active = false }) {
  const px = typeof size === 'number' && Number.isFinite(size) ? size : 18
  const strokeWidth = active ? 2 : 1.6

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      {/* Route between the two pins. */}
      <path d="M8.4 16.2c2.5-.4 3.6-2.7 4.8-4.7 1-1.7 2.1-2.7 3.5-3.2" strokeDasharray="1.6 2.6" />
      {/* Start pin. */}
      <path
        d="M4.6 18.3c0-2 2.6-5.2 2.6-5.2s2.6 3.2 2.6 5.2a2.6 2.6 0 1 1-5.2 0Z"
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.18 : 0}
      />
      <circle cx="7.2" cy="18.2" r="1" fill="currentColor" stroke="none" />
      {/* Destination pin. */}
      <path
        d="M13.9 8.6c0-2 2.6-5.2 2.6-5.2s2.6 3.2 2.6 5.2a2.6 2.6 0 1 1-5.2 0Z"
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.18 : 0}
      />
      <circle cx="16.5" cy="8.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
