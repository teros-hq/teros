// Vitest stub for `phosphor-react-native` (1000+ Flow/SVG modules hang jsdom).
// The web build never imports it (ds/Icon.web.tsx draws font glyphs); the
// native `ds/Icon.tsx` is the only consumer. Exposes a Proxy so any
// `<NameIcon />` resolves to a no-op component.
import React from "react"
const Noop = () => null
export default new Proxy({}, { get: () => Noop })
