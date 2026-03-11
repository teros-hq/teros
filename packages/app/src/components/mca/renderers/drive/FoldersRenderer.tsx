/**
 * Google Drive - Folders Renderers
 *
 * Renderers for folder operations:
 * - create-folder
 */

import { ExternalLink, FolderPlus } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  DriveFile,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  FileRow,
  getShortToolName,
  HeaderRow,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Create Folder Renderer
// ============================================================================

interface CreateFolderResult {
  success?: boolean;
  id?: string;
  name?: string;
  webViewLink?: string;
  error?: string;
}

export function CreateFolderRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<CreateFolderResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const isSuccess = result?.id || result?.success;

  // Get folder name from input or result
  const inputParsed = typeof input === 'string' ? parseOutput<{ name?: string }>(input) : input;
  const folderName = result?.name || inputParsed?.name || 'folder';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && isSuccess) {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed' || (result && !isSuccess && result.error)) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Create folder: ${truncate(folderName, 20)}`
      : isSuccess
        ? `Create folder: ${truncate(folderName, 20)}`
        : 'Create folder';

  if (!expanded) {
    return (
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={false}
        onToggle={() => setExpanded(true)}
      />
    );
  }

  return (
    <ExpandedContainer>
      <HeaderRow
        status={status}
        description={description}
        duration={duration}
        badge={badge}
        expanded={true}
        onToggle={() => setExpanded(false)}
        isInContainer
      />
      <ExpandedBody>
        {(status === 'failed' || result?.error) && (
          <ErrorBlock error={result?.error || output || 'Failed to create folder'} />
        )}

        {status === 'completed' && isSuccess && (
          <YStack gap={4}>
            <SuccessBlock message={`Folder "${folderName}" created`} />

            {result?.webViewLink && (
              <XStack
                gap={4}
                alignItems="center"
                paddingLeft={8}
                pressStyle={{ opacity: 0.7 }}
                onPress={() => Linking.openURL(result.webViewLink!)}
                cursor="pointer"
              >
                <ExternalLink size={10} color={colors.driveBlue} />
                <Text color={colors.driveBlue} fontSize={9}>
                  Open in Drive
                </Text>
              </XStack>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
