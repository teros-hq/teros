Feature: Honest provider-error cards (TER-697)
  As a user whose agent hits an upstream provider error
  I want a warm, honest card that tells me what to do
  So that I am never blamed, never shown raw errors, and always have a next step

  # The failing turn is induced deterministically by intercepting the app's
  # WebSocket (Playwright routeWebSocket) and injecting the exact classified
  # `error` message the backend produces — the same shape asserted by the
  # backend seam test `agent-loop-error-normalization.test.ts`. The REAL app
  # then renders the REAL ProviderErrorWidget, so this verifies the browser layer.

  Background:
    Given the frontend is reachable
    And I am signed in with an open chat

  @ui @ui-provider-errors
  Scenario: Transient capacity error (429) shows a retry card
    When the agent turn fails with a "rate_limited" "provider_capacity" upstream error
    Then I see a "transient" provider-error card
    And the card offers "Retry"
    And the card offers "Change model"

  @ui @ui-provider-errors
  Scenario: Persistent billing error (402) offers change-model, not retry
    When the agent turn fails with a "spend_gate" "provider_billing" upstream error
    Then I see a "persistent" provider-error card
    And the card offers "Change model"
    And the card does not offer "Retry"

  @ui @ui-provider-errors
  Scenario: Model-unavailable error (404) offers change-model, not retry
    When the agent turn fails with a "not_found" "model_unavailable" upstream error
    Then I see a "persistent" provider-error card
    And the card does not offer "Retry"

  @ui @ui-provider-errors
  Scenario: The raw provider message is never shown in the card body
    When the agent turn fails with a "rate_limited" "provider_capacity" upstream error
    Then I see a "transient" provider-error card
    And the raw upstream text is not visible in the card
