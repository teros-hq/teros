/**
 * Provider Icons
 *
 * SVG icons for each LLM provider type.
 * All icons are rendered in the standard provider green (#22c55e) by default.
 *
 * Sources:
 *   anthropic-oauth   — Claude logo (inline SVG, simpleicons.org/anthropic)
 *   openai-codex-oauth — OpenAI logo (inline SVG, simpleicons.org/openai)
 *   openrouter        — OpenRouter logo (inline SVG, simpleicons.org/openrouter)
 *   ollama            — Ollama logo (Image, https://be.teros.ai/static/logo-b26b34b9-83b.svg)
 *   google            — Gemini logo (inline SVG, simpleicons.org/googlegemini)
 *   zhipu-coding      — Z.ai logo (img, https://upload.wikimedia.org/wikipedia/commons/f/f4/Z.ai_%28company_logo%29.svg)
 */

import React from 'react'
import { Image } from 'react-native'

// Shared CSS filter to tint external SVG images to the provider green (#22c55e)
const GREEN_FILTER =
  'brightness(0) saturate(100%) invert(74%) sepia(56%) saturate(450%) hue-rotate(93deg) brightness(95%) contrast(90%)'

// ─── Individual icons ─────────────────────────────────────────────────────────

function ClaudeIcon({ size = 13, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1200" fill={color}>
      <path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 Z" />
    </svg>
  )
}

function OpenAIIcon({ size = 13, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}

function OpenRouterIcon({ size = 13, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z" />
    </svg>
  )
}

function OllamaIcon({ size = 13 }: { size?: number; color?: string }) {
  // Source: https://be.teros.ai/static/logo-b26b34b9-83b.svg
  return (
    <Image
      source={{ uri: 'https://be.teros.ai/static/logo-b26b34b9-83b.svg' }}
      style={{ width: size, height: size, tintColor: '#22c55e' } as any}
    />
  )
}

function TerosIcon({ size = 13, color = '#22c55e' }: { size?: number; color?: string }) {
  // Teros "T" logomark — geometric, minimal
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="7" fill={color} fillOpacity="0.15" />
      <rect x="6" y="8" width="20" height="3.5" rx="1.75" fill={color} />
      <rect x="14.25" y="8" width="3.5" height="16" rx="1.75" fill={color} />
    </svg>
  )
}

function GeminiIcon({ size = 13, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  )
}

function CloudflareIcon({ size = 13, color = '#F48120' }: { size?: number; color?: string }) {
  // Cloudflare-style geometric cloud icon
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="7" fill={color} fillOpacity="0.15" />
      <path
        d="M16 8c-3.5 0-6.5 2.3-7.5 5.5-.1.3-.3.5-.6.5h-.4C5.2 14 4 15.2 4 16.7c0 1.5 1.2 2.7 2.7 2.7h16.6c2.1 0 3.7-1.7 3.7-3.7 0-2-1.6-3.6-3.5-3.7-.3 0-.5-.2-.6-.5C22.5 10.3 19.5 8 16 8z"
        fill={color}
      />
      <circle cx="22" cy="12" r="2.5" fill={color} fillOpacity="0.6" />
    </svg>
  )
}

function FireworksIcon({ size = 13, color = '#E11D48' }: { size?: number; color?: string }) {
  // Fireworks AI — stylized spark/burst icon
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2L13.5 8.5L20 7L15 11L20 15L13.5 13.5L12 20L10.5 13.5L4 15L9 11L4 7L10.5 8.5L12 2Z"
        fill={color}
      />
    </svg>
  )
}

function TogetherIcon({ size = 13, color = '#0F6FFF' }: { size?: number; color?: string }) {
  // Together AI — 2x2 grid of rounded squares, one highlighted (brand mark)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="9" height="9" rx="4.5" fill={color} fillOpacity="0.35" />
      <rect x="13" y="2" width="9" height="9" rx="4.5" fill={color} fillOpacity="0.35" />
      <rect x="2" y="13" width="9" height="9" rx="4.5" fill={color} fillOpacity="0.35" />
      <rect x="13" y="13" width="9" height="9" rx="4.5" fill={color} />
    </svg>
  )
}

function ZhipuIcon({ size = 13, color = '#22c55e' }: { size?: number; color?: string }) {
  // Source: https://upload.wikimedia.org/wikipedia/commons/f/f4/Z.ai_%28company_logo%29.svg
  // Inline SVG: rounded rect in provider color, Z shape cut out (transparent) via SVG mask.
  const id = 'zhipu-mask'
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id={id}>
          {/* White = visible, black = cut out */}
          <rect x="1.49" y="1.49" width="27.02" height="27.02" rx="4" fill="white" />
          <path d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z" fill="black" />
          <polygon points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1" fill="black" />
          <path d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z" fill="black" />
        </mask>
      </defs>
      <rect x="1.49" y="1.49" width="27.02" height="27.02" rx="4" fill={color} mask={`url(#${id})`} />
    </svg>
  )
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Maps providerType strings (from DB) to their icon component.
 * Add new providers here as they are onboarded.
 */
const PROVIDER_ICON_MAP: Record<string, React.FC<{ size?: number; color?: string }>> = {
  'anthropic-oauth': ClaudeIcon,
  anthropic: ClaudeIcon,
  'openai-codex-oauth': OpenAIIcon,
  openai: OpenAIIcon,
  openrouter: OpenRouterIcon,
  ollama: OllamaIcon,
  'ollama-cloud': OllamaIcon,
  google: GeminiIcon,
  'google-gemini': GeminiIcon,
  'zhipu-coding': ZhipuIcon,
  zhipu: ZhipuIcon,
  zhipuai: ZhipuIcon,
  teros: TerosIcon,
  cloudflare: CloudflareIcon,
  fireworks: FireworksIcon,
  together: TogetherIcon,
}

// ─── Public component ─────────────────────────────────────────────────────────

export function ProviderIcon({
  providerType,
  size = 13,
  color = '#22c55e',
}: {
  providerType: string
  size?: number
  color?: string
}) {
  const Icon = PROVIDER_ICON_MAP[providerType]
  if (!Icon) return null
  return <Icon size={size} color={color} />
}
