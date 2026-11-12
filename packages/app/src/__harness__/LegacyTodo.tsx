/**
 * The To Do markdown viewer (docs/specs/todo/markdown.md): task inputs/outputs
 * and the summary blocks. Hand-written, drawn with the To Do kit (weight 400,
 * kit colours). Blocks (TODOMD-REQ-1): `#` title (serif 22), `##`+ subtitles
 * (serif 17), paragraphs, bullet / task / numbered lists, fenced code, rules,
 * blockquotes and GFM pipe tables (TODOMD-REQ-3). Inline (TODOMD-REQ-2):
 * **bold** highlight, *italic*, `code`, ~~strike~~ and [links](url). Anything
 * else reads as a paragraph; malformed input never throws.
 */
import React from "react"
import { Linking, Platform, ScrollView, Text, View, type TextStyle } from "react-native"
import { Tx } from "../windows/TodoWindow/ui/kit"
import { web } from "../windows/TodoWindow/ui/todoFx"
import { F, useTd, type TodoTokens } from "../windows/TodoWindow/ui/tokens"

type Align = "left" | "center" | "right"

// `code` | **bold** | ~~strike~~ | [text](url) | *italic* | _italic_
const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(~~[^~]+?~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*?\*)|(_[^_\s][^_]*?_)/g

/**
 * Inline marks of one run of text. Markers never nest; an unmatched one stays literal.
 * @spec TODOMD-REQ-2
 */
export function inlineNodes(text: string, td: TodoTokens): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text))) {
    const t = m[0]
    const at = m.index
    // `_` inside a word (snake_case) is not emphasis.
    if (m[6] && ((at > 0 && /\w/.test(text[at - 1])) || /\w/.test(text[at + t.length] ?? ""))) {
      INLINE.lastIndex = at + 1
      continue
    }
    if (at > last) out.push(text.slice(last, at))
    const k = out.length
    if (m[1]) {
      out.push(
        <Text
          key={k}
          style={[{ fontFamily: F.mono, backgroundColor: td.wash, borderRadius: 4 }, web({ fontSize: "0.9em", padding: "1px 4px" }) as TextStyle]}
        >
          {t.slice(1, -1)}
        </Text>,
      )
    } else if (m[2]) {
      out.push(
        <Text
          key={k}
          style={[{ color: td.text }, web({ backgroundImage: `linear-gradient(transparent 62%, ${td.tile} 62%)` }) as TextStyle]}
        >
          {t.slice(2, -2)}
        </Text>,
      )
    } else if (m[3]) {
      out.push(
        <Text key={k} style={{ textDecorationLine: "line-through", color: td.text2 }}>
          {t.slice(2, -2)}
        </Text>,
      )
    } else if (m[4]) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t) as RegExpExecArray
      const link =
        Platform.OS === "web"
          ? { href: url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } }
          : { onPress: () => void Linking.openURL(url) }
      out.push(
        <Text key={k} accessibilityRole="link" {...(link as object)} style={[{ color: td.accent }, web({ cursor: "pointer" }) as TextStyle]}>
          {label}
        </Text>,
      )
    } else {
      out.push(
        <Text key={k} style={{ fontStyle: "italic" }}>
          {t.slice(1, -1)}
        </Text>,
      )
    }
    last = at + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function Inline({ text, size, lh, color, align }: { text: string; size: number; lh: number; color?: string; align?: Align }) {
  const td = useTd()
  return (
    <Text style={{ fontFamily: F.sans, fontSize: size, lineHeight: lh, fontWeight: "400", color: color ?? td.text2, textAlign: align }}>
      {inlineNodes(text, td)}
    </Text>
  )
}

const SEP_CELL = /^\s*:?-+:?\s*$/

/**
 * Cells of one pipe-table line: split on unescaped `|`, optional outer pipes.
 * @spec TODOMD-REQ-3
 */
export function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"))
}

function isSeparator(line: string): boolean {
  if (!line.includes("-")) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => SEP_CELL.test(c))
}

/** @spec TODOMD-REQ-3 */
function Table({ head, rows, align }: { head: string[]; rows: string[][]; align: Align[] }) {
  const td = useTd()
  const all = [head, ...rows]
  const cell = (text: string, r: number, c: number) => (
    <View style={{ minWidth: 72, maxWidth: 360 }}>
      <Inline text={text} size={13} lh={18} color={r === 0 ? td.text : td.text2} align={align[c]} />
    </View>
  )
  const rule = (r: number) => (r < all.length - 1 ? { borderBottomWidth: 1, borderBottomColor: td.borderStrong } : {})
  if (Platform.OS === "web") {
    const h = React.createElement
    return h(
      "div",
      { style: { overflowX: "auto", maxWidth: "100%", marginBottom: 10 } },
      h(
        "table",
        { style: { borderCollapse: "collapse", width: "100%" } },
        h(
          "tbody",
          null,
          all.map((row, r) =>
            h(
              "tr",
              { key: r },
              row.map((t, c) =>
                h(r === 0 ? "th" : "td", { key: c, style: { padding: "6px 10px", textAlign: align[c], verticalAlign: "top", fontWeight: 400, borderWidth: 0, ...rule(r), ...(r < all.length - 1 ? { borderBottomStyle: "solid" } : {}) } }, cell(t, r, c)),
              ),
            ),
          ),
        ),
      ),
    )
  }
  return (
    <ScrollView horizontal style={{ marginBottom: 10 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flexGrow: 1 }}>
        {all.map((row, r) => (
          <View key={r} style={[{ flexDirection: "row" }, rule(r)]}>
            {row.map((t, c) => (
              <View key={c} style={{ flex: 1, paddingVertical: 6, paddingHorizontal: 10 }}>
                {cell(t, r, c)}
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

const FENCE = /^```/
const HEAD1 = /^#\s+(.*)$/
const HEADN = /^#{2,6}\s+(.*)$/
const RULE = /^(?:-\s*){3,}$|^(?:\*\s*){3,}$/
const QUOTE = /^>\s?(.*)$/
const TASK = /^[-*+]\s+\[([ xX])\]\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
const NUMBER = /^(\d+)[.)]\s+(.*)$/

type Item = { marker: string; text: string }

/**
 * The viewer. Public API unchanged: `<Markdown source size lh />`.
 * @spec TODOMD-REQ-1
 */
export function Markdown({
  source,
  size = 14,
  lh = 22,
  tight,
}: {
  source: string
  size?: number
  lh?: number
  /** Inline contexts (log entries, TODOMD-REQ-4): no trailing margin after the last block. */
  tight?: boolean
}) {
  const td = useTd()
  const lines = (source ?? "").split("\n")
  const blocks: React.ReactNode[] = []
  const key = () => `b${blocks.length}`
  let list: Item[] = []
  let listKind: "ul" | "ol" | null = null
  let para: string[] = []
  const flushList = () => {
    if (!list.length) return
    const items = list
    list = []
    listKind = null
    blocks.push(
      <View key={key()} style={{ gap: 3, marginTop: 2, marginBottom: 8, paddingLeft: 4 }}>
        {items.map((it, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 8 }}>
            <Tx s={size} lh={lh} c={td.text3} style={{ minWidth: it.marker.length > 2 ? undefined : 10 }}>
              {it.marker}
            </Tx>
            <View style={{ flex: 1 }}>
              <Inline text={it.text} size={size} lh={lh} />
            </View>
          </View>
        ))}
      </View>,
    )
  }
  const flushPara = () => {
    if (!para.length) return
    const text = para.join(" ")
    para = []
    blocks.push(
      <View key={key()} style={{ marginBottom: 8 }}>
        <Inline text={text} size={size} lh={lh} />
      </View>,
    )
  }
  const flush = () => {
    flushList()
    flushPara()
  }
  const pushItem = (kind: "ul" | "ol", item: Item) => {
    flushPara()
    if (listKind && listKind !== kind) flushList()
    listKind = kind
    list.push(item)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    let m: RegExpExecArray | null
    if (!line) {
      flush()
    } else if (FENCE.test(line) && lines.slice(i + 1).some((l) => FENCE.test(l.trim()))) {
      flush()
      const end = lines.findIndex((l, j) => j > i && FENCE.test(l.trim()))
      const code = lines.slice(i + 1, end).join("\n")
      i = end
      blocks.push(
        <View key={key()} style={{ backgroundColor: td.wash, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, marginBottom: 10 }}>
          <Text style={[{ fontFamily: F.mono, fontSize: 12.5, lineHeight: 19, color: td.text2, fontWeight: "400" }, web({ whiteSpace: "pre", overflowX: "auto" }) as TextStyle]}>
            {code}
          </Text>
        </View>,
      )
    } else if ((m = HEAD1.exec(line))) {
      flush()
      blocks.push(
        <Tx key={key()} f="serif" s={22} lh={27} c={td.text} style={{ marginBottom: 8 }}>
          {m[1]}
        </Tx>,
      )
    } else if ((m = HEADN.exec(line))) {
      flush()
      blocks.push(
        <Tx key={key()} f="serif" s={17} lh={22} c={td.text} style={{ marginTop: 16, marginBottom: 6 }}>
          {m[1]}
        </Tx>,
      )
    } else if (RULE.test(line)) {
      flush()
      blocks.push(<View key={key()} style={{ height: 1, backgroundColor: td.borderStrong, marginVertical: 12 }} />)
    } else if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush()
      const head = splitRow(line)
      const n = head.length
      const align = splitRow(lines[i + 1]).map((c): Align => {
        const s = c.trim()
        return s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : "left"
      })
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]))
      i--
      const fit = (r: string[]) => Array.from({ length: n }, (_, c) => r[c] ?? "")
      blocks.push(<Table key={key()} head={head} rows={rows.map(fit)} align={fit(align as string[]) as Align[]} />)
    } else if ((m = QUOTE.exec(line))) {
      flush()
      const q = [m[1]]
      while (i + 1 < lines.length && (m = QUOTE.exec(lines[i + 1].trim()))) {
        q.push(m[1])
        i++
      }
      blocks.push(
        <View key={key()} style={{ borderLeftWidth: 1, borderLeftColor: td.borderStrong, paddingLeft: 12, marginBottom: 8 }}>
          <Inline text={q.filter(Boolean).join(" ")} size={size} lh={lh} color={td.text2} />
        </View>,
      )
    } else if ((m = TASK.exec(line))) {
      pushItem("ul", { marker: m[1] === " " ? "☐︎" : "☑︎", text: m[2] })
    } else if ((m = BULLET.exec(line))) {
      pushItem("ul", { marker: "•", text: m[1] })
    } else if ((m = NUMBER.exec(line))) {
      pushItem("ol", { marker: `${m[1]}.`, text: m[2] })
    } else {
      flushList()
      para.push(line)
    }
  }
  flush()
  return <View style={[{ minWidth: 0 }, tight ? { marginBottom: -8 } : null]}>{blocks}</View>
}
