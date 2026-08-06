/**
 * Injects the `@keyframes teros-unlimited-glare` CSS rule once at module load on
 * web: a diagonal highlight slides left-to-right across the Unlimited hero
 * (`translateX(-120%) → translateX(120%)`) so the chrome glare sweeps even though
 * the gradient itself is static.
 *
 * Pattern mirrored from `components/chat/shimmerKeyframes.ts` — injecting real
 * CSS keyframes keeps the sweep on the compositor thread and immune to Tamagui
 * re-renders. Reduce-motion is honoured by the consumer (it omits the `animation`
 * when `prefers-reduced-motion: reduce`), so the keyframes alone are enough here.
 *
 * No-op on native (`document` guard). Idempotent across multiple calls.
 */
import { Platform } from 'react-native'

const KEYFRAMES_ID = 'teros-unlimited-glare-keyframes'

export function installUnlimitedGlareKeyframes(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return
  if (document.getElementById(KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAMES_ID
  style.textContent =
    '@keyframes teros-unlimited-glare { 0% { transform: translateX(-120%); } 100% { transform: translateX(120%); } }'
  document.head.appendChild(style)
}
