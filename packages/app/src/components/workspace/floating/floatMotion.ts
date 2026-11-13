let installed = false

export const FLOAT_IN = "teros-float-in 160ms ease-out"
export const FLOAT_PULSE = "teros-float-pulse 1.6s ease-in-out infinite"

export function installFloatMotion(): void {
  if (installed || typeof document === "undefined") return
  const style = document.createElement("style")
  style.dataset.terosFloatMotion = "1"
  style.textContent = [
    "@keyframes teros-float-in{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}",
    "@keyframes teros-float-pulse{0%,100%{transform:none}50%{transform:scale(1.06)}}",
    "@media (prefers-reduced-motion: reduce){[data-float-window],[data-float-bubble]{animation:none !important}}",
    '[data-floating-layer][data-tab-drag="true"] *{pointer-events:none !important}',
  ].join("")
  document.head.appendChild(style)
  installed = true
}
