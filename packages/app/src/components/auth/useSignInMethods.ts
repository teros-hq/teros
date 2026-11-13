/**
 * useSignInMethods — the sign-in methods the backend offers, for the sign-in
 * and sign-up screens. `null` until the backend has answered (or failed, which
 * counts as email and password only).
 *
 * @spec SIGNM-REQ-7
 */
import { useEffect, useState } from "react"
import { backendUrl } from "../../config/runtime"
import { fetchSignInMethods, type SignInMethods } from "../../lib/sign-in-methods"

export function useSignInMethods(): SignInMethods | null {
  const [methods, setMethods] = useState<SignInMethods | null>(null)
  useEffect(() => {
    let alive = true
    fetchSignInMethods(backendUrl()).then((answer) => {
      if (alive) setMethods(answer)
    })
    return () => {
      alive = false
    }
  }, [])
  return methods
}
