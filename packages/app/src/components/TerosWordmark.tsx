/**
 * TerosWordmark — the prototype's `logo-full`: the six-dot mark plus the
 * "Teros" wordmark as ONE vector (viewBox 101 × 28). The sidebar brand shows
 * it 18px tall (`html .brand-home .logo-full { height: 18px }`), so the
 * wordmark is drawn, not typeset — it scales with the mark and never
 * depends on a loaded font.
 */
import React from "react"
import Svg, { Circle, Path } from "react-native-svg"
import { colors } from "./mca/primitives/colors"

const VIEW_W = 101
const VIEW_H = 28
const R = 2.72395
const DOTS: [number, number][] = [
  [12.4886, 2.72395],
  [22.2537, 8.36197],
  [22.2537, 19.638],
  [12.4886, 25.276],
  [2.72395, 19.638],
  [2.72395, 8.36197],
]
const WORD = [
  "M94.9458 24.2148C91.4428 24.2148 89.1728 22.0289 89.0327 19.2546H91.1906C91.3027 20.8799 92.6758 22.2812 94.9458 22.2812C96.8794 22.2812 98.1685 21.2443 98.1685 19.9832C98.1685 18.666 97.2438 18.0495 95.9266 17.7132L93.2924 17.0126C91.3587 16.5082 89.6773 15.5834 89.6773 13.1453C89.6773 10.8753 91.695 9.22192 94.6375 9.22192C97.6081 9.22192 99.7379 10.9034 100.13 13.5096H97.9444C97.7482 12.0524 96.4311 11.0995 94.6375 11.0995C92.9841 11.0995 91.8912 11.8842 91.8912 13.1453C91.8912 14.1261 92.6478 14.7707 93.8528 15.079L96.4871 15.7515C98.5889 16.284 100.41 17.0967 100.41 19.9832C100.41 22.5053 98.2246 24.2148 94.9458 24.2148Z",
  "M80.2273 24.2148C76.0797 24.2148 73.1372 21.0761 73.1372 16.7044C73.1372 12.3606 76.0797 9.22192 80.2273 9.22192C84.3468 9.22192 87.3454 12.3326 87.3454 16.7044C87.3454 21.1041 84.3468 24.2148 80.2273 24.2148ZM80.2273 22.2812C83.1138 22.2812 85.1315 19.9552 85.1315 16.7044C85.1315 13.4536 83.0857 11.1556 80.2273 11.1556C77.3128 11.1556 75.3791 13.4816 75.3791 16.7044C75.3791 19.9552 77.3128 22.2812 80.2273 22.2812Z",
  "M72.7463 11.3798C72.438 11.2957 71.9336 11.1836 71.233 11.1836C68.879 11.1836 66.8893 13.5657 66.8893 18.4138V23.9906H64.7314V9.44612H66.8893V12.4447C67.5899 10.5951 69.5516 9.22192 71.4852 9.22192C72.1578 9.22192 72.4661 9.27797 72.7463 9.33402V11.3798Z",
  "M50.5843 16.9846C50.6964 20.3195 52.602 22.3092 55.4044 22.3092C57.5343 22.3092 59.3278 21.2723 59.6641 19.3947H61.7379C61.2054 22.5614 58.5992 24.2148 55.4044 24.2148C51.1168 24.2148 48.3984 20.936 48.3984 16.7044C48.3984 12.5007 51.0607 9.22192 55.3484 9.22192C59.3558 9.22192 61.878 12.1645 61.85 16.0038C61.85 16.4521 61.7939 16.8445 61.7939 16.9846H50.5843ZM55.3484 11.0715C52.8543 11.0715 51.1728 12.6689 50.7244 15.163H59.552C59.3839 12.809 57.8986 11.0715 55.3484 11.0715Z",
  "M41.722 23.9906V5.85897H35.1924V3.78519H50.4935V5.85897H44.0199V23.9906H41.722Z",
]

interface TerosWordmarkProps {
  /** Rendered height in px; the width follows the 101:28 box. */
  height?: number
  /** Wordmark colour (`currentColor` in the prototype — the text colour). */
  color: string
  /** Dot colour; Purple/300 in both themes. */
  dots?: string
}

export function TerosWordmark({ height = 18, color, dots = colors.purple300 }: TerosWordmarkProps) {
  const width = (height * VIEW_W) / VIEW_H
  return (
    <Svg
      width={width}
      height={height}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      accessibilityLabel="Teros"
      role="img"
    >
      {DOTS.map(([cx, cy]) => (
        <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={R} fill={dots} />
      ))}
      {WORD.map((d) => (
        <Path key={d.slice(0, 12)} d={d} fill={color} />
      ))}
    </Svg>
  )
}
