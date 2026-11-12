/**
 * Pure rules of the password-reset screens: what counts as the emailed code
 * and when a new password can be submitted. Kept out of the components so the
 * screens only render what these functions say.
 *
 * @spec PWR-REQ-7 PWR-REQ-9
 */

export const RESET_CODE_LENGTH = 6
export const MIN_PASSWORD_LENGTH = 8

/**
 * The code inside whatever the user typed or pasted: its digits, at most six.
 * A pasted "123 456" or "Your code: 123456" still yields the code.
 * @spec PWR-REQ-7
 */
export function codeFromInput(input: string): string {
  return input.replace(/\D/g, "").slice(0, RESET_CODE_LENGTH)
}

export type RuleState = "pending" | "met" | "failed"

export interface PasswordRules {
  /** Characters typed so far, for the "7/8" counter. */
  length: number
  minLength: RuleState
  match: RuleState
  canSubmit: boolean
}

/**
 * State of each rule for the two password entries. A rule is "pending" until
 * the user has typed something it can be judged on.
 * @spec PWR-REQ-9
 */
export function passwordRules(password: string, confirmation: string): PasswordRules {
  const minLength: RuleState =
    password.length === 0 ? "pending" : password.length >= MIN_PASSWORD_LENGTH ? "met" : "failed"
  const match: RuleState =
    confirmation.length === 0 ? "pending" : confirmation === password ? "met" : "failed"
  return {
    length: password.length,
    minLength,
    match,
    canSubmit: minLength === "met" && match === "met",
  }
}
