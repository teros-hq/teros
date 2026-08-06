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
} from '../../primitives';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
  countBadgeVariant,
  Empty,
  ErrorBlock,
  formatCountBadge,
  SuccessBlock,
  ToolCallCard,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useDriveColors,
  type DriveFile,
  FileRow,
  FileTypeBadge,
  formatDate,
  formatDuration,
  formatFileSize,
  getFileTypeInfo,
  getShortToolName,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// List Files Renderer
// ============================================================================

interface ListFilesResult {
  files: DriveFile[];
}

export function ListFilesRenderer({ toolName, status, output, appIcon }: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const shortName = getShortToolName(toolName);

  const parsed = parseOutput<ListFilesResult>(output || '');
  const files = typeof parsed === 'object' && parsed?.files ? parsed.files : [];
  const count = files.length;

  // Determine badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = (
      <Badge text={formatCountBadge(count, 'file')} variant={countBadgeVariant(count)} />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} verb="List files" badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && files.length === 0 && (
          <Empty message="No files found" hint="Try a different folder or filter" />
        )}

        {status === 'completed' && files.length > 0 && (
          <YStack gap={4}>
            {files.slice(0, 10).map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
            {files.length > 10 && (
              <Text color={c.text3} fontSize={9} textAlign="center">
                +{files.length - 10} more files
              </Text>
            )}
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Get File Renderer
// ============================================================================

export function GetFileRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && file && (
          <YStack gap={6}>
            <FileRow file={file} />

            <YStack gap={4} paddingLeft={8}>
              {file.size && (
                <XStack gap={8}>
                  <Text color={c.text3} fontSize={9} width={60}>
                    Size
                  </Text>
                  <Text color={c.text2} fontSize={9}>
                    {formatFileSize(file.size)}
                  </Text>
                </XStack>
              )}
              {file.createdTime && (
                <XStack gap={8}>
                  <Text color={c.text3} fontSize={9} width={60}>
                    Created
                  </Text>
                  <Text color={c.text2} fontSize={9}>
                    {formatDate(file.createdTime)}
                  </Text>
                </XStack>
              )}
              {file.modifiedTime && (
                <XStack gap={8}>
                  <Text color={c.text3} fontSize={9} width={60}>
                    Modified
                  </Text>
                  <Text color={c.text2} fontSize={9}>
                    {formatDate(file.modifiedTime)}
                  </Text>
                </XStack>
              )}
              {file.owners?.[0] && (
                <XStack gap={8}>
                  <Text color={c.text3} fontSize={9} width={60}>
                    Owner
                  </Text>
                  <Text color={c.text2} fontSize={9}>
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
      </ToolCallCard>
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
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {(status === 'failed' || (result && !result.success)) && (
          <ErrorBlock error={result?.error || output || 'Download failed'} />
        )}

        {status === 'completed' && result?.success && (
          <YStack gap={4}>
            <SuccessBlock message={`Downloaded: ${result.fileName || 'file'}`} />
            {result.path && (
              <XStack gap={8} paddingLeft={8}>
                <Text color={c.text3} fontSize={9}>
                  Path:
                </Text>
                <Text color={c.text2} fontSize={9} fontFamily="$mono">
                  {truncate(result.path, 40)}
                </Text>
              </XStack>
            )}
            {result.size && (
              <XStack gap={8} paddingLeft={8}>
                <Text color={c.text3} fontSize={9}>
                  Size:
                </Text>
                <Text color={c.text2} fontSize={9}>
                  {formatFileSize(result.size)}
                </Text>
              </XStack>
            )}
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Upload File Renderer
// ============================================================================

export function UploadFileRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  // The handler returns the bare Drive file object (response.data:
  // { id, name, mimeType, size, webViewLink }), NOT a { success, file } wrapper.
  const parsed = parseOutput<DriveFile & { error?: string }>(output || '');
  const file = typeof parsed === 'object' && parsed?.id ? (parsed as DriveFile) : null;
  const errorText =
    typeof parsed === 'object' && parsed !== null ? (parsed as { error?: string }).error : undefined;

  // Filename from result, else from input fileName/filePath.
  const inputParsed =
    typeof input === 'string'
      ? parseOutput<{ filePath?: string; fileName?: string }>(input)
      : input;
  const inputName =
    typeof inputParsed === 'object' && inputParsed !== null
      ? inputParsed.fileName || inputParsed.filePath?.split('/').pop()
      : undefined;
  const fileName = file?.name || inputName || 'file';

  const failed = status === 'failed' || (status === 'completed' && !file);

  // Badge — Badge (not ActionBadge) to stay consistent with the other
  // create/move/copy file renderers in this MCA.
  let badge: React.ReactNode = null;
  if (status === 'completed' && file) {
    badge = <Badge text="uploaded" variant="success" />;
  } else if (failed) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Upload: ${truncate(fileName, 20)}`
      : file?.name
        ? `Upload: ${truncate(file.name, 20)}`
        : 'Upload file';

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {failed && <ErrorBlock error={errorText || output || 'Upload failed'} />}

        {status === 'completed' && file && (
          <YStack gap={4}>
            <SuccessBlock message="File uploaded successfully" />
            <FileRow file={file} />
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Create Document Renderer
// ============================================================================

export function CreateDocumentRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  // Handler returns the bare Drive file ({ id, name, mimeType, webViewLink }).
  const parsed = parseOutput<DriveFile & { error?: string }>(output || '');
  const file = typeof parsed === 'object' && parsed?.id ? (parsed as DriveFile) : null;
  const errorText =
    typeof parsed === 'object' && parsed !== null ? (parsed as { error?: string }).error : undefined;

  const inputParsed = typeof input === 'string' ? parseOutput<{ title?: string }>(input) : input;
  const title =
    file?.name ||
    (typeof inputParsed === 'object' && inputParsed !== null ? inputParsed.title : undefined) ||
    'document';

  const failed = status === 'failed' || (status === 'completed' && !file);

  // Badge — Badge (not ActionBadge) to match the sibling create-folder renderer.
  let badge: React.ReactNode = null;
  if (status === 'completed' && file) {
    badge = <Badge text="created" variant="success" />;
  } else if (failed) {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description =
    status === 'running'
      ? `Create doc: ${truncate(title, 20)}`
      : file?.name
        ? `Create doc: ${truncate(file.name, 20)}`
        : 'Create document';

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {failed && <ErrorBlock error={errorText || output || 'Create document failed'} />}

        {status === 'completed' && file && (
          <YStack gap={4}>
            <SuccessBlock message={`Document "${truncate(title, 30)}" created`} />
            <FileRow
              file={{ ...file, mimeType: file.mimeType || 'application/vnd.google-apps.document' }}
            />
          </YStack>
        )}
      </ToolCallCard>
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

export function DeleteFileRenderer(props: ToolCallRendererProps) {
  const colors = useDriveColors();
  const { status, output, irreversible, appIcon } = props;

  const parsed = parseOutput<DeleteResult>(output || '');
  const result = typeof parsed === 'object' ? parsed : null;
  const isSuccess = result?.success || (typeof output === 'string' && output.includes('success'));

  // Tense-correct description (guide §2 slot 3).
  const description =
    status === 'pending_permission' || status === 'pending'
      ? 'Wants to delete file'
      : status === 'running'
        ? 'Deleting file'
        : status === 'completed'
          ? 'Deleted file'
          : 'Failed to delete file';

  // Slot 4 badge — ActionBadge with verb for the mutation (guide §4).
  const badge =
    status === 'completed' && isSuccess ? <ActionBadge verb="deleted" /> : null;

  // Body: only the SuccessBlock or ErrorBlock — the ToolCallCard owns
  // the header, irreversibility indicator, and (during pending_permission)
  // the ControlsBar.
  const hasFailure = status === 'failed' || Boolean(result && !result.success);
  const body =
    hasFailure ? (
      <ErrorBlock error={result?.error || output || 'Delete failed'} />
    ) : status === 'completed' && isSuccess ? (
      <SuccessBlock message={result?.message || 'File deleted successfully'} />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      badge={badge}
      irreversible={irreversible}
    >
      {body}
    </ToolCallCard>
  );
}

// ============================================================================
// Search Files Renderer
// ============================================================================

export function SearchFilesRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const parsed = parseOutput<ListFilesResult>(output || '');
  const files = typeof parsed === 'object' && parsed?.files ? parsed.files : [];
  const count = files.length;

  // Get search term from input
  const inputParsed =
    typeof input === 'string' ? parseOutput<{ searchTerm?: string }>(input) : input;
  const searchTerm = (typeof inputParsed === 'object' && inputParsed !== null ? inputParsed.searchTerm : undefined) || '';

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = (
      <Badge text={formatCountBadge(count, 'result')} variant={countBadgeVariant(count)} />
    );
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && files.length === 0 && (
          <Empty message="No files found" hint="Try a different folder or filter" />
        )}

        {status === 'completed' && files.length > 0 && (
          <YStack gap={4}>
            {files.slice(0, 10).map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
            {files.length > 10 && (
              <Text color={c.text3} fontSize={9} textAlign="center">
                +{files.length - 10} more files
              </Text>
            )}
          </YStack>
        )}
      </ToolCallCard>
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
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <SuccessBlock message={`File "${result.name}" moved successfully`} />
        )}
      </ToolCallCard>
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
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
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
      </ToolCallCard>
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
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
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


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <XStack gap={8} alignItems="center">
              <FileText size={12} color={colors.document} />
              <Text color={c.text} fontSize={10} fontWeight="500">
                {result.name}
              </Text>
            </XStack>

            <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} maxHeight={150}>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Text color={c.text2} fontSize={9} fontFamily="$mono" lineHeight={14}>
                  {truncate(result.content, 1000)}
                </Text>
              </ScrollView>
            </YStack>

            <Text color={c.text3} fontSize={9}>
              {contentLength.toLocaleString()} characters
            </Text>
          </YStack>
        )}
      </ToolCallCard>
  );
}
