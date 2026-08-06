import { marked } from 'marked';
import { colors as semanticColors } from '../../mca/primitives/colors';
import { useColors } from '../../mca/primitives/useColors';
import { useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import RenderHtml from 'react-native-render-html';

// Table plugin for native platforms
import TableRenderer, { tableModel } from '@native-html/table-plugin';
import WebView from 'react-native-webview';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Build theme-adaptive HTML styles for react-native-render-html.
// Called inside the component so it has access to useColors() tokens.
function buildTagsStyles(c: ReturnType<typeof useColors>): any {
  return {
    body: {
      color: c.text,
      fontSize: 15,
      lineHeight: 24,
      ...(Platform.OS === 'web' ? { userSelect: 'text', cursor: 'text' } : {}),
    },
    p: {
      marginTop: 0,
      marginBottom: 8,
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
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      fontFamily: '$mono',
      fontSize: 13,
    },
    pre: {
      backgroundColor: c.bgCard,
      padding: 12,
      borderRadius: 8,
      marginVertical: 8,
      fontFamily: '$mono',
      fontSize: 13,
    },
    ul: {
      marginVertical: 8,
      paddingLeft: 24,
    },
    ol: {
      marginVertical: 8,
      paddingLeft: 24,
    },
    li: {
      marginVertical: 4,
    },
    a: {
      color: semanticColors.indigo,
    },
    blockquote: {
      borderLeftWidth: 3,
      borderLeftColor: c.borderStrong,
      marginVertical: 8,
      paddingLeft: 12,
      color: c.text2,
    },
    h1: {
      marginTop: 16,
      marginBottom: 8,
      fontWeight: '600' as const,
      color: c.text,
      fontSize: 22,
    },
    h2: {
      marginTop: 16,
      marginBottom: 8,
      fontWeight: '600' as const,
      color: c.text,
      fontSize: 19,
    },
    h3: {
      marginTop: 16,
      marginBottom: 8,
      fontWeight: '600' as const,
      color: c.text,
      fontSize: 17,
    },
    // Table styles for web platform
    table: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: 8,
      marginVertical: 8,
      overflow: 'hidden' as const,
    },
    th: {
      backgroundColor: c.bgInner,
      padding: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.borderStrong,
      fontWeight: '600' as const,
      color: c.text,
    },
    td: {
      padding: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    tr: {
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
  };
}

// Custom renderer for <pre> blocks on web - enables horizontal scroll
export const PreRenderer = ({ tnode }: any) => {
  const c = useColors()
  // Extract text content from the DOM tree recursively
  const extractText = (node: any): string => {
    if (!node) return '';
    if (node.type === 'text') return node.data || '';
    if (node.children) {
      return node.children.map(extractText).join('');
    }
    return '';
  };

  const textContent = extractText(tnode.domNode);

  return (
    <div
      style={{
        backgroundColor: c.bgCard,
        padding: 12,
        borderRadius: 8,
        marginTop: 8,
        marginBottom: 8,
        overflowX: 'auto',
        whiteSpace: 'pre',
      }}
    >
      <code
        style={{
          fontFamily: '$mono',
          fontSize: 13,
          color: c.text,
          whiteSpace: 'pre',
          wordWrap: 'normal',
          overflowWrap: 'normal',
        }}
      >
        {textContent}
      </code>
    </div>
  );
};

// Custom renderers - use PreRenderer on web for horizontal scroll
const renderers: any = Platform.OS === 'web' ? { pre: PreRenderer } : { table: TableRenderer };

// Custom HTML element models for native platforms
const customHTMLElementModels: any =
  Platform.OS !== 'web'
    ? {
        table: tableModel,
      }
    : {};

// Table configuration for WebView rendering on native — theme-adaptive
function buildTableConfig(c: ReturnType<typeof useColors>) {
  return {
    WebView,
    webViewProps: {
      style: {
        backgroundColor: 'transparent',
      },
    },
    tableStyleSpecs: {
      outerContainerStyle: {
        borderRadius: 8,
        overflow: 'hidden' as const,
        marginVertical: 8,
      },
    },
    cssRules: `
      table {
        width: 100%;
        border-collapse: collapse;
        background-color: ${c.bgCard};
        border-radius: 8px;
        overflow: hidden;
      }
      th {
        background-color: ${c.bgInner};
        padding: 10px 12px;
        text-align: left;
        font-weight: 600;
        color: ${c.text};
        border-bottom: 1px solid ${c.borderStrong};
        font-size: 14px;
      }
      td {
        padding: 10px 12px;
        color: ${c.text};
        border-bottom: 1px solid ${c.border};
        font-size: 14px;
      }
      tr:last-child td {
        border-bottom: none;
      }
      tr:nth-child(even) {
        background-color: ${c.bgInner};
      }
    `,
  };
}

// Render props for native platforms — built per-render with theme tokens
// (tableConfig needs useColors() tokens, so it's constructed in the component)

/**
 * Render markdown content as HTML using react-native-render-html
 */
export function MarkdownContent({ text }: { text: string }) {
  const c = useColors()
  const { width } = useWindowDimensions();

  const html = useMemo(() => {
    return marked.parse(text) as string;
  }, [text]);

  const tagsStylesMemo = useMemo(() => buildTagsStyles(c), [c]);

  const renderersPropsMemo = useMemo(() =>
    Platform.OS !== 'web' ? { table: buildTableConfig(c) } : {},
    [c],
  );

  return (
    <RenderHtml
      contentWidth={width * 0.85}
      source={{ html }}
      tagsStyles={tagsStylesMemo}
      defaultTextProps={{ selectable: true }}
      renderers={renderers}
      customHTMLElementModels={customHTMLElementModels}
      renderersProps={renderersPropsMemo}
    />
  );
}
