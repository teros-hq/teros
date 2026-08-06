import {
  Archive,
  ArrowDownToLine,
  Ban,
  Check,
  Edit3,
  Link2,
  Link2Off,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  UserMinus,
  UserPlus,
} from './icons';
import type React from 'react';
import { Text, XStack } from 'tamagui';
import type { BadgePalette } from './colors';
import { useColors } from './useColors';

/**
 * Verbos canónicos de acción soportados. Cubren el catálogo de operaciones
 * CRUD + access control que se repite entre MCAs. Nuevos verbos se añaden a
 * la tabla `VERB_STYLE` de abajo; sin fallback silencioso — un verbo fuera
 * de la tabla se pinta como 'gray' con el texto literal.
 */
export type ActionVerb =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'archived'
  | 'renamed'
  | 'installed'
  | 'uninstalled'
  | 'granted'
  | 'revoked'
  | 'added'
  | 'removed'
  | 'enabled'
  | 'disabled';

interface ActionBadgeProps {
  verb: ActionVerb;
  size?: 'sm' | 'md';
}

type PaletteKey = 'ok' | 'err' | 'warn' | 'info' | 'gray';

interface VerbStyle {
  text: string;
  paletteKey: PaletteKey;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
}

const VERB_STYLE: Record<ActionVerb, VerbStyle> = {
  // positive (creation / link / enablement)
  created: { text: 'created', paletteKey: 'ok', Icon: Check },
  installed: { text: 'installed', paletteKey: 'ok', Icon: ArrowDownToLine },
  granted: { text: 'granted', paletteKey: 'ok', Icon: Link2 },
  added: { text: 'added', paletteKey: 'ok', Icon: UserPlus },
  enabled: { text: 'enabled', paletteKey: 'info', Icon: Power },

  // mutation
  updated: { text: 'updated', paletteKey: 'warn', Icon: Edit3 },
  renamed: { text: 'renamed', paletteKey: 'warn', Icon: Pencil },

  // destructive
  deleted: { text: 'deleted', paletteKey: 'err', Icon: Trash2 },
  uninstalled: { text: 'uninstalled', paletteKey: 'err', Icon: Ban },
  revoked: { text: 'revoked', paletteKey: 'err', Icon: Link2Off },
  removed: { text: 'removed', paletteKey: 'err', Icon: UserMinus },

  // inert / paused
  archived: { text: 'archived', paletteKey: 'gray', Icon: Archive },
  disabled: { text: 'disabled', paletteKey: 'gray', Icon: PowerOff },
};

/**
 * Badge semántica para el verbo de una acción ejecutada (create/update/
 * delete/grant/revoke/…). Combina icono + texto + color para codificar
 * triple la naturaleza de la acción:
 *   - color     → polaridad (verde=positiva, amber=mutación, rojo=destructiva, gris=inerte)
 *   - icono     → tipo específico (link, trash, power, pencil, …)
 *   - texto     → verbo literal
 *
 * Usage:
 *   <ActionBadge verb="created" />
 *   <ActionBadge verb="archived" size="md" />
 */
export function ActionBadge({ verb, size = 'sm' }: ActionBadgeProps) {
  const c = useColors();
  const style = VERB_STYLE[verb];
  const palette: BadgePalette[PaletteKey] = c.badges[style.paletteKey];
  const fontSize = size === 'md' ? 10 : 9;
  const padY = size === 'md' ? 2 : 1;
  const padX = size === 'md' ? 6 : 5;
  const iconSize = size === 'md' ? 11 : 9;
  const { Icon } = style;

  return (
    <XStack
      backgroundColor={palette.bg}
      paddingHorizontal={padX}
      paddingVertical={padY}
      borderRadius={3}
      alignItems="center"
      gap={4}
    >
      <Icon size={iconSize} color={palette.text} />
      <Text color={palette.text} fontSize={fontSize} fontFamily="$mono" textTransform="uppercase">
        {style.text}
      </Text>
    </XStack>
  );
}
