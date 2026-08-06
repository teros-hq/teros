/**
 * Injects the `@keyframes message-queue-shimmer` CSS rule once at module
 * load on web. The shimmer overlay slides left-to-right across the parent
 * via `translateX(-100%) → translateX(100%)` so the linear-gradient sweep
 * appears even when the gradient itself is static.
 *
 * Pattern mirrored from `mca/primitives/StatusDot.tsx` — injecting real
 * CSS keyframes keeps the animation on the compositor thread and immune
 * to Tamagui re-renders that would interrupt Animated.loop.
 *
 * No-op on native (`document` guard). Idempotent across multiple calls.
 */
import { Platform } from 'react-native'

const SHIMMER_KEYFRAMES_ID = 'message-queue-shimmer-keyframes'

export function installShimmerKeyframes(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return
  if (document.getElementById(SHIMMER_KEYFRAMES_ID)) return
  const style = document.createElement('style')
  style.id = SHIMMER_KEYFRAMES_ID
  style.textContent =
    '@keyframes message-queue-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }'
  document.head.appendChild(style)
}
