# Feature: Onboarding Wizard
# Covers: spec.md (REQ-1 to REQ-13, AC-1 to AC-10) + ux.md user-facing scenarios
# Test Writer: Nira Solana — 2026-03-30
# Updated 2026-06-30: onboarding simplified to welcome → agent → apps → access →
#   done. The Provider, Plan and Payment steps were removed — every user runs on
#   the Teros model by default and is provisioned the Basic (Starter) plan at
#   signup. BYOK providers and plan upgrades live in their own windows.

Feature: Onboarding Wizard
  As a new Teros user
  I want to be guided through initial setup
  So that I can have my first useful conversation in under 5 minutes

  Background:
    Given I have accepted the Terms & Conditions
    And I have not completed onboarding yet

  # ─────────────────────────────────────────────────────────────────────────────
  # USER-FACING SCENARIOS
  # Source: ux.md §5 — reused as-is when they cover an AC
  # Subject: the human user | Language: business
  # ─────────────────────────────────────────────────────────────────────────────

  # AC-1 — Wizard always starts at step 0
  Scenario: New user is taken to the onboarding wizard
    When I navigate to the Teros workspace
    Then I should see the onboarding wizard
    And I should be on the Welcome step

  # Simplified flow — no provider / plan / payment steps
  Scenario: Onboarding does not ask the user to pick a provider or a plan
    When I go through the onboarding wizard
    Then I should only see the Welcome, Agent, Apps, Access and Done steps
    And I should not be asked to connect an AI provider
    And I should not be asked to choose or pay for a plan

  Scenario: The user can start chatting on the Teros model without any setup
    Given I have not configured any AI provider
    When I complete onboarding
    Then my agent should be ready to chat on the Teros model by default

  # AC-4 — Skip goes to Done
  Scenario: Skipping the Agent step goes directly to Done
    Given I am on the Agent step
    When I click Skip
    Then I should be taken directly to the Done step

  Scenario: Skipping the Apps step goes directly to Done
    Given I am on the Apps step
    When I click Skip
    Then I should be taken directly to the Done step

  Scenario: Skipping the Access step goes directly to Done
    Given I am on the Access step
    When I click Skip
    Then I should be taken directly to the Done step

  # AC-5 — No render flash on load
  Scenario: Wizard renders fully formed without flashing
    When the onboarding wizard loads
    Then the first step should appear only after the initial data has loaded
    And no step should be shown while data is still being fetched

  # AC-6 — Agent avatar always visible
  Scenario: Agent avatar is visible on every step
    Given I am going through the onboarding wizard
    When I am on any step
    Then I should see the agent's avatar at the top of the screen

  # AC-7 — Responsive card on desktop
  Scenario: Wizard appears as a centered card on large screens
    Given my screen is wider than 768 pixels
    When I open the onboarding wizard
    Then the wizard content should appear as a centered card
    And the background behind the card should be visible

  # AC-9 — App icons shown
  Scenario: App options show their official icons
    When I am on the Apps step
    Then each app card should show its official icon

  # AC-10 — Completion navigates to workspace
  Scenario: Clicking "Start chatting" completes onboarding
    Given I am on the Done step
    When I click "Start chatting"
    Then I should be taken to the Teros workspace
    And the onboarding wizard should not appear again

  # Navigation — Back button (REQ-11)
  Scenario: Back button returns to previous step
    Given I have navigated to the Apps step
    When I click Back
    Then I should return to the Agent step

  Scenario: Back button is shown on the Agent step
    When I am on the Agent step
    Then I should see a Back button

  Scenario: Back button is not shown on the Done step
    When I am on the Done step
    Then I should not see a Back button

  # REQ-2 — Access step auto-skip when no apps installed
  Scenario: Access step is skipped when no apps are installed
    Given I have not installed any apps
    When I continue from the Apps step
    Then I should be taken directly to the Done step
    And I should not see the Access step

  # REQ-10 — Progress indicator always visible
  Scenario: Progress indicator shows current step
    When I am on any step of the onboarding wizard
    Then I should see a progress indicator showing which step I am on
    And the current step should be visually highlighted

  # ─────────────────────────────────────────────────────────────────────────────
  # SYSTEM-FACING SCENARIOS
  # Subject: the system | Language: observable behavior, no implementation details
  # ─────────────────────────────────────────────────────────────────────────────

  # AC-1 — Redirect enforcement
  Scenario: User with pending onboarding is redirected from workspace
    Given a user has accepted the Terms & Conditions
    And that user has not completed onboarding
    When the user accesses the workspace
    Then the system redirects them to the onboarding wizard
    And the wizard starts at the Welcome step

  # Plan provisioning — every signup gets the Basic (Starter) plan
  Scenario: A new user is provisioned the Basic plan at signup
    Given a new user signs up
    When the account is created
    Then the system creates an active Basic (Starter) subscription for that user
    And that subscription includes the Teros model

  # AC-5 — Single data load before first render
  Scenario: All required data is available before the first step appears
    Given the wizard is initialising
    When the initial data finishes loading
    Then the first step renders with the agent and apps information already present
    And no step is shown while data is still being fetched

  # AC-5 — Loading state shown during data fetch
  Scenario: A loading indicator is shown while the wizard fetches initial data
    When the onboarding wizard starts loading
    Then a full-screen loading indicator is visible
    And no wizard step is rendered until loading completes

  # AC-5 / Load error path — error state with retry
  Scenario: A retry option is shown when initial data cannot be loaded
    Given the initial data fetch fails
    When the wizard attempts to load
    Then a full-screen error state is shown
    And a retry option is available
    And no wizard step is rendered

  # AC-6 — Avatar fallback when no image is available
  Scenario: Agent initials are shown when no avatar image is available
    Given the default agent has no avatar image configured
    When any step of the onboarding wizard is rendered
    Then a placeholder showing the agent's initials is visible at the top of the step

  # AC-10 — Onboarding completion is persisted
  Scenario: Onboarding completion is recorded when the user starts chatting
    Given the user is on the Done step
    When the user clicks "Start chatting"
    Then the system records that onboarding has been completed for that user
    And subsequent access to the workspace does not redirect to the wizard

  # REQ-4 — No session persistence across page reloads
  Scenario: Wizard always starts at step 0 after a page reload
    Given a user was previously on the Agent step during onboarding
    When the user reloads the page and navigates to the workspace
    Then the wizard starts again at the Welcome step
    And no previous wizard progress is restored

  # REQ-13 — Step 1 asks the user about themselves, not the agent
  Scenario: Agent introduction step collects user context
    Given I am on the Agent step
    When the step is displayed
    Then I should be asked what I will use Teros for
    And I should be offered a way to provide my preferred name
    And I should not be asked to configure the agent's settings

  # REQ-2 — Access step auto-skip when user clicked Continue on Apps with zero installs
  Scenario: Access step is bypassed when the user continues from Apps without installing anything
    Given I am on the Apps step
    And I have not installed any apps during this session
    When I click Continue
    Then I should be taken directly to the Done step
    And the Access step should not be shown


# ─────────────────────────────────────────────────────────────────────────────
# COVERAGE MATRIX
# Maps each Acceptance Criterion to the scenario(s) that cover it
# ─────────────────────────────────────────────────────────────────────────────
#
# AC-1  | "New user is taken to the onboarding wizard"
#       | "User with pending onboarding is redirected from workspace"
#
# Simplified flow | "Onboarding does not ask the user to pick a provider or a plan"
#       | "The user can start chatting on the Teros model without any setup"
#       | "A new user is provisioned the Basic plan at signup"
#
# AC-4  | "Skipping the Agent step goes directly to Done"
#       | "Skipping the Apps step goes directly to Done"
#       | "Skipping the Access step goes directly to Done"
#
# AC-5  | "Wizard renders fully formed without flashing"
#       | "All required data is available before the first step appears"
#       | "A loading indicator is shown while the wizard fetches initial data"
#       | "A retry option is shown when initial data cannot be loaded"
#
# AC-6  | "Agent avatar is visible on every step"
#       | "Agent initials are shown when no avatar image is available"
#
# AC-7  | "Wizard appears as a centered card on large screens"
#
# AC-9  | "App options show their official icons"
#
# AC-10 | "Clicking 'Start chatting' completes onboarding"
#       | "Onboarding completion is recorded when the user starts chatting"
#
# ── Additional coverage (REQs not expressed as ACs but testable) ──────────────
#
# REQ-2  (auto-skip access) | "Access step is skipped when no apps are installed"
#                           | "Access step is bypassed when the user continues from Apps without installing anything"
#
# REQ-4  (no persistence)   | "Wizard always starts at step 0 after a page reload"
#
# REQ-10 (progress bar)     | "Progress indicator shows current step"
#
# REQ-11 (back navigation)  | "Back button returns to previous step"
#                           | "Back button is shown on the Agent step"
#                           | "Back button is not shown on the Done step"
#
# REQ-13 (step 1 = user)    | "Agent introduction step collects user context"
#
# Error path                | "A retry option is shown when initial data cannot be loaded"
#
# NOTE: AC-2/AC-3/AC-8 (provider step: pre-filled state, blocking without a
#   provider, provider logos) were RETIRED when the Provider step was removed.
# ─────────────────────────────────────────────────────────────────────────────
