import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

interface TerosLoadingProps {
  size?: number;
  color?: string;
}

export function TerosLoading({ size = 24, color = '#164E63' }: TerosLoadingProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  // Coordinates of the 6 hexagon points
  const padding = size * 0.15;
  const innerSize = size - padding * 2;

  const points = [
    { x: size / 2, y: padding }, // Top
    { x: size - padding - innerSize * 0.067, y: padding + innerSize * 0.25 }, // Top Right
    { x: size - padding - innerSize * 0.067, y: padding + innerSize * 0.75 }, // Bottom Right
    { x: size / 2, y: size - padding }, // Bottom
    { x: padding + innerSize * 0.067, y: padding + innerSize * 0.75 }, // Bottom Left
    { x: padding + innerSize * 0.067, y: padding + innerSize * 0.25 }, // Top Left
  ];

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % 6);
    }, 150);

    return () => clearInterval(interval);
  }, []);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {points.map((point, i) => {
          // Calculate distance from active index (wrapping around)
          const distance = Math.min(Math.abs(i - activeIndex), 6 - Math.abs(i - activeIndex));

          // Opacity based on distance: active = 1, neighbors = 0.6, others = 0.3
          const opacity = distance === 0 ? 1 : distance === 1 ? 0.6 : 0.3;
          const radius = size * 0.08 * (distance === 0 ? 1.2 : 1);

          return (
            <Circle key={i} cx={point.x} cy={point.y} r={radius} fill={color} opacity={opacity} />
          );
        })}
      </Svg>
    </View>
  );
}
