/**
 * Google Drive - Comments Renderers
 *
 * Renderers for comment operations:
 * - create-comment
 * - list-comments
 * - get-comment
 * - update-comment
 * - delete-comment
 * - create-reply
 * - list-replies
 */

import { Check, MessageSquare, Trash2, User } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, Empty, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useDriveColors,
  formatDate,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Types
// ============================================================================

interface CommentAuthor {
  displayName?: string;
  emailAddress?: string;
  photoLink?: string;
}

interface Comment {
  id: string;
  content: string;
  htmlContent?: string;
  author?: CommentAuthor;
  createdTime?: string;
  modifiedTime?: string;
  resolved?: boolean;
  deleted?: boolean;
  replies?: Reply[];
}

interface Reply {
  id: string;
  content: string;
  author?: CommentAuthor;
  createdTime?: string;
  action?: string;
}

// ============================================================================
// Comment Row Component
// ============================================================================

function CommentRow({ comment }: { comment: Comment }) {
  const c = useDriveColors();
  const colors = useDriveColors();
  return (
    <YStack
      backgroundColor={c.bgInner}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      gap={4}
    >
      <XStack alignItems="center" gap={6}>
        <User size={10} color={c.text2} />
        <Text color={c.text} fontSize={9} fontWeight="500" flex={1}>
          {comment.author?.displayName || comment.author?.emailAddress || 'Unknown'}
        </Text>
        {comment.resolved && (
          <XStack alignItems="center" gap={2}>
            <Check size={8} color={colors.success} />
            <Text color={colors.success} fontSize={8}>
              Resolved
            </Text>
          </XStack>
        )}
        {comment.createdTime && (
          <Text color={c.text3} fontSize={8}>
            {formatDate(comment.createdTime)}
          </Text>
        )}
      </XStack>

      <Text color={c.text2} fontSize={10} numberOfLines={3}>
        {comment.content}
      </Text>

      {comment.replies && comment.replies.length > 0 && (
        <Text color={c.text3} fontSize={8}>
          {comment.replies.length} repl{comment.replies.length === 1 ? 'y' : 'ies'}
        </Text>
      )}
    </YStack>
  );
}

// ============================================================================
// Create Comment Renderer
// ============================================================================

export function CreateCommentRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
  const parsed = parseOutput<Comment>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'Create comment';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <SuccessBlock message="Comment created" />
            <CommentRow comment={result} />
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// List Comments Renderer
// ============================================================================

interface ListCommentsResult {
  comments: Comment[];
}

export function ListCommentsRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const parsed = parseOutput<ListCommentsResult>(output || '');
  const comments = typeof parsed === 'object' && parsed?.comments ? parsed.comments : [];
  const count = comments.length;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = (
      <Badge text={formatCountBadge(count, 'comment')} variant={countBadgeVariant(count)} />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'List comments';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && comments.length === 0 && <Empty message="No comments yet" />}

        {status === 'completed' && comments.length > 0 && (
          <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
            <YStack gap={4}>
              {comments.slice(0, 10).map((comment) => (
                <CommentRow key={comment.id} comment={comment} />
              ))}
              {comments.length > 10 && (
                <Text color={c.text3} fontSize={9} textAlign="center">
                  +{comments.length - 10} more comments
                </Text>
              )}
            </YStack>
          </ScrollView>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Get Comment Renderer
// ============================================================================

export function GetCommentRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
  const parsed = parseOutput<Comment>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    if (result.resolved) {
      badge = <Badge text="resolved" variant="success" />;
    } else {
      badge = <Badge text="open" variant="info" />;
    }
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'Get comment';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && <CommentRow comment={result} />}
      </ToolCallCard>
  );
}

// ============================================================================
// Update Comment Renderer
// ============================================================================

export function UpdateCommentRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
  const parsed = parseOutput<Comment>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'Update comment';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <SuccessBlock message="Comment updated" />
            <CommentRow comment={result} />
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Delete Comment Renderer
// ============================================================================

interface DeleteCommentResult {
  success: boolean;
  message?: string;
}

export function DeleteCommentRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const colors = useDriveColors();
  const parsed = parseOutput<DeleteCommentResult>(output || '');
  const result = typeof parsed === 'object' && parsed?.success ? parsed : null;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    badge = <Badge text="deleted" variant="warning" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'Delete comment';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <SuccessBlock message={result.message || 'Comment deleted successfully'} />
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// Create Reply Renderer
// ============================================================================

export function CreateReplyRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const parsed = parseOutput<Reply>(output || '');
  const result = typeof parsed === 'object' && parsed?.id ? parsed : null;

  // Get action from input
  const inputParsed = typeof input === 'string' ? parseOutput<{ action?: string }>(input) : input;
  const action = typeof inputParsed === 'object' && inputParsed !== null ? inputParsed.action : undefined;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed' && result) {
    if (action === 'resolve') {
      badge = <Badge text="resolved" variant="success" />;
    } else {
      badge = <Badge text="replied" variant="success" />;
    }
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = action === 'resolve' ? 'Resolve comment' : 'Create reply';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && result && (
          <YStack gap={4}>
            <SuccessBlock message={action === 'resolve' ? 'Comment resolved' : 'Reply created'} />

            <YStack
              backgroundColor={c.bgInner}
              borderRadius={5}
              paddingVertical={6}
              paddingHorizontal={8}
              gap={4}
            >
              <XStack alignItems="center" gap={6}>
                <User size={10} color={c.text2} />
                <Text color={c.text} fontSize={9} fontWeight="500" flex={1}>
                  {result.author?.displayName || result.author?.emailAddress || 'You'}
                </Text>
                {result.createdTime && (
                  <Text color={c.text3} fontSize={8}>
                    {formatDate(result.createdTime)}
                  </Text>
                )}
              </XStack>

              <Text color={c.text2} fontSize={10}>
                {result.content}
              </Text>
            </YStack>
          </YStack>
        )}
      </ToolCallCard>
  );
}

// ============================================================================
// List Replies Renderer
// ============================================================================

interface ListRepliesResult {
  replies: Reply[];
}

export function ListRepliesRenderer({
  toolName,
  status,
  appIcon,
  output,
  input,
}: ToolCallRendererProps) {
  const c = useDriveColors();
  const colors = useDriveColors();
  const parsed = parseOutput<ListRepliesResult>(output || '');
  const replies = typeof parsed === 'object' && parsed?.replies ? parsed.replies : [];
  const count = replies.length;

  // Badge
  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = (
      <Badge
        text={formatCountBadge(count, 'reply', 'replies')}
        variant={countBadgeVariant(count)}
      />
    );
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  // Description
  const description = 'List replies';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {status === 'failed' && output && <ErrorBlock error={output} />}

        {status === 'completed' && replies.length === 0 && (
          <Text color={c.text3} fontSize={10}>
            No replies
          </Text>
        )}

        {status === 'completed' && replies.length > 0 && (
          <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={false}>
            <YStack gap={4}>
              {replies.map((reply) => (
                <YStack
                  key={reply.id}
                  backgroundColor={c.bgInner}
                  borderRadius={5}
                  paddingVertical={4}
                  paddingHorizontal={8}
                  gap={2}
                >
                  <XStack alignItems="center" gap={6}>
                    <User size={8} color={c.text2} />
                    <Text color={c.text} fontSize={8} fontWeight="500" flex={1}>
                      {reply.author?.displayName || reply.author?.emailAddress || 'Unknown'}
                    </Text>
                    {reply.action && <Badge text={reply.action} variant="info" />}
                  </XStack>
                  <Text color={c.text2} fontSize={9}>
                    {reply.content}
                  </Text>
                </YStack>
              ))}
            </YStack>
          </ScrollView>
        )}
      </ToolCallCard>
  );
}
