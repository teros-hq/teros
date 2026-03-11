/**
 * Invitations Window Content
 *
 * Manage the invitation system:
 * - View invitation status and requirements
 * - Send invitations to other users
 * - View sent invitations history
 * - See available users to invite
 */

import React, { useCallback } from 'react';
import { YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { InvitationsPanel } from '../../components/InvitationsPanel';
import { useTilingStore } from '../../store/tilingStore';
import type { InvitationsTab } from './definition';

export interface InvitationsWindowContentProps {
  windowId: string;
  tab?: InvitationsTab;
}

export function InvitationsWindowContent({ windowId, tab }: InvitationsWindowContentProps) {
  const client = getTerosClient();
  const updateWindowProps = useTilingStore((state) => state.updateWindowProps);

  const handleTabChange = useCallback(
    (newTab: InvitationsTab) => {
      updateWindowProps(windowId, { tab: newTab });
    },
    [windowId, updateWindowProps],
  );

  return (
    <YStack flex={1} backgroundColor="$background">
      <InvitationsPanel client={client} initialTab={tab} onTabChange={handleTabChange} />
    </YStack>
  );
}
