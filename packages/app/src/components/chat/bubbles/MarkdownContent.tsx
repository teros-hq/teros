import { marked } from 'marked';
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

// Styles for HTML rendering - with userSelect for web
const tagsStyles: any = {
  body: {
    color: 'rgba(255, 255, 255, 0.9)',
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
    color: '#fff',
  },
  em: {
    fontStyle: 'italic' as const,
  },
  code: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  pre: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    fontFamily: 'monospace, monospace',
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
    color: '#06B6D4',
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(255, 255, 255, 0.3)',
    marginVertical: 8,
    paddingLeft: 12,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  h1: {
    marginTop: 16,
    marginBottom: 8,
    fontWeight: '600' as const,
    color: '#fff',
    fontSize: 22,
  },
  h2: {
    marginTop: 16,
    marginBottom: 8,
    fontWeight: '600' as const,
    color: '#fff',
    fontSize: 19,
  },
  h3: {
    marginTop: 16,
    marginBottom: 8,
    fontWeight: '600' as const,
    color: '#fff',
    fontSize: 17,
  },
  // Table styles for web platform
  table: {
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 8,
    marginVertical: 8,
    overflow: 'hidden' as const,
  },
  th: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.2)',
    fontWeight: '600' as const,
    color: '#fff',
  },
  td: {
    padding: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  tr: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
};

// Custom renderer for <pre> blocks on web - enables horizontal scroll
export const PreRenderer = ({ tnode }: any) => {
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
        backgroundColor: 'rgba(30, 30, 30, 0.9)',
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
          fontFamily: 'monospace, monospace',
          fontSize: 13,
          color: 'rgba(255, 255, 255, 0.9)',
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

// Table configuration for WebView rendering on native
const tableConfig = {
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
      background-color: rgba(0, 0, 0, 0.3);
      border-radius: 8px;
      overflow: hidden;
    }
    th {
      background-color: rgba(255, 255, 255, 0.1);
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      color: #fff;
      border-bottom: 1px solid rgba(255, 255, 255, 0.2);
      font-size: 14px;
    }
    td {
      padding: 10px 12px;
      color: rgba(255, 255, 255, 0.9);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 14px;
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:nth-child(even) {
      background-color: rgba(255, 255, 255, 0.03);
    }
  `,
};

// Render props for native platforms
const renderersProps: any =
  Platform.OS !== 'web'
    ? {
        table: tableConfig,
      }
    : {};

/**
 * Render markdown content as HTML using react-native-render-html
 */
export function MarkdownContent({ text }: { text: string }) {
  const { width } = useWindowDimensions();

  const html = useMemo(() => {
    return marked.parse(text) as string;
  }, [text]);

  return (
    <RenderHtml
      contentWidth={width * 0.85}
      source={{ html }}
      tagsStyles={tagsStyles}
      defaultTextProps={{ selectable: true }}
      renderers={renderers}
      customHTMLElementModels={customHTMLElementModels}
      renderersProps={renderersProps}
    />
  );
}
