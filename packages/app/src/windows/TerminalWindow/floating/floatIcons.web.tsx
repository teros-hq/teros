/** The few line icons of the floating chrome (lucide shapes, as in the mock). */

const PATHS = {
  dock: '<rect width="18" height="16" x="3" y="4" rx="2"/><path d="M9 4v16"/><path d="m16 10-3 2 3 2"/>',
  min: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
  wheel:
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 14v6"/><path d="m10.2 12.9-5.6 3.3"/><path d="m13.8 12.9 5.6 3.3"/>',
  keyboard:
    '<path d="M10 8h.01"/><path d="M12 12h.01"/><path d="M14 8h.01"/><path d="M16 12h.01"/><path d="M18 8h.01"/><path d="M6 8h.01"/><path d="M7 16h10"/><path d="M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  pip: '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
} as const

export type FloatIconName = keyof typeof PATHS

export function FloatIcon({ name, size = 14 }: { name: FloatIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static icon paths
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  )
}
