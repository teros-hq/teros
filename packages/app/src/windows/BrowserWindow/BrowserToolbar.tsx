/**
 * BrowserToolbar — the pieces of the Browser window's chrome that both
 * browsers share: the native one inside the Teros desktop shell
 * (NativeBrowserContent, F2/DBAB/DBAC) and the cloud one on plain web
 * (BrowserWindowContent, CLB). Toolbar buttons, the address field with its
 * draft discipline, the suggestion list, the agent-control toggle, the
 * bookmarks of the new-tab page and the field styles.
 *
 * Specs: docs/specs/20261031_desktop-browser-address-bar.md (DBAB),
 * docs/specs/20261031_desktop-browser-agent-control.md (DBAC-REQ-13),
 * docs/specs/20261103_cloud-browser.md (CLB-REQ-9).
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import { Platform, Pressable, type StyleProp, TextInput, type TextStyle, View } from "react-native"
import { FONT_MONO } from "../../components/mca/primitives/fonts"
import { useColors } from "../../components/mca/primitives/useColors"
import { Ph, T } from "../../components/ui/ds"
import type { BrowserSuggestResponse } from "../../services/desktopBridge"
import { buildSuggestionRows, displayUrl, type SuggestionRow } from "./urlUtils"

/** Suggested bookmarks for the empty state — Teros-first (same as Plan A). */
export const BOOKMARKS: { label: string; url: string }[] = [
  { label: "GitHub", url: "https://github.com" },
  { label: "Teros OS", url: "https://raw-os.teros.ai" },
  { label: "Teros", url: "https://os.teros.ai" },
  { label: "Teros Landing", url: "https://teros.ai" },
]

/** Placeholder of the address field (DBAB-REQ-10). */
export const URL_PLACEHOLDER = "Search or enter URL"

/** Debounce of the suggest request after the last edit (DBAB-NFR-2). */
export const SUGGEST_DEBOUNCE_MS = 120

/** Blur is applied after this delay so a click on a suggestion row lands first. */
export const BLUR_GRACE_MS = 120

/**
 * about:blank (the shell primes every tab with it; the cloud tab starts on
 * it too) is "no page yet": the new-tab page stays (DBAB-REQ-10/14).
 */
export function isBlankUrl(url: string | undefined): boolean {
  return !url || url === "about:blank"
}

/** The toolbar's field style and the new-tab page's bigger, centred one. */
export function useBrowserInputStyles(): { inputStyle: TextStyle; newTabInputStyle: TextStyle } {
  const c = useColors()
  const inputStyle: TextStyle = useMemo(
    () => ({
      flex: 1,
      minWidth: 0,
      height: 32,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: c.field,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontFamily: FONT_MONO,
      fontSize: 12,
    }),
    [c.field, c.border, c.text],
  )
  // The start page's field is the page's centre piece: bigger than the
  // toolbar's, text centred (DBAB-REQ-14).
  const newTabInputStyle: TextStyle = useMemo(
    () => ({
      ...inputStyle,
      height: 56,
      fontSize: 17,
      paddingHorizontal: 22,
      borderRadius: 16,
      textAlign: "center",
      fontFamily: undefined,
    }),
    [inputStyle],
  )
  return { inputStyle, newTabInputStyle }
}

/**
 * @spec DBAC-REQ-13 — the agent-control toggle: the ONLY way the user lets
 * agents act in a tab. `consent` is the value shown (optimistic until the
 * browser confirms).
 */
export function ConsentToggle({ consent, onToggle }: { consent: boolean; onToggle: () => void }) {
  const c = useColors()
  return (
    <Pressable
      testID="nbw-consent"
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: consent }}
      accessibilityLabel={consent ? "Agent control on" : "Agent control off"}
      hitSlop={4}
      style={{
        height: 30,
        paddingHorizontal: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 8,
        flexShrink: 0,
        backgroundColor: consent ? c.navActive : "transparent",
        borderWidth: 1,
        borderColor: consent ? c.borderAccent : "transparent",
      }}
    >
      <Ph
        name="robot"
        size={16}
        weight={consent ? "fill" : "regular"}
        color={consent ? c.accent : c.text3}
      />
      <T step="codenote" style={{ color: consent ? c.text : c.text3 }}>
        {consent ? "Agent" : "Agent off"}
      </T>
    </Pressable>
  )
}

/** The bookmark chips of the new-tab page (DBAB-REQ-10). */
export function BookmarkRow({ onOpen }: { onOpen: (url: string) => void }) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
      {BOOKMARKS.map((b) => (
        <Pressable
          key={b.url}
          testID={`nbw-bookmark-${b.label.toLowerCase().replace(/\s+/g, "-")}`}
          onPress={() => onOpen(b.url)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${b.label}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: c.nest,
            borderWidth: 1,
            borderColor: c.border,
          }}
        >
          <Ph name="bookmark-simple" size={13} color={c.text3} />
          <T step="codenote" style={{ color: c.text2 }}>
            {b.label}
          </T>
        </Pressable>
      ))}
    </View>
  )
}

// ─── Toolbar button ─────────────────────────────────────────────────────────

export function ToolBtn({
  icon,
  label,
  onPress,
  disabled,
  testID,
}: {
  icon: string
  label: string
  onPress: () => void
  disabled?: boolean
  testID: string
}) {
  const c = useColors()
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      style={{
        width: 30,
        height: 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        flexShrink: 0,
        opacity: disabled ? 0.35 : 1,
      }}
    >
      <Ph name={icon} size={16} color={disabled ? c.text3 : c.text2} />
    </Pressable>
  )
}

// ─── Suggestions ────────────────────────────────────────────────────────────

export type SuggestFn = (query: string) => Promise<BrowserSuggestResponse | null>

/**
 * @spec DBAB-REQ-11 / DBAB-REQ-13 — the rows for the current draft. Asks
 * the shell (debounced) and discards any answer that is not for the draft
 * that is current when it arrives (a request counter; buildSuggestionRows
 * double-checks the echoed query). Without a suggest function (older
 * shell) the list is row 1 only.
 */
export function useSuggestions(draft: string | null, suggest: SuggestFn | null): SuggestionRow[] {
  const [response, setResponse] = useState<BrowserSuggestResponse | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const q = draft?.trim() ?? ""
    if (!q || !suggest) {
      setResponse(null)
      return
    }
    const id = ++seq.current
    const timer = setTimeout(() => {
      suggest(q)
        .then((res) => {
          if (seq.current === id && res) setResponse(res)
        })
        .catch(() => {
          /* provider trouble is the shell's problem; row 1 still works */
        })
    }, SUGGEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, suggest])
  return useMemo(() => buildSuggestionRows(draft ?? "", response), [draft, response])
}

const ROW_ICON: Record<SuggestionRow["kind"], string> = {
  resolve: "arrow-elbow-down-left",
  history: "clock-counter-clockwise",
  completion: "magnifying-glass",
}

export function SuggestionList({
  rows,
  highlight,
  onHighlight,
  onPick,
  testID,
}: {
  rows: SuggestionRow[]
  highlight: number
  onHighlight: (index: number) => void
  onPick: (row: SuggestionRow) => void
  testID: string
}) {
  const c = useColors()
  return (
    <View testID={testID} accessibilityRole="list" style={{ paddingVertical: 4 }}>
      {rows.map((row, i) => {
        const active = i === highlight
        const goesToUrl = row.kind === "resolve" && row.detail.startsWith("Go to")
        return (
          <Pressable
            key={`${row.kind}:${row.url}`}
            testID={`${testID}-${i}`}
            accessibilityRole="button"
            accessibilityLabel={`${row.label} — ${row.detail}`}
            accessibilityState={{ selected: active }}
            // @ts-expect-error dataSet is web-only (→ data-highlighted), used by tests and styling hooks
            dataSet={{ highlighted: active ? "true" : "false" }}
            onPress={() => onPick(row)}
            onHoverIn={() => onHighlight(i)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 8,
              backgroundColor: active ? c.navActive : "transparent",
            }}
          >
            <Ph
              name={goesToUrl ? "globe" : ROW_ICON[row.kind]}
              size={14}
              color={active ? c.text : c.text3}
            />
            <T step="sm" style={{ color: c.text, flexShrink: 1 }} numberOfLines={1}>
              {row.label}
            </T>
            <T step="codenote" tone="text3" numberOfLines={1} style={{ flexShrink: 1 }}>
              {row.detail}
            </T>
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── Address field ──────────────────────────────────────────────────────────

export interface UrlFieldHandle {
  focus(): void
}

interface UrlFieldProps {
  /** The tab's live URL ('' in the empty state). Shown in display form while not editing. */
  liveUrl: string
  /**
   * Enter / picking: `row` is the highlighted suggestion (null when there is
   * none) — the parent decides between navigating the row and resolving the
   * draft as typed.
   */
  onSubmit: (draft: string, row: SuggestionRow | null) => void
  /** The typed draft while editing, null once editing ends (DBAB-REQ-11). */
  onDraftChange: (draft: string | null) => void
  rows: SuggestionRow[]
  highlight: number
  onMoveHighlight: (delta: number) => void
  autoFocus?: boolean
  testID: string
  style: StyleProp<TextStyle>
}

/**
 * The address field (DBAB-REQ-3/4/5/6/12). Owns its draft: while focused it
 * holds the full URL (selected on focus) and whatever the user types; while
 * not focused it mirrors `liveUrl` in display form. A state push can
 * therefore never clobber a draft — it only changes what the field shows
 * once editing ends. The suggestion list itself is rendered by the parent
 * (it must sit in the layout, see the file header); the field drives it.
 */
export const UrlField = forwardRef<UrlFieldHandle, UrlFieldProps>(function UrlField(
  { liveUrl, onSubmit, onDraftChange, rows, highlight, onMoveHighlight, autoFocus, testID, style },
  ref,
) {
  const c = useColors()
  const inputRef = useRef<TextInput | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const liveUrlRef = useRef(liveUrl)
  liveUrlRef.current = liveUrl
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const node = () => inputRef.current as unknown as HTMLInputElement | null

  useImperativeHandle(ref, () => ({ focus: () => node()?.focus() }), [])

  const endEditing = useCallback(() => {
    setEditing(false)
    onDraftChange(null)
  }, [onDraftChange])

  // @spec DBAB-REQ-3 — on focus the field holds the FULL live URL and
  // selects it. The selection is made after React has committed the new
  // value (an effect, plus Safari's required timeout); the mouse-up that
  // follows a click-to-focus would collapse it, so it is swallowed once.
  // The selected live URL is not a draft yet: the list appears once the
  // user types (DBAB-REQ-11).
  const onFocus = useCallback(() => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current)
      blurTimer.current = null
    }
    setDraft(liveUrlRef.current)
    setEditing(true)
    const el = node()
    if (!el || Platform.OS !== "web") return
    const swallow = (ev: Event) => ev.preventDefault()
    el.addEventListener("mouseup", swallow, { once: true })
    setTimeout(() => el.removeEventListener("mouseup", swallow), 400)
  }, [])

  useEffect(() => {
    if (!editing) return
    const el = node()
    if (!el || typeof el.select !== "function") return
    el.select()
    const t = setTimeout(() => {
      if (typeof document !== "undefined" && document.activeElement === el) el.select()
    }, 0)
    return () => clearTimeout(t)
  }, [editing])

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current)
    },
    [],
  )

  // @spec DBAB-REQ-5 — blur discards the draft (the field goes back to
  // mirroring the live URL); Escape is "blur now". Blur waits a beat so a
  // click on a suggestion row is processed before the list goes away.
  const onBlur = useCallback(() => {
    if (blurTimer.current) clearTimeout(blurTimer.current)
    blurTimer.current = setTimeout(() => {
      blurTimer.current = null
      endEditing()
    }, BLUR_GRACE_MS)
  }, [endEditing])

  const onChangeText = useCallback(
    (text: string) => {
      setDraft(text)
      onDraftChange(text)
    },
    [onDraftChange],
  )

  // @spec DBAB-REQ-12 — ArrowDown / ArrowUp move the highlight; Escape ends editing.
  const onKeyPress = useCallback(
    (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
      const key = e.nativeEvent.key
      if (key === "Escape") {
        endEditing()
        node()?.blur()
        return
      }
      if (key === "ArrowDown" || key === "ArrowUp") {
        if (rows.length === 0) return
        e.preventDefault?.()
        onMoveHighlight(key === "ArrowDown" ? 1 : -1)
      }
    },
    [endEditing, onMoveHighlight, rows.length],
  )

  const submit = useCallback(() => {
    const row = rows[highlight] ?? null
    endEditing()
    onSubmit(draft, row)
  }, [draft, rows, highlight, endEditing, onSubmit])

  return (
    <TextInput
      ref={inputRef}
      testID={testID}
      value={editing ? draft : displayUrl(liveUrl)}
      onChangeText={onChangeText}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyPress={onKeyPress}
      onSubmitEditing={submit}
      autoFocus={autoFocus}
      placeholder={URL_PLACEHOLDER}
      placeholderTextColor={c.text3}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      keyboardType="url"
      inputMode="url"
      enterKeyHint="go"
      accessibilityLabel="URL"
      style={style}
    />
  )
})
