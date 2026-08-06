/**
 * MarkdownRenderer
 *
 * Renders Markdown content with:
 * - Full CommonMark + GFM support (headings, lists, tables, strikethrough, task lists)
 * - Syntax highlighting for fenced code blocks via react-syntax-highlighter
 * - External image blocking — images with http(s):// src are replaced with
 *   <ImagePlaceholder> (no outbound request made)
 * - Links open in a new tab with rel="noopener noreferrer"
 *
 * Platform strategy:
 *   Web    → marked converts Markdown → HTML. Code blocks are rendered as
 *             React <SyntaxHighlighter> components interleaved with the HTML
 *             segments via a split-and-render approach. Images and links are
 *             post-processed for security.
 *
 *   Native → react-native-markdown-display with custom rules for image, link,
 *             and fence (code block) nodes.
 */

import { marked } from 'marked';
import React, { useMemo } from 'react';
import { Platform, ScrollView, Text } from 'react-native';
// @ts-ignore — react-native-markdown-display types may be incomplete
import Markdown from 'react-native-markdown-display';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

import { useColors } from '../../../components/mca/primitives/useColors';
import { surface, colors as semanticColors, type SurfaceTokens } from '../../../components/mca/primitives/colors';

SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('tsx', typescript);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('jsx', javascript);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('yml', yaml);
SyntaxHighlighter.registerLanguage('markdown', markdown);
SyntaxHighlighter.registerLanguage('md', markdown);

// ─── Constants ────────────────────────────────────────────────────────────────

const EXTERNAL_URL_RE = /^https?:\/\//i;

// Tamagui font family stacks (from tamagui.config.ts)
const FONT_BODY = "'DM Sans', system-ui, -apple-system, sans-serif";
const FONT_MONO = "'JetBrains Mono', 'Fira Code', monospace";

// ─── Web CSS (theme-aware, injected/updated on theme change) ───────────────────

/**
 * Build the web CSS string using design system tokens.
 * Called whenever the theme changes; the <style> element is updated in-place.
 */
function buildWebStyles(c: SurfaceTokens, isDark: boolean): string {
  const headingColor = c.text;
  const headingSecondary = c.text2;
  const mutedColor = c.text3;
  const borderColor = c.borderStrong;
  const borderSubtle = c.border;
  const cardBg = c.bgCard;
  const pageBg = c.bgPage;
  const bodyColor = c.text;
  const codeBg = isDark ? 'rgba(110,118,129,0.15)' : 'rgba(10,10,15,0.07)';
  const codeColor = isDark ? 'semanticColors.indigoLight' : 'semanticColors.indigoDark';
  const linkColor = isDark ? 'semanticColors.indigo' : semanticColors.indigo;
  const indigo = semanticColors.indigo;
  const indigoGlow = semanticColors.indigoGlow;
  const indigoLight = semanticColors.indigoLight;

  return `
  .md-content {
    font-family: ${FONT_BODY};
    font-size: 15px;
    line-height: 1.7;
    color: ${bodyColor};
    background: ${pageBg};
    padding: 24px 28px;
    max-width: 860px;
    margin: 0 auto;
    box-sizing: border-box;
    width: 100%;
  }
  .md-content h1 { font-size: 2em; margin: 0.5em 0 0.4em; font-weight: 700; border-bottom: 2px solid ${borderColor}; padding-bottom: 0.3em; color: ${headingColor}; }
  .md-content h2 { font-size: 1.5em; margin: 1.2em 0 0.4em; font-weight: 600; border-bottom: 1px solid ${borderSubtle}; padding-bottom: 0.2em; color: ${headingColor}; }
  .md-content h3 { font-size: 1.25em; margin: 1em 0 0.4em; font-weight: 600; color: ${headingColor}; }
  .md-content h4 { font-size: 1.05em; margin: 1em 0 0.3em; font-weight: 600; color: ${headingColor}; }
  .md-content h5, .md-content h6 { font-size: 0.95em; margin: 0.8em 0 0.3em; font-weight: 600; color: ${headingSecondary}; }
  .md-content p { margin: 0 0 1em; }
  .md-content ul, .md-content ol { margin: 0 0 1em 1.5em; padding: 0; }
  .md-content li { margin: 0.25em 0; }
  .md-content li input[type="checkbox"] { margin-right: 6px; vertical-align: middle; }
  .md-content blockquote {
    margin: 1em 0;
    padding: 0.5em 1em;
    border-left: 4px solid ${indigo};
    background: ${indigoGlow};
    color: ${mutedColor};
    border-radius: 0 6px 6px 0;
  }
  .md-content hr { border: none; border-top: 1px solid ${borderColor}; margin: 1.5em 0; }
  .md-content code {
    background: ${codeBg};
    color: ${codeColor};
    padding: 2px 5px;
    border-radius: 4px;
    font-family: ${FONT_MONO};
    font-size: 0.875em;
  }
  .md-content pre {
    margin: 0.8em 0;
    border-radius: 8px;
    overflow: auto;
    background: ${cardBg};
  }
  .md-content pre code {
    background: none;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 0.875em;
  }
  .md-content table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.9em;
    overflow: auto;
    display: block;
  }
  .md-content th {
    background: ${cardBg};
    border: 1px solid ${borderColor};
    padding: 8px 12px;
    text-align: left;
    font-weight: 600;
    color: ${headingColor};
  }
  .md-content td {
    border: 1px solid ${borderColor};
    padding: 8px 12px;
  }
  .md-content tr:nth-child(even) { background: ${isDark ? cardBg : 'rgba(10,10,15,0.03)'}; }
  .md-content a { color: ${linkColor}; text-decoration: none; }
  .md-content a:hover { text-decoration: underline; }
  .md-content img { max-width: 100%; border-radius: 6px; }
  .md-content s, .md-content del { text-decoration: line-through; color: ${mutedColor}; }
  .md-content .md-code-block {
    margin: 0.8em 0;
  }
  .md-img-placeholder {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 8px 12px;
    margin: 4px 0;
    border: 1.5px dashed ${indigo}66;
    border-radius: 8px;
    background: ${indigoGlow};
    font-size: 12px;
    color: ${indigoLight};
    font-family: inherit;
    max-width: 100%;
    box-sizing: border-box;
  }
  .md-img-placeholder-label {
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .md-img-placeholder-alt {
    font-style: italic;
    color: ${mutedColor};
  }
  .md-img-placeholder-url {
    font-family: ${FONT_MONO};
    font-size: 11px;
    color: ${c.text3};
    word-break: break-all;
  }
`;
}

let webStyleElement: HTMLStyleElement | null = null;
let webStyleThemeKey = '';

function ensureWebStyles(c: SurfaceTokens, isDark: boolean) {
  if (typeof document === 'undefined') return;
  const themeKey = isDark ? 'dark' : 'light';
  const css = buildWebStyles(c, isDark);

  if (webStyleElement && webStyleThemeKey === themeKey) return; // already up-to-date

  if (webStyleElement) {
    // Update existing element (theme switched)
    webStyleElement.textContent = css;
    webStyleThemeKey = themeKey;
    return;
  }

  // First injection
  const style = document.createElement('style');
  style.id = 'md-viewer-styles';
  style.textContent = css;
  document.head.appendChild(style);
  webStyleElement = style;
  webStyleThemeKey = themeKey;
}

// ─── Web renderer: split HTML into segments + code blocks ─────────────────────

interface HtmlSegment {
  type: 'html';
  content: string;
}

interface CodeSegment {
  type: 'code';
  lang: string;
  code: string;
}

type Segment = HtmlSegment | CodeSegment;

/**
 * Parse Markdown into an array of segments:
 * - 'html' segments: rendered HTML from marked (no code blocks)
 * - 'code' segments: fenced code blocks with language info
 *
 * This lets us render HTML via dangerouslySetInnerHTML and code blocks
 * via <SyntaxHighlighter> React components, interleaved correctly.
 */
function parseSegments(markdownText: string): Segment[] {
  // Use marked's lexer to walk tokens
  marked.setOptions({ gfm: true, breaks: false });

  const tokens = marked.lexer(markdownText);
  const segments: Segment[] = [];
  let htmlAccum = '';

  const flushHtml = () => {
    if (htmlAccum.trim()) {
      // Post-process: block external images, add target="_blank" to links
      let safe = htmlAccum.replace(
        /<img([^>]*?)src=["'](https?:\/\/[^"']+)["']([^>]*?)>/gi,
        (_match, before, src, after) => {
          const altMatch = (before + after).match(/alt=["']([^"']*)["']/i);
          const alt = altMatch ? altMatch[1] : '';
          return `<span class="md-img-placeholder"><span class="md-img-placeholder-label">🖼️ External image blocked</span>${alt ? `<span class="md-img-placeholder-alt">${alt}</span>` : ''}<span class="md-img-placeholder-url">${src}</span></span>`;
        },
      );
      safe = safe.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');
      segments.push({ type: 'html', content: safe });
      htmlAccum = '';
    }
  };

  for (const token of tokens) {
    if (token.type === 'code') {
      flushHtml();
      segments.push({
        type: 'code',
        lang: (token as any).lang?.trim() ?? '',
        code: (token as any).text ?? '',
      });
    } else {
      // Render this token back to HTML
      const html = marked.parser([token as any]);
      htmlAccum += html;
    }
  }

  flushHtml();
  return segments;
}

interface WebMarkdownRendererProps {
  content: string;
  c: SurfaceTokens;
  isDark: boolean;
}

function WebMarkdownRenderer({ content, c, isDark }: WebMarkdownRendererProps) {
  ensureWebStyles(c, isDark);

  const segments = useMemo(() => parseSegments(content), [content]);

  return (
    <div className="md-content">
      {segments.map((seg, i) => {
        if (seg.type === 'html') {
          return (
            <div
              key={i}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: seg.content }}
            />
          );
        }
        // Code block with syntax highlighting
        return (
          <div key={i} className="md-code-block">
            <SyntaxHighlighter
              language={seg.lang || 'text'}
              style={oneDark}
              customStyle={{
                borderRadius: 8,
                fontSize: 13,
                margin: 0,
                lineHeight: 1.5,
              }}
              PreTag="div"
              showLineNumbers={false}
            >
              {seg.code}
            </SyntaxHighlighter>
          </div>
        );
      })}
    </div>
  );
}

// ─── Native renderer ───────────────────────────────────────────────────────────

/**
 * Build native markdown styles using design system tokens.
 * Called inside the component so useColors() values are available.
 */
function buildNativeStyles(c: SurfaceTokens, isDark: boolean) {
  const headingColor = c.text;
  const headingSecondary = c.text2;
  const mutedColor = c.text3;
  const borderColor = c.borderStrong;
  const cardBg = c.bgCard;
  const codeBg = isDark ? 'rgba(110,118,129,0.15)' : 'rgba(10,10,15,0.07)';
  const codeColor = isDark ? 'semanticColors.indigoLight' : 'semanticColors.indigoDark';
  const linkColor = isDark ? 'semanticColors.indigo' : semanticColors.indigo;

  return {
    body: { color: c.text, fontSize: 15, lineHeight: 24 },
    heading1: { fontSize: 28, fontWeight: '700' as const, marginTop: 8, marginBottom: 8, color: headingColor },
    heading2: { fontSize: 22, fontWeight: '600' as const, marginTop: 16, marginBottom: 6, color: headingColor },
    heading3: { fontSize: 18, fontWeight: '600' as const, marginTop: 12, marginBottom: 4, color: headingColor },
    heading4: { fontSize: 16, fontWeight: '600' as const, marginTop: 8, marginBottom: 4, color: headingColor },
    heading5: { fontSize: 14, fontWeight: '600' as const, marginTop: 8, marginBottom: 4, color: headingSecondary },
    heading6: { fontSize: 13, fontWeight: '600' as const, marginTop: 8, marginBottom: 4, color: mutedColor },
    paragraph: { marginTop: 0, marginBottom: 10 },
    blockquote: {
      borderLeftWidth: 4,
      borderLeftColor: semanticColors.indigo,
      paddingLeft: 12,
      marginVertical: 8,
      backgroundColor: semanticColors.indigoGlow,
      borderRadius: 4,
    },
    code_inline: {
      backgroundColor: codeBg,
      color: codeColor,
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: 4,
      fontFamily: 'JetBrains Mono',
      fontSize: 13,
    },
    fence: {
      backgroundColor: cardBg,
      borderRadius: 8,
      padding: 12,
      marginVertical: 8,
      fontFamily: 'JetBrains Mono',
      fontSize: 13,
    },
    link: { color: linkColor },
    hr: { borderTopWidth: 1, borderTopColor: borderColor, marginVertical: 12 },
    table: { borderWidth: 1, borderColor: borderColor, marginVertical: 8 },
    thead: { backgroundColor: cardBg },
    th: { padding: 8, fontWeight: '600' as const, borderWidth: 1, borderColor: borderColor, color: headingColor },
    td: { padding: 8, borderWidth: 1, borderColor: borderColor },
    bullet_list: { marginVertical: 8 },
    ordered_list: { marginVertical: 8 },
    list_item: { marginVertical: 2 },
    s: { textDecorationLine: 'line-through' as const, color: mutedColor },
  };
}

/**
 * Build native rules with theme-aware colors.
 */
function buildNativeRules(c: SurfaceTokens, isDark: boolean) {
  const linkColor = isDark ? 'semanticColors.indigo' : semanticColors.indigo;
  return {
    image: (node: any, _children: any, _parent: any, _styles: any) => {
      const src: string = node.attributes?.src ?? '';
      const alt: string = node.attributes?.alt ?? '';
      const isExternal = EXTERNAL_URL_RE.test(src);
      const { ImagePlaceholder } = require('./ImagePlaceholder');
      return (
        <ImagePlaceholder
          key={node.key}
          alt={alt}
          url={src}
          local={!isExternal}
        />
      );
    },
    link: (node: any, children: any, _parent: any, styles: any) => {
      const href: string = node.attributes?.href ?? '';
      return (
        <Text
          key={node.key}
          style={[styles.link, { color: linkColor }]}
          onPress={() => {
            if (typeof window !== 'undefined') {
              window.open(href, '_blank', 'noopener,noreferrer');
            }
          }}
        >
          {children}
        </Text>
      );
    },
    fence: (node: any, _children: any, _parent: any, _styles: any) => {
      const lang: string = node.sourceInfo?.trim() ?? '';
      const code: string = node.content ?? '';
      return (
        <SyntaxHighlighter
          key={node.key}
          language={lang || 'text'}
          style={oneDark}
          customStyle={{ borderRadius: 8, fontSize: 13, margin: 8 }}
          PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      );
    },
  };
}

// ─── Public component ──────────────────────────────────────────────────────────

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  if (Platform.OS === 'web') {
    return <WebMarkdownRenderer content={content} c={c} isDark={isDark} />;
  }

  const nativeStyles = buildNativeStyles(c, isDark);
  const nativeRules = buildNativeRules(c, isDark);

  // Native: react-native-markdown-display with custom rules
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bgPage }}
      contentContainerStyle={{ padding: 20 }}
    >
      <Markdown rules={nativeRules} style={nativeStyles}>
        {content}
      </Markdown>
    </ScrollView>
  );
}
