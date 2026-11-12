import type React from "react"
import { useFeatureFlag } from "../../hooks/useFeatureFlag"
import { Navbar } from "../Navbar"
import { NavbarV2 } from "./NavbarV2"

type ShellProps = React.ComponentProps<typeof Navbar>

/** Flag switch: `navbar_v2` off (default) → current Navbar untouched; on → NavbarV2. */
export function NavbarShell(props: ShellProps) {
  const v2 = useFeatureFlag<boolean>("navbar_v2")
  return v2 === true ? <NavbarV2 {...props} /> : <Navbar {...props} />
}
