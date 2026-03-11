import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

interface TerosLogoProps {
  size?: number;
  color?: string;
  animated?: boolean;
}

interface Particle {
  id: number;
  from: number;
  to: number;
  progress: number;
}

export function TerosLogo({ size = 32, color = '#06B6D4', animated = true }: TerosLogoProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const [pulsingPoints, setPulsingPoints] = useState<Set<number>>(new Set());

  // Add padding so circles aren't cut off
  const padding = size * 0.15;
  const innerSize = size - padding * 2;

  // Coordinates of the 6 hexagon points (centered with padding)
  const points = [
    { x: size / 2, y: padding }, // Top
    { x: size - padding - innerSize * 0.067, y: padding + innerSize * 0.25 }, // Top Right
    { x: size - padding - innerSize * 0.067, y: padding + innerSize * 0.75 }, // Bottom Right
    { x: size / 2, y: size - padding }, // Bottom
    { x: padding + innerSize * 0.067, y: padding + innerSize * 0.75 }, // Bottom Left
    { x: padding + innerSize * 0.067, y: padding + innerSize * 0.25 }, // Top Left
  ];

  useEffect(() => {
    if (!animated) return;

    const interval = setInterval(() => {
      // Create fewer particles (higher threshold)
      if (Math.random() > 0.85) {
        const from = Math.floor(Math.random() * 6);
        const to = (from + Math.floor(Math.random() * 5) + 1) % 6;

        // Add pulse to origin point
        setPulsingPoints((prev) => new Set(prev).add(from));
        setTimeout(() => {
          setPulsingPoints((prev) => {
            const newSet = new Set(prev);
            newSet.delete(from);
            return newSet;
          });
        }, 300);

        setParticles((prev) => [
          ...prev.filter((p) => p.progress < 1),
          { id: Date.now() + Math.random(), from, to, progress: 0 },
        ]);
      }

      // Update progress (original speed)
      setParticles((prev) =>
        prev.map((p) => ({ ...p, progress: p.progress + 0.03 })).filter((p) => p.progress <= 1),
      );
    }, 50);

    return () => clearInterval(interval);
  }, [animated]);

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Connection lines (very subtle) */}
        {animated &&
          points.map((point, i) => {
            const nextPoint = points[(i + 1) % 6];
            return (
              <Line
                key={`line-${i}`}
                x1={point.x}
                y1={point.y}
                x2={nextPoint.x}
                y2={nextPoint.y}
                stroke={color}
                strokeWidth="0.5"
                opacity="0.15"
              />
            );
          })}

        {/* Hexagon points */}
        {points.map((point, i) => {
          const isPulsing = animated && pulsingPoints.has(i);
          const radius = size * 0.07 * (isPulsing ? 1.2 : 1);
          return (
            <Circle
              key={i}
              cx={point.x}
              cy={point.y}
              r={radius}
              fill={color}
              opacity={isPulsing ? 1 : 0.9}
            />
          );
        })}

        {/* Traveling particles */}
        {animated &&
          particles.map((particle) => {
            const fromPoint = points[particle.from];
            const toPoint = points[particle.to];

            // Easing function (ease-in-out)
            const easeProgress =
              particle.progress < 0.5
                ? 2 * particle.progress * particle.progress
                : 1 - (-2 * particle.progress + 2) ** 2 / 2;

            const x = fromPoint.x + (toPoint.x - fromPoint.x) * easeProgress;
            const y = fromPoint.y + (toPoint.y - fromPoint.y) * easeProgress;

            // Fade in/fade out
            const opacity = 1 - Math.abs(particle.progress - 0.5) * 2;

            return (
              <Circle
                key={particle.id}
                cx={x}
                cy={y}
                r={size * 0.014}
                fill={color}
                opacity={opacity}
              />
            );
          })}
      </Svg>
    </View>
  );
}
