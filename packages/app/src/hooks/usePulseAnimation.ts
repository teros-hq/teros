/**
 * usePulseAnimation — Centralised pulse/breathing animation hook
 *
 * Replaces 17+ duplicated inline Animated.Value pulse patterns across renderers
 * and other components.
 *
 * @param active  When true the animation runs; when false it stops and resets to 1.
 * @param options Optional overrides for timing and target opacity values.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

export interface PulseAnimationOptions {
  /** Minimum opacity value reached during the pulse (default: 0.3) */
  minOpacity?: number;
  /** Duration in ms for each half-cycle (default: 800) */
  duration?: number;
}

export function usePulseAnimation(
  active: boolean,
  options: PulseAnimationOptions = {},
): Animated.Value {
  const { minOpacity = 0.3, duration = 800 } = options;
  const anim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: minOpacity,
          duration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 1,
          duration,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    if (active) {
      pulse.start();
    } else {
      pulse.stop();
      anim.setValue(1);
    }

    return () => pulse.stop();
  }, [active, anim, minOpacity, duration]);

  return anim;
}
