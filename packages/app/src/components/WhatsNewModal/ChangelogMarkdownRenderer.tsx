/**
 * ChangelogMarkdownRenderer
 *
 * A variant of the MarkdownViewerWindow's MarkdownRenderer that:
 * - ALLOWS external images (http/https) — changelog content is author-controlled,
 *   not user-generated, so the security constraint that blocks external images
 *   in the markdown viewer doesn't apply here.
 * - Renders images responsively (max-width: 100%, no overflow) inside the card.
 * - Supports all other Markdown features (headers, lists, bold, links, code, etc.)
 * - Uses the same `marked` + syntax highlighting approach as the parent renderer.
 *
 * Platform strategy mirrors MarkdownRenderer:
 *   Web    → marked converts Markdown → HTML, code blocks via SyntaxHighlighter
 *   Native → react-native-markdown-display with custom rules (images render natively)
 */

import { marked } from 'marked';
import React, { useMemo } from 'react';
import { Platform, ScrollView, Text, Image, Linking } from 'react-native';
// @ts-ignore — react-native-markdown-display types may be incomplete
import Markdown from 'react-native-markdown-display';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import markdownLang from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

import { useColors } from '../mca/primitives/useColors';
import { surface, colors as semanticColors, type SurfaceTokens } from '../mca/primitives/colors';

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
SyntaxHighlighter.registerLanguage('markdown', markdownLang);
SyntaxHighlighter.registerLanguage('md', markdownLang);

// ─── Constants ────────────────────────────────────────────────────────────────

// Font stacks aligned with tamagui.config.ts and tokens.css.
//   DM Sans       → UI / body text
//   Newsreader    → display / headings
//   JetBrains Mono → code / data
const FONT_BODY = "'DM Sans', system-ui, -apple-system, sans-serif";
const FONT_SERIF = "'Newsreader', Georgia, serif";
const FONT_MONO = "'JetBrains Mono', 'Fira Code', monospace";

// ─── Web CSS (theme-aware) ────────────────────────────────────────────────────

function buildWebStyles(c: SurfaceTokens, isDark: boolean): string {
  const headingColor = c.text;
  const headingSecondary = c.text2;
  const mutedColor = c.text3;
  const borderColor = c.borderStrong;
  const borderSubtle = c.border;
  const cardBg = c.bgCard;
  const bodyColor = c.text;
  const codeBg = isDark ? 'rgba(110,118,129,0.15)' : 'rgba(10,10,15,0.07)';
  const codeColor = isDark ? semanticColors.indigoLight : semanticColors.indigoDark;
  const linkColor = semanticColors.indigo;
  const indigo = semanticColors.indigo;
  const indigoGlow = semanticColors.indigoGlow;

  return `
  .changelog-md {
    font-family: ${FONT_BODY};
    font-size: 14px;
    line-height: 1.65;
    color: ${bodyColor};
    width: 100%;
    box-sizing: border-box;
  }
  .changelog-md h1 { font-family: ${FONT_SERIF}; font-size: 1.6em; margin: 0.4em 0 0.3em; font-weight: 400; color: ${headingColor}; letter-spacing: -0.01em; }
  .changelog-md h2 { font-family: ${FONT_SERIF}; font-size: 1.35em; margin: 0.8em 0 0.3em; font-weight: 400; color: ${headingColor}; letter-spacing: -0.01em; }
  .changelog-md h3 { font-family: ${FONT_SERIF}; font-size: 1.15em; margin: 0.6em 0 0.25em; font-weight: 400; color: ${headingColor}; letter-spacing: -0.01em; }
  .changelog-md h4 { font-size: 1em; margin: 0.5em 0 0.2em; font-weight: 600; color: ${headingColor}; }
  .changelog-md h5, .changelog-md h6 { font-size: 0.9em; margin: 0.4em 0 0.2em; font-weight: 600; color: ${headingSecondary}; }
  .changelog-md p { margin: 0 0 0.7em; }
  .changelog-md ul, .changelog-md ol { margin: 0 0 0.7em 1.3em; padding: 0; }
  .changelog-md li { margin: 0.2em 0; }
  .changelog-md blockquote {
    margin: 0.8em 0;
    padding: 12px 16px;
    border-left: none;
    background: ${isDark ? 'rgba(255,255,255,0.05)' : 'rgba(10,10,15,0.06)'};
    color: ${mutedColor};
    border-radius: 8px;
    font-size: 0.95em;
    font-style: italic;
  }
  .changelog-md hr { border: none; border-top: 1px solid ${borderColor}; margin: 1em 0; }
  .changelog-md code {
    background: ${codeBg};
    color: ${codeColor};
    padding: 1px 4px;
    border-radius: 3px;
    font-family: ${FONT_MONO};
    font-size: 0.85em;
  }
  .changelog-md pre {
    margin: 0.6em 0;
    border-radius: 6px;
    overflow: auto;
    background: ${cardBg};
  }
  .changelog-md pre code {
    background: none;
    color: inherit;
    padding: 0;
    border-radius: 0;
    font-size: 0.85em;
  }
  .changelog-md a { color: ${linkColor}; text-decoration: none; }
  .changelog-md a:hover { text-decoration: underline; }
  .changelog-md img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
    margin: 0.4em 0;
    display: block;
  }
  .changelog-md s, .changelog-md del { text-decoration: line-through; color: ${mutedColor}; }
  .changelog-md strong { font-weight: 600; color: ${headingColor}; }
  .changelog-md .md-code-block { margin: 0.6em 0; }
`;
}

let webStyleElement: HTMLStyleElement | null = null;
let webStyleThemeKey = '';

function ensureWebStyles(c: SurfaceTokens, isDark: boolean) {
  if (typeof document === 'undefined') return;
  const themeKey = isDark ? 'dark' : 'light';
  const css = buildWebStyles(c, isDark);

  if (webStyleElement && webStyleThemeKey === themeKey) return;

  if (webStyleElement) {
    webStyleElement.textContent = css;
    webStyleThemeKey = themeKey;
    return;
  }

  const style = document.createElement('style');
  style.id = 'changelog-md-styles';
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

function parseSegments(markdownText: string): Segment[] {
  marked.setOptions({ gfm: true, breaks: false });

  const tokens = marked.lexer(markdownText);
  const segments: Segment[] = [];
  let htmlAccum = '';

  const flushHtml = () => {
    if (htmlAccum.trim()) {
      // Post-process: add target="_blank" to links, keep images as-is (allowed in changelog)
      let safe = htmlAccum.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');
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
      const html = marked.parser([token as any]);
      htmlAccum += html;
    }
  }

  flushHtml();
  return segments;
}

interface WebRendererProps {
  content: string;
  c: SurfaceTokens;
  isDark: boolean;
}

function WebChangelogMarkdown({ content, c, isDark }: WebRendererProps) {
  ensureWebStyles(c, isDark);

  const segments = useMemo(() => parseSegments(content), [content]);

  return (
    <div className="changelog-md">
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
        return (
          <div key={i} className="md-code-block">
            <SyntaxHighlighter
              language={seg.lang || 'text'}
              style={oneDark}
              customStyle={{
                borderRadius: 6,
                fontSize: 12,
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

function buildNativeStyles(c: SurfaceTokens, isDark: boolean) {
  const headingColor = c.text;
  const headingSecondary = c.text2;
  const mutedColor = c.text3;
  const borderColor = c.borderStrong;
  const cardBg = c.bgCard;
  const codeBg = isDark ? 'rgba(110,118,129,0.15)' : 'rgba(10,10,15,0.07)';
  const codeColor = isDark ? semanticColors.indigoLight : semanticColors.indigoDark;
  const linkColor = semanticColors.indigo;

  return {
    body: { color: c.text, fontSize: 14, lineHeight: 22 },
    heading1: { fontFamily: FONT_SERIF, fontSize: 24, fontWeight: '400' as const, marginTop: 6, marginBottom: 6, color: headingColor },
    heading2: { fontFamily: FONT_SERIF, fontSize: 20, fontWeight: '400' as const, marginTop: 12, marginBottom: 4, color: headingColor },
    heading3: { fontFamily: FONT_SERIF, fontSize: 17, fontWeight: '400' as const, marginTop: 8, marginBottom: 4, color: headingColor },
    heading4: { fontSize: 15, fontWeight: '600' as const, marginTop: 6, marginBottom: 3, color: headingColor },
    heading5: { fontSize: 14, fontWeight: '600' as const, marginTop: 6, marginBottom: 3, color: headingSecondary },
    heading6: { fontSize: 13, fontWeight: '600' as const, marginTop: 6, marginBottom: 3, color: mutedColor },
    paragraph: { marginTop: 0, marginBottom: 8 },
    blockquote: {
      borderLeftWidth: 0,
      paddingLeft: 16,
      paddingRight: 16,
      paddingVertical: 12,
      marginVertical: 8,
      backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(10,10,15,0.06)',
      borderRadius: 8,
    },
    code_inline: {
      backgroundColor: codeBg,
      color: codeColor,
      paddingHorizontal: 3,
      paddingVertical: 1,
      borderRadius: 3,
      fontFamily: FONT_MONO,
      fontSize: 12,
    },
    fence: {
      backgroundColor: cardBg,
      borderRadius: 6,
      padding: 10,
      marginVertical: 6,
      fontFamily: FONT_MONO,
      fontSize: 12,
    },
    link: { color: linkColor },
    hr: { borderTopWidth: 1, borderTopColor: borderColor, marginVertical: 10 },
    bullet_list: { marginVertical: 6 },
    ordered_list: { marginVertical: 6 },
    list_item: { marginVertical: 2 },
    strong: { fontWeight: '700' as const, color: headingColor },
    s: { textDecorationLine: 'line-through' as const, color: mutedColor },
  };
}

function buildNativeRules(c: SurfaceTokens, _isDark: boolean) {
  const linkColor = semanticColors.indigo;
  return {
    image: (node: any, _children: any, _parent: any, _styles: any) => {
      const src: string = node.attributes?.src ?? '';
      const alt: string = node.attributes?.alt ?? '';
      if (!src) return null;
      return (
        <Image
          key={node.key}
          source={{ uri: src }}
          alt={alt}
          style={{
            width: '100%',
            height: 200,
            borderRadius: 6,
            marginVertical: 6,
            resizeMode: 'contain',
          }}
          accessibilityLabel={alt}
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
            if (href) {
              Linking.openURL(href).catch(() => {});
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
          customStyle={{ borderRadius: 6, fontSize: 12, margin: 6 }}
          PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      );
    },
  };
}

// ─── Public component ──────────────────────────────────────────────────────────

interface ChangelogMarkdownRendererProps {
  content: string;
}

export function ChangelogMarkdownRenderer({ content }: ChangelogMarkdownRendererProps) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  if (Platform.OS === 'web') {
    return <WebChangelogMarkdown content={content} c={c} isDark={isDark} />;
  }

  const nativeStyles = buildNativeStyles(c, isDark);
  const nativeRules = buildNativeRules(c, isDark);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 0 }}
      showsVerticalScrollIndicator={false}
    >
      <Markdown rules={nativeRules} style={nativeStyles}>
        {content}
      </Markdown>
    </ScrollView>
  );
}
