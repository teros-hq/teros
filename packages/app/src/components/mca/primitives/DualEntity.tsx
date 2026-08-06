import {
  ArrowRightLeft,
  Link2,
  Link2Off,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  UserMinus,
  UserPlus,
} from './icons';
import type React from 'react';
import { Text, XStack, YStack } from 'tamagui';
import { colors } from './colors';
import { useColors } from './useColors';

export type DualAction =
  | 'grant' // add access (agent ↔ resource)
  | 'revoke' // remove access
  | 'add-member' // workspace member joins
  | 'remove-member' // workspace member leaves
  | 'role-change' // update member role
  | 'transfer' // ownership / scope change
  | 'enable' // skill enabled on agent
  | 'disable'; // skill disabled on agent

interface EntitySlot {
  /** Slot visual (Avatar, IconTile, …). */
  visual: React.ReactNode;
  /** Nombre humano del recurso. */
  title: string;
  /** Subtítulo corto (rol, id truncado, categoría…). */
  subtitle?: string;
}

interface DualEntityProps {
  /** Entidad sujeto (habitualmente el agente o el user). */
  left: EntitySlot;
  /** Entidad objeto (app, skill, workspace afectado). */
  right: EntitySlot;
  /** Tipo de acción — determina icono y color del conector. */
  action: DualAction;
  /** Texto opcional bajo el conector (p.ej. role after change). */
  meta?: string;
}

interface ActionVisual {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  color: string;
  connectorStyle: 'solid' | 'dashed' | 'dotted';
}

/**
 * Visuales por acción. Los colores son semantic theme-agnostic (green/red/
 * amber/indigo/orange) — la guía §5 dice que el color semántico es el
 * mismo en light y dark.
 *
 * El único color que necesita ser theme-aware es `disable` (gris muted),
 * que se inyecta dinámicamente desde `useColors()` en el componente.
 */
const ACTION_VISUAL: Record<Exclude<DualAction, 'disable'>, ActionVisual> = {
  grant: { Icon: Link2, color: colors.green, connectorStyle: 'solid' },
  revoke: { Icon: Link2Off, color: colors.red, connectorStyle: 'dashed' },
  'add-member': { Icon: UserPlus, color: colors.green, connectorStyle: 'solid' },
  'remove-member': { Icon: UserMinus, color: colors.red, connectorStyle: 'dashed' },
  'role-change': { Icon: ShieldCheck, color: colors.amber, connectorStyle: 'dotted' },
  transfer: { Icon: ArrowRightLeft, color: colors.indigo, connectorStyle: 'dotted' },
  enable: { Icon: ToggleRight, color: colors.green, connectorStyle: 'solid' },
};

/**
 * Primitivo para operaciones que involucran 2 entidades relacionadas:
 * grant/revoke access, member add/remove, role-change, transfer, toggle.
 *
 * Layout:
 *   [visual + title/subtitle]  ──────◯──────  [visual + title/subtitle]
 *                                    meta
 *
 * El conector central (icono + línea a ambos lados) codifica la naturaleza
 * de la acción mediante icono + color + estilo de línea (solid/dashed/
 * dotted). Polaridad visual:
 *   - verde sólido        = conexión creada (grant/add/enable)
 *   - rojo dashed         = conexión rota (revoke/remove/disable)
 *   - amber/info dotted   = cambio no destructivo (role-change/transfer)
 *
 * El primitivo NO intenta inferir la acción del tool name — el renderer
 * padre pasa `action` explícitamente. Mantiene el primitivo puro y
 * testeable.
 */
export function DualEntity({ left, right, action, meta }: DualEntityProps): React.ReactNode {
  const c = useColors();
  const visual: ActionVisual =
    action === 'disable'
      ? { Icon: ToggleLeft, color: c.text3, connectorStyle: 'dashed' }
      : ACTION_VISUAL[action];

  // Grid de 3 columnas con proporciones fijas (42% / 16% / 42%). Garantiza
  // que el conector central queda SIEMPRE en la misma coordenada horizontal
  // entre tool cards, independientemente de la longitud del texto de cada
  // entidad. El overflow del texto se resuelve con numberOfLines={1} dentro
  // de cada EntityHalf.
  return (
    <XStack
      alignItems="center"
      paddingHorizontal={10}
      paddingVertical={10}
      backgroundColor={c.bgInner}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
    >
      <XStack width="42%" justifyContent="flex-start">
        <EntityHalf slot={left} align="left" />
      </XStack>
      <XStack width="16%" justifyContent="center">
        <Connector visual={visual} meta={meta} />
      </XStack>
      <XStack width="42%" justifyContent="flex-end">
        <EntityHalf slot={right} align="right" />
      </XStack>
    </XStack>
  );
}

/**
 * Conector visual: línea izquierda + icono circular + línea derecha + meta.
 * La línea es continua con opacidad proporcional a la polaridad (solid =
 * plena, dashed = atenuada, dotted = muy atenuada) — preferimos una línea
 * limpia sobre el `border-style: dashed/dotted` nativo porque éste se
 * renderiza inconsistente entre plataformas y con guiones demasiado largos.
 */
function Connector({ visual, meta }: { visual: ActionVisual; meta?: string }) {
  const c = useColors();
  const { Icon, color } = visual;
  const lineOpacity =
    visual.connectorStyle === 'solid' ? 0.6 : visual.connectorStyle === 'dashed' ? 0.35 : 0.2;
  return (
    <YStack alignItems="center" gap={3}>
      <XStack alignItems="center" gap={0}>
        <ConnectorLine color={color} opacity={lineOpacity} />
        <XStack
          width={30}
          height={30}
          borderRadius={15}
          backgroundColor={`${color}26`}
          alignItems="center"
          justifyContent="center"
          shadowColor={color}
          shadowOpacity={0.4}
          shadowRadius={8}
          shadowOffset={{ width: 0, height: 0 }}
        >
          <Icon size={16} color={color} />
        </XStack>
        <ConnectorLine color={color} opacity={lineOpacity} />
      </XStack>
      {meta && (
        <Text color={c.text2} fontSize={9} fontFamily="$mono" numberOfLines={1}>
          {meta}
        </Text>
      )}
    </YStack>
  );
}

function ConnectorLine({ color, opacity }: { color: string; opacity: number }) {
  return (
    <XStack
      width={18}
      height={0}
      borderBottomWidth={1.5}
      borderBottomColor={color}
      opacity={opacity}
    />
  );
}

function EntityHalf({ slot, align = 'left' }: { slot: EntitySlot; align?: 'left' | 'right' }) {
  const c = useColors();
  return (
    <XStack
      flex={1}
      gap={8}
      alignItems="center"
      justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}
      minWidth={0}
    >
      {align === 'left' && slot.visual}
      <YStack flex={1} gap={2} alignItems={align === 'right' ? 'flex-end' : 'flex-start'} minWidth={0}>
        <Text
          color={c.text}
          fontSize={11}
          fontWeight="600"
          numberOfLines={1}
          textAlign={align === 'right' ? 'right' : 'left'}
        >
          {slot.title}
        </Text>
        {slot.subtitle && (
          <Text
            color={c.text2}
            fontSize={9}
            fontFamily="$mono"
            numberOfLines={1}
            textAlign={align === 'right' ? 'right' : 'left'}
          >
            {slot.subtitle}
          </Text>
        )}
      </YStack>
      {align === 'right' && slot.visual}
    </XStack>
  );
}

/**
 * Derivación sugerida verb → action para renderers que quieran acoplar la
 * ActionBadge y el DualEntity a partir del mismo tool name sin mantener dos
 * tablas. Exportado aparte para no forzar a los consumidores a usarlo.
 */
export function dualActionForVerb(
  verb: 'granted' | 'revoked' | 'added' | 'removed' | 'enabled' | 'disabled' | 'updated',
): DualAction {
  if (verb === 'granted') return 'grant';
  if (verb === 'revoked') return 'revoke';
  if (verb === 'added') return 'add-member';
  if (verb === 'removed') return 'remove-member';
  if (verb === 'enabled') return 'enable';
  if (verb === 'disabled') return 'disable';
  return 'role-change';
}
