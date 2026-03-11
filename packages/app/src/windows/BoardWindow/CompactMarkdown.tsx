// ============================================================================
// COMPACT MARKDOWN RENDERER
// For use in compact panels like TaskDetailPanel
// Uses marked + react-native-render-html with small, muted styles
// ============================================================================

import { marked } from 'marked';
import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';

marked.setOptions({
  breaks: true,
  gfm: true,
});

interface CompactMarkdownProps {
  text: string;
  /** Base font size (default: 11.5) */
  fontSize?: number;
  /** Base text color (default: rgba(229,231,235,0.6)) */
  color?: string;
  /** Width override — defaults to container width from useWindowDimensions */
  width?: number;
}

/**
 * Renders markdown in a compact, muted style suitable for task description panels.
 */
export function CompactMarkdown({
  text,
  fontSize = 11.5,
  color = 'rgba(229,231,235,0.6)',
}: CompactMarkdownProps) {
  const { width: windowWidth } = useWindowDimensions();

  const html = useMemo(() => marked.parse(text) as string, [text]);

  const tagsStyles: any = useMemo(
    () => ({
      body: {
        color,
        fontSize,
        lineHeight: fontSize * 1.5,
        margin: 0,
        padding: 0,
        ...(Platform.OS === 'web' ? { userSelect: 'text', cursor: 'text' } : {}),
      },
      p: {
        marginTop: 0,
        marginBottom: 4,
      },
      strong: {
        fontWeight: '600' as const,
        color: 'rgba(229,231,235,0.9)',
      },
      em: {
        fontStyle: 'italic' as const,
      },
      code: {
        backgroundColor: 'rgba(255,255,255,0.08)',
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 3,
        fontFamily: 'monospace',
        fontSize: fontSize - 0.5,
        color: 'rgba(167,139,250,0.9)',
      },
      pre: {
        backgroundColor: 'rgba(0,0,0,0.3)',
        padding: 8,
        borderRadius: 5,
        marginVertical: 4,
        fontFamily: 'monospace, monospace',
        fontSize: fontSize - 0.5,
      },
      ul: {
        marginVertical: 2,
        paddingLeft: 16,
      },
      ol: {
        marginVertical: 2,
        paddingLeft: 16,
      },
      li: {
        marginVertical: 1,
      },
      a: {
        color: '#60A5FA',
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: 'rgba(255,255,255,0.2)',
        marginVertical: 4,
        paddingLeft: 8,
        color: 'rgba(229,231,235,0.45)',
      },
      h1: {
        marginTop: 6,
        marginBottom: 3,
        fontWeight: '600' as const,
        color: 'rgba(229,231,235,0.85)',
        fontSize: fontSize + 2,
      },
      h2: {
        marginTop: 6,
        marginBottom: 3,
        fontWeight: '600' as const,
        color: 'rgba(229,231,235,0.85)',
        fontSize: fontSize + 1,
      },
      h3: {
        marginTop: 4,
        marginBottom: 2,
        fontWeight: '600' as const,
        color: 'rgba(229,231,235,0.85)',
        fontSize,
      },
    }),
    [fontSize, color],
  );

  // On web, use a custom <pre> renderer to allow horizontal scroll
  const renderers: any = useMemo(
    () =>
      Platform.OS === 'web'
        ? {
            pre: ({ tnode }: any) => {
              const extractText = (node: any): string => {
                if (!node) return '';
                if (node.type === 'text') return node.data || '';
                if (node.children) return node.children.map(extractText).join('');
                return '';
              };
              return (
                <div
                  style={{
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    padding: 8,
                    borderRadius: 5,
                    marginTop: 4,
                    marginBottom: 4,
                    overflowX: 'auto',
                    whiteSpace: 'pre',
                  }}
                >
                  <code
                    style={{
                      fontFamily: 'monospace',
                      fontSize: fontSize - 0.5,
                      color: 'rgba(229,231,235,0.8)',
                      whiteSpace: 'pre',
                      wordWrap: 'normal',
                      overflowWrap: 'normal',
                    }}
                  >
                    {extractText(tnode.domNode)}
                  </code>
                </div>
              );
            },
          }
        : {},
    [fontSize],
  );

  return (
    <RenderHtml
      contentWidth={windowWidth}
      source={{ html }}
      tagsStyles={tagsStyles}
      defaultTextProps={{ selectable: true }}
      renderers={renderers}
    />
  );
}
