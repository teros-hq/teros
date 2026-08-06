// ============================================================================
// COMPACT MARKDOWN RENDERER
// For use in compact panels like TaskDetailPanel
// Uses marked + react-native-render-html with small, muted styles
// ============================================================================

import { marked } from 'marked';
import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';
import { useColors } from '../../components/mca/primitives/useColors';

marked.setOptions({
  breaks: true,
  gfm: true,
});

interface CompactMarkdownProps {
  text: string;
  /** Base font size (default: 11.5) */
  fontSize?: number;
  /** Base text color (defaults to theme secondary text) */
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
  color: colorProp,
}: CompactMarkdownProps) {
  const c = useColors();
  const color = colorProp ?? c.text2;
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
        color: c.text,
      },
      em: {
        fontStyle: 'italic' as const,
      },
      code: {
        backgroundColor: c.bgInner,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 3,
        fontFamily: 'monospace',
        fontSize: fontSize - 0.5,
        color: c.badges.info.text,
      },
      pre: {
        backgroundColor: c.bgInner,
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
        color: c.badges.info.text,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: c.borderStrong,
        marginVertical: 4,
        paddingLeft: 8,
        color: c.text3,
      },
      h1: {
        marginTop: 6,
        marginBottom: 3,
        fontWeight: '600' as const,
        color: c.text,
        fontSize: fontSize + 2,
      },
      h2: {
        marginTop: 6,
        marginBottom: 3,
        fontWeight: '600' as const,
        color: c.text,
        fontSize: fontSize + 1,
      },
      h3: {
        marginTop: 4,
        marginBottom: 2,
        fontWeight: '600' as const,
        color: c.text,
        fontSize,
      },
    }),
    [fontSize, color, c],
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
                    backgroundColor: c.bgInner,
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
                      color: c.text2,
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
    [fontSize, c],
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
