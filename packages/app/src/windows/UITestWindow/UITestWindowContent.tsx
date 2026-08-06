/**
 * UI Test Window — Theme & Component Preview
 *
 * Shows all surface tokens, semantic colors, and tab variations
 * in both light and dark modes for visual testing.
 */

import { XCircle } from '@tamagui/lucide-icons';
import { Text, View, XStack, YStack } from 'tamagui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';
import { ConcaveCorner, TAB_RADIUS } from '../../components/workspace/ConcaveCorner';

/** Composite semi-transparent rgba over opaque hex → opaque hex */
function compositeOver(rgba: string, bg: string): string {
  const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/);
  if (!m) return rgba;
  const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
  const a = m[4] !== undefined ? Number(m[4]) : 1;
  if (a >= 1) return rgba;
  const bm = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!bm) return rgba;
  const br = parseInt(bm[1], 16), bg2 = parseInt(bm[2], 16), bb = parseInt(bm[3], 16);
  const rr = Math.round(r * a + br * (1 - a));
  const rg = Math.round(g * a + bg2 * (1 - a));
  const rb = Math.round(b * a + bb * (1 - a));
  return `#${rr.toString(16).padStart(2, '0')}${rg.toString(16).padStart(2, '0')}${rb.toString(16).padStart(2, '0')}`;
}

interface Props {
  windowId: string;
}

const MAX_TAB_WIDTH = 180;
const MIN_TAB_WIDTH = 60;

// ─── Tab preview (replicates TilingContainer tabs) ─────────────────────────
function TabPreview({
  label,
  isActive,
  isContainerActive = true,
  tabBarColor,
}: {
  label: string;
  isActive: boolean;
  isContainerActive?: boolean;
  tabBarColor?: string;
}) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const resolvedTabBar = tabBarColor ?? (isDark ? '#080809' : '#C8C8C8');

  // Composite semi-transparent tokens over the tab bar for opaque colors
  const activeBg = compositeOver(c.bgCard, resolvedTabBar)
  const activeBorder = compositeOver(c.borderStrong, resolvedTabBar)

  const TC = {
    active: {
      border: activeBorder,
      background: activeBg,
      tabText: c.text,
    },
    inactive: {
      border: isDark ? "#222" : "#B8B8B8",
      background: isDark ? "#0a0a0b" : "#D0D0D0",
      tabText: isDark ? c.text3 : "#5A5A5A",
    },
    inactiveTab: isDark ? "#0e0e10" : "#D0D0D0",
    inactiveTabText: isDark ? c.text3 : "#5A5A5A",
    inactiveTabHover: isDark ? "#151515" : "#D8D8D8",
    closeHover: isDark ? "#333" : "#D8D8D8",
    iconDim: c.text3,
    hoverBg: isDark ? "#1a1a1a" : "#D8D8D8",
  };

  const colors = isContainerActive ? TC.active : TC.inactive;

  if (isActive) {
    return (
      <XStack
        flex={1}
        maxWidth={MAX_TAB_WIDTH}
        minWidth={MIN_TAB_WIDTH}
        height={32}
        paddingHorizontal={10}
        paddingRight={4}
        gap={6}
        alignItems="center"
        backgroundColor={colors.background}
        borderTopLeftRadius={TAB_RADIUS}
        borderTopRightRadius={TAB_RADIUS}
        borderWidth={1}
        borderBottomWidth={0}
        borderColor={colors.border}
        marginLeft={4}
        marginRight={4}
        position="relative"
        top={1}
        zIndex={3}
      >
        <ConcaveCorner side="left" borderColor={colors.border} backgroundColor={colors.background} />
        <ConcaveCorner side="right" borderColor={colors.border} backgroundColor={colors.background} />
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semanticColors.indigo, flexShrink: 0 }} />
        <Text flex={1} fontSize={12} color={colors.tabText} numberOfLines={1}>
          {label}
        </Text>
        <XStack width={20} height={20} borderRadius={4} justifyContent="center" alignItems="center" opacity={0.5}>
          <XCircle size={12} color={TC.iconDim} />
        </XStack>
      </XStack>
    );
  }

  return (
    <XStack
      flex={1}
      maxWidth={MAX_TAB_WIDTH}
      minWidth={MIN_TAB_WIDTH}
      height={32}
      paddingHorizontal={10}
      paddingRight={4}
      gap={6}
      alignItems="center"
      backgroundColor={TC.inactiveTab}
      borderTopLeftRadius={TAB_RADIUS}
      borderTopRightRadius={TAB_RADIUS}
      hoverStyle={{ backgroundColor: TC.inactiveTabHover }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semanticColors.indigo, flexShrink: 0, opacity: 0.5 }} />
      <Text flex={1} fontSize={12} color={TC.inactiveTabText} numberOfLines={1}>
        {label}
      </Text>
      <XStack width={20} height={20} borderRadius={4} justifyContent="center" alignItems="center" opacity={0.3}>
        <XCircle size={12} color={TC.iconDim} />
      </XStack>
    </XStack>
  );
}

// ─── Tab bar preview ───────────────────────────────────────────────────────
function TabBarPreview({ tabBarColor }: { tabBarColor?: string }) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const resolvedTabBar = tabBarColor ?? (isDark ? '#080809' : '#C8C8C8');

  return (
    <YStack gap={8}>
      {/* Active container */}
      <YStack>
        <Text fontSize={10} color={c.text3} fontWeight="600" textTransform="uppercase" letterSpacing={0.5} marginBottom={4}>
          Active Container
        </Text>
        <XStack
          height={39}
          backgroundColor={tabBarColor}
          alignItems="flex-end"
          position="relative"
          zIndex={2}
        >
          <XStack flex={1} alignItems="flex-end">
            <TabPreview label="Chat — Alice" isActive={true} />
            <TabPreview label="Apps" isActive={false} />
            <TabPreview label="Board" isActive={false} />
            <TabPreview label="Profile" isActive={false} />
          </XStack>
        </XStack>
        {/* Content area below tabs */}
        <YStack
          flex={1}
          backgroundColor={c.bgCard}
          borderWidth={1}
          borderTopWidth={0}
          borderColor={c.borderStrong}
          padding={12}
          minHeight={60}
        >
          <Text fontSize={12} color={c.text2}>Content area (c.bgCard)</Text>
        </YStack>
      </YStack>

      {/* Inactive container */}
      <YStack>
        <Text fontSize={10} color={c.text3} fontWeight="600" textTransform="uppercase" letterSpacing={0.5} marginBottom={4}>
          Inactive Container
        </Text>
        <XStack
          height={39}
          backgroundColor={tabBarColor}
          alignItems="flex-end"
        >
          <XStack flex={1} alignItems="flex-end">
            <TabPreview label="Chat — Nira" isActive={true} isContainerActive={false} />
            <TabPreview label="MCA Status" isActive={false} isContainerActive={false} />
            <TabPreview label="Files" isActive={false} isContainerActive={false} />
          </XStack>
        </XStack>
      </YStack>

      {/* Single tab (min width scenario) */}
      <YStack>
        <Text fontSize={10} color={c.text3} fontWeight="600" textTransform="uppercase" letterSpacing={0.5} marginBottom={4}>
          Single Tab
        </Text>
        <XStack
          height={39}
          backgroundColor={tabBarColor}
          alignItems="flex-end"
        >
          <XStack flex={1} alignItems="flex-end">
            <TabPreview label="Only Window" isActive={true} />
          </XStack>
        </XStack>
      </YStack>

      {/* Many tabs (overflow scenario) */}
      <YStack>
        <Text fontSize={10} color={c.text3} fontWeight="600" textTransform="uppercase" letterSpacing={0.5} marginBottom={4}>
          Many Tabs (flex shrink)
        </Text>
        <XStack
          height={39}
          backgroundColor={tabBarColor}
          alignItems="flex-end"
        >
          <XStack flex={1} alignItems="flex-end">
            <TabPreview label="Chat" isActive={true} />
            <TabPreview label="Apps" isActive={false} />
            <TabPreview label="Board" isActive={false} />
            <TabPreview label="Profile" isActive={false} />
            <TabPreview label="Providers" isActive={false} />
            <TabPreview label="Skills" isActive={false} />
            <TabPreview label="MCA" isActive={false} />
            <TabPreview label="Catalog" isActive={false} />
          </XStack>
        </XStack>
      </YStack>
    </YStack>
  );
}

// ─── Token swatches ────────────────────────────────────────────────────────
function Swatch({ name, value }: { name: string; value: string }) {
  const c = useColors();
  return (
    <XStack alignItems="center" gap={8}>
      <View style={{ width: 32, height: 32, borderRadius: 6, backgroundColor: value, borderWidth: 1, borderColor: 'rgba(128,128,128,0.2)' }} />
      <YStack>
        <Text fontSize={11} color={c.text} fontWeight="500">{name}</Text>
        <Text fontSize={10} color={c.text3}>{value}</Text>
      </YStack>
    </XStack>
  );
}

// ─── Main component ────────────────────────────────────────────────────────
export function UITestWindowContent({ windowId: _windowId }: Props) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const tabBarColor = isDark ? "#080809" : "#C8C8C8";

  return (
    <YStack flex={1} backgroundColor={c.bgPage} overflow="scroll">
      <YStack padding={20} gap={24} maxWidth={800} alignSelf="center" width="100%">

        {/* Header */}
        <YStack gap={4}>
          <Text fontSize={20} fontWeight="700" color={c.text}>
            UI Test — Theme Preview
          </Text>
          <Text fontSize={13} color={c.text3}>
            Mode: {isDark ? 'dark' : 'light'} · Testing tabs, tokens & colors
          </Text>
        </YStack>

        {/* ─── Tab previews ─── */}
        <YStack gap={16}>
          <Text fontSize={14} fontWeight="600" color={c.text}>
            Tab Bar
          </Text>
          <TabBarPreview />
        </YStack>

        {/* ─── Surface tokens ─── */}
        <YStack gap={12}>
          <Text fontSize={14} fontWeight="600" color={c.text}>
            Surface Tokens ({isDark ? 'dark' : 'light'})
          </Text>
          <YStack gap={8} padding={16} backgroundColor={c.bgCard} borderRadius={12} borderWidth={1} borderColor={c.border}>
            <Swatch name="bgPage" value={c.bgPage} />
            <Swatch name="bgCard" value={c.bgCard} />
            <Swatch name="bgCardHover" value={c.bgCardHover} />
            <Swatch name="bgInner" value={c.bgInner} />
            <Swatch name="border" value={c.border} />
            <Swatch name="borderStrong" value={c.borderStrong} />
            <Swatch name="text" value={c.text} />
            <Swatch name="text2" value={c.text2} />
            <Swatch name="text3" value={c.text3} />
            <Swatch name="shadow" value={c.shadow} />
            <Swatch name="shadowSm" value={c.shadowSm} />
          </YStack>
        </YStack>

        {/* ─── Semantic colors ─── */}
        <YStack gap={12}>
          <Text fontSize={14} fontWeight="600" color={c.text}>
            Semantic Colors
          </Text>
          <YStack gap={8} padding={16} backgroundColor={c.bgCard} borderRadius={12} borderWidth={1} borderColor={c.border}>
            <Swatch name="indigo" value={semanticColors.indigo} />
            <Swatch name="indigoDark" value={semanticColors.indigoDark} />
            <Swatch name="indigoGlow" value={semanticColors.indigoGlow} />
            <Swatch name="indigoLight" value={semanticColors.indigoLight} />
            <Swatch name="red" value={semanticColors.red} />
            <Swatch name="amber" value={semanticColors.amber} />
            <Swatch name="violet" value={semanticColors.violet} />
            <Swatch name="green" value={semanticColors.green} />
          </YStack>
        </YStack>

        {/* ─── Text on backgrounds ─── */}
        <YStack gap={12}>
          <Text fontSize={14} fontWeight="600" color={c.text}>
            Text on Backgrounds
          </Text>
          <YStack gap={4}>
            <XStack padding={12} backgroundColor={c.bgCard} borderRadius={8} alignItems="center" gap={12}>
              <Text fontSize={14} color={c.text}>c.text on c.bgCard</Text>
              <Text fontSize={12} color={c.text2}>c.text2</Text>
              <Text fontSize={11} color={c.text3}>c.text3</Text>
            </XStack>
            <XStack padding={12} backgroundColor={c.bgInner} borderRadius={8} alignItems="center" gap={12}>
              <Text fontSize={14} color={c.text}>c.text on c.bgInner</Text>
              <Text fontSize={12} color={c.text2}>c.text2</Text>
              <Text fontSize={11} color={c.text3}>c.text3</Text>
            </XStack>
            <XStack padding={12} backgroundColor={semanticColors.indigoDark} borderRadius={8} alignItems="center" gap={12}>
              <Text fontSize={14} color="#FFFFFF">white on indigoDark</Text>
              <Text fontSize={12} color="rgba(255,255,255,0.7)">white 70%</Text>
              <Text fontSize={11} color="rgba(255,255,255,0.5)">white 50%</Text>
            </XStack>
            <XStack padding={12} backgroundColor={semanticColors.indigoGlow} borderRadius={8} alignItems="center" gap={12}>
              <Text fontSize={14} color={c.text}>c.text on indigoGlow</Text>
              <Text fontSize={12} color={c.text2}>c.text2</Text>
              <Text fontSize={11} color={c.text3}>c.text3</Text>
            </XStack>
          </YStack>
        </YStack>

        {/* ─── Borders ─── */}
        <YStack gap={12}>
          <Text fontSize={14} fontWeight="600" color={c.text}>
            Borders
          </Text>
          <YStack gap={4}>
            <YStack padding={12} borderWidth={1} borderColor={c.border} borderRadius={8}>
              <Text fontSize={12} color={c.text2}>border: c.border ({c.border})</Text>
            </YStack>
            <YStack padding={12} borderWidth={1} borderColor={c.borderStrong} borderRadius={8}>
              <Text fontSize={12} color={c.text2}>border: c.borderStrong ({c.borderStrong})</Text>
            </YStack>
          </YStack>
        </YStack>

      </YStack>
    </YStack>
  );
}
