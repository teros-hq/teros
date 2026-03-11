/**
 * Google Drive - Files Renderers
 *
 * Renderers for file operations:
 * - list-files
 * - search-files
 * - get-file
 * - get-file-content
 * - download-file
 * - upload-file
 * - move-file
 * - copy-file
 * - delete-file
 */

import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Move,
  Search,
  Trash2,
  Upload,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  type DriveFile,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  FileRow,
  FileTypeBadge,
  formatDate,
  formatDuration,
  formatFileSize,
  getFileTypeInfo,
  getShortToolName,
  HeaderRow,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// List Files Renderer
// ============================================================================

interface ListFilesResult {
  files: DriveFile[];
}

export function ListFilesRenderer({ toolName, status, output, duration }: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const shortName = getShortToolName(toolName);

  const parsed = parseOutput<ListFilesResult>(output || '');
  const files = typeof parsed === 'object' && parsed?.files ? parsed.files : [];
  const count = files.length;

  // Determine badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={`${count} file${count !== 1 ? 's' : ''}`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = status === 'running' ? 'List files' : 'List files';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && files.length === 0 && (
          <Text color={colors.muted} fontSize={10}>
            No files found
          </Text>
        )}

        {status === 'completed' && files.length > 0 && (
          <YStack gap={4}>
            {files.slice(0, 10).map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
            {files.length > 10 && (
              <Text color={colors.muted} fontSize={9} textAlign="center">
                +{files.length - 10} more files
              </Text>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Get File Renderer
// ============================================================================

export function GetFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<DriveFile>(output || '');
  const file = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && file) {
    badge = <FileTypeBadge mimeType={file.mimeType} />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Get file'
      : file?.name
        ? `Get file: ${truncate(file.name, 25)}`
        : 'Get file';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && file && (
          <YStack gap={6}>
            <FileRow file={file} />

            <YStack gap={4} paddingLeft={8}>
              {file.size && (
                <XStack gap={8}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Size
                  </Text>
                  <Text color={colors.secondary} fontSize={9}>
                    {formatFileSize(file.size)}
                  </Text>
                </XStack>
              )}
              {file.createdTime && (
                <XStack gap={8}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Created
                  </Text>
                  <Text color={colors.secondary} fontSize={9}>
                    {formatDate(file.createdTime)}
                  </Text>
                </XStack>
              )}
              {file.modifiedTime && (
                <XStack gap={8}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Modified
                  </Text>
                  <Text color={colors.secondary} fontSize={9}>
                    {formatDate(file.modifiedTime)}
                  </Text>
                </XStack>
              )}
              {file.owners?.[0] && (
                <XStack gap={8}>
                  <Text color={colors.muted} fontSize={9} width={60}>
                    Owner
                  </Text>
                  <Text color={colors.secondary} fontSize={9}>
                    {file.owners[0].displayName || file.owners[0].emailAddress}
                  </Text>
                </XStack>
              )}
              {file.webViewLink && (
                <XStack
                  gap={4}
                  alignItems="center"
                  pressStyle={{ opacity: 0.7 }}
                  onPress={() => Linking.openURL(file.webViewLink!)}
                  cursor="pointer"
                >
                  <ExternalLink size={10} color={colors.driveBlue} />
                  <Text color={colors.driveBlue} fontSize={9}>
                    Open in Drive
                  </Text>
                </XStack>
              )}
            </YStack>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Download File Renderer
// ============================================================================

interface DownloadResult {
  success: boolean;
  path?: string;
  fileName?: string;
  size?: number;
  error?: string;
}

export function DownloadFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<DownloadResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result?.success) {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed' || (result && !result.success)) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Download file'
      : result?.fileName
        ? `Download: ${truncate(result.fileName, 20)}`
        : 'Download file';

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
        {(status === 'failed' || (result && !result.success)) && (
          <ErrorBlock error={result?.error || output || 'Download failed'} />
        )}

        {status === 'completed' && result?.success && (
          <YStack gap={4}>
            <SuccessBlock message={`Downloaded: ${result.fileName || 'file'}`} />
            {result.path && (
              <XStack gap={8} paddingLeft={8}>
                <Text color={colors.muted} fontSize={9}>
                  Path:
                </Text>
                <Text color={colors.secondary} fontSize={9} fontFamily="$mono">
                  {truncate(result.path, 40)}
                </Text>
              </XStack>
            )}
            {result.size && (
              <XStack gap={8} paddingLeft={8}>
                <Text color={colors.muted} fontSize={9}>
                  Size:
                </Text>
                <Text color={colors.secondary} fontSize={9}>
                  {formatFileSize(result.size)}
                </Text>
              </XStack>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Upload File Renderer
// ============================================================================

interface UploadResult {
  success: boolean;
  file?: DriveFile;
  error?: string;
}

export function UploadFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<UploadResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;

  // Description - get filename from input
  const inputParsed = typeof input === 'string' ? parseOutput<{ filePath?: string }>(input) : input;
  const fileName = inputParsed?.filePath?.split('/').pop() || 'file';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result?.success) {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed' || (result && !result.success)) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Upload: ${truncate(fileName, 20)}`
      : result?.file?.name
        ? `Upload: ${truncate(result.file.name, 20)}`
        : 'Upload file';

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
        {(status === 'failed' || (result && !result.success)) && (
          <ErrorBlock error={result?.error || output || 'Upload failed'} />
        )}

        {status === 'completed' && result?.success && result.file && (
          <YStack gap={4}>
            <SuccessBlock message="File uploaded successfully" />
            <FileRow file={result.file} />
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Delete File Renderer
// ============================================================================

interface DeleteResult {
  success: boolean;
  message?: string;
  error?: string;
}

export function DeleteFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<DeleteResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const isSuccess = result?.success || (typeof output === 'string' && output.includes('success'));

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && isSuccess) {
    badge = <Badge text="deleted" variant="warning" />;
  } else if (status === 'failed' || (result && !result.success)) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'Delete file';

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
        {(status === 'failed' || (result && !result.success)) && (
          <ErrorBlock error={result?.error || output || 'Delete failed'} />
        )}

        {status === 'completed' && isSuccess && (
          <SuccessBlock message={result?.message || 'File deleted successfully'} />
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Search Files Renderer
// ============================================================================

export function SearchFilesRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<ListFilesResult>(output || '');
  const files = typeof parsed === 'object' && parsed?.files ? parsed.files : [];
  const count = files.length;

  // Get search term from input
  const inputParsed =
    typeof input === 'string' ? parseOutput<{ searchTerm?: string }>(input) : input;
  const searchTerm = inputParsed?.searchTerm || '';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={`${count} result${count !== 1 ? 's' : ''}`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Search files'
      : searchTerm
        ? `Search: "${truncate(searchTerm, 20)}"`
        : 'Search files';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && files.length === 0 && (
          <Text color={colors.muted} fontSize={10}>
            No files found
          </Text>
        )}

        {status === 'completed' && files.length > 0 && (
          <YStack gap={4}>
            {files.slice(0, 10).map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
            {files.length > 10 && (
              <Text color={colors.muted} fontSize={9} textAlign="center">
                +{files.length - 10} more files
              </Text>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Move File Renderer
// ============================================================================

interface MoveResult {
  id: string;
  name: string;
  parents?: string[];
  webViewLink?: string;
}

export function MoveFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<MoveResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text="moved" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Move file'
      : result?.name
        ? `Move: ${truncate(result.name, 25)}`
        : 'Move file';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <SuccessBlock message={`File "${result.name}" moved successfully`} />
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Copy File Renderer
// ============================================================================

interface CopyResult {
  id: string;
  name: string;
  webViewLink?: string;
}

export function CopyFileRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<CopyResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text="copied" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Copy file'
      : result?.name
        ? `Copy: ${truncate(result.name, 25)}`
        : 'Copy file';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <SuccessBlock message={`Copy created: ${result.name}`} />
            {result.webViewLink && (
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
                  Open copy in Drive
                </Text>
              </XStack>
            )}
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

// ============================================================================
// Get File Content Renderer
// ============================================================================

interface FileContentResult {
  name: string;
  mimeType: string;
  content: string;
}

export function GetFileContentRenderer({
  toolName,
  status,
  output,
  duration,
  input,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = parseOutput<FileContentResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.content !== undefined ? parsed : null;
  const contentLength = result?.content?.length || 0;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    const sizeText =
      contentLength > 1000
        ? `${(contentLength / 1000).toFixed(1)}K chars`
        : `${contentLength} chars`;
    badge = <Badge text={sizeText} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? 'Get file content'
      : result?.name
        ? `Content: ${truncate(result.name, 20)}`
        : 'Get file content';

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
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <XStack gap={8} alignItems="center">
              <FileText size={12} color={colors.document} />
              <Text color={colors.primary} fontSize={10} fontWeight="500">
                {result.name}
              </Text>
            </XStack>

            <YStack backgroundColor={colors.bgInner} borderRadius={5} padding={8} maxHeight={150}>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text color={colors.secondary} fontSize={9} fontFamily="$mono" lineHeight={14}>
                  {truncate(result.content, 1000)}
                </Text>
              </ScrollView>
            </YStack>

            <Text color={colors.muted} fontSize={9}>
              {contentLength.toLocaleString()} characters
            </Text>
          </YStack>
        )}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
