# Feature: Feature Flags
# Covers: spec.md (REQ-1 to REQ-7, AC-1 to AC-8) + ux.md user-facing scenarios
# Test Writer: Jordan Blake (CTO/CPO) — 2026-04-29

Feature: Feature Flags
  As a Teros administrator
  I want to control feature availability and configuration dynamically
  So that I can enable features for specific users or workspaces without deployments

  Background:
    Given I am authenticated as a user with role "super"
    And the feature flag registry contains:
      | key               | type    | defaultValue |
      | voice.enabled     | boolean | false        |
      | files.max-size-mb | number  | 5000         |
      | onboarding.flow   | string  | v1           |

  # ─────────────────────────────────────────────────────────────────────────────
  # USER-FACING SCENARIOS (Admin Panel)
  # Source: ux.md — reused as-is when they cover an AC
  # Subject: the human admin | Language: business
  # ─────────────────────────────────────────────────────────────────────────────

  # AC-1 — View all registered feature flags
  Scenario: Admin sees all registered feature flags
    When I open the Feature Flags panel
    Then I should see a list of all registered feature flags
    And each flag should show its key, type, description, and default value
    And each flag should show the count of active overrides

  # AC-1 — Flag appears after registry sync
  Scenario: New registry flag appears automatically in the panel
    Given a new flag "chat.history-limit" is added to the code registry
    When the backend synchronizes the registry
    And I open the Feature Flags panel
    Then I should see "chat.history-limit" in the list
    And its default value should match the registry definition

  # AC-2 — Change global default value
  Scenario: Admin changes the global default of a flag
    Given I am viewing the Feature Flags panel
    And the flag "files.max-size-mb" has a default value of 5000
    When I click on "files.max-size-mb"
    And I change the default value to 10000
    And I click "Save"
    Then the default value should be updated to 10000
    And all users without an override should see the new value immediately

  # AC-2 — Reset to registry default
  Scenario: Admin resets a flag to its registry default
    Given I am viewing the flag "files.max-size-mb"
    And the current default value is 10000 (changed from registry)
    When I click "Reset to registry default"
    Then the default value should return to 5000
    And the change should be recorded in the audit log

  # AC-3 — Add a workspace override
  Scenario: Admin adds a workspace override
    Given I am viewing the flag "voice.enabled"
    And "voice.enabled" has no overrides
    When I click "Add Override"
    And I select target type "Workspace"
    And I select "Teros Development"
    And I set the value to true
    And I add the note "Enabled for internal testing"
    And I click "Save"
    Then the override should be created
    And users in workspace "Teros Development" should see the flag as enabled

  # AC-4 — User override takes precedence over workspace
  Scenario: User override wins over workspace override
    Given the flag "voice.enabled" has a workspace override for "work_A" set to true
    And I am viewing the flag "voice.enabled"
    When I click "Add Override"
    And I select target type "User"
    And I select "user_tono"
    And I set the value to false
    And I click "Save"
    Then "user_tono" should receive false when resolving the flag
    And the source should be "user_override"

  # AC-5 — Real-time push on override change
  Scenario: Connected user receives flag update in real time
    Given a user "user_A" is connected in workspace "work_A"
    And "voice.enabled" resolves to false for "user_A"
    When an admin creates a workspace override for "work_A" setting "voice.enabled" to true
    Then "user_A" should receive a feature flag update within 5 seconds
    And "voice.enabled" should resolve to true for "user_A"

  # AC-6 — Type validation on override
  Scenario: Admin cannot save an override with wrong type
    Given I am adding an override for "files.max-size-mb" (type number)
    When I enter "unlimited" as the value
    Then I should see a validation error: "Value must be a number"
    And the "Save" button should be disabled

  # AC-7 — Reset to registry default (verified via audit)
  Scenario: Audit log records flag changes
    Given I have changed "files.max-size-mb" default to 10000
    When I view the audit log for "files.max-size-mb"
    Then I should see an entry for the default value change
    And the entry should show the previous value (5000) and new value (10000)
    And the entry should show my userId and timestamp

  # AC-8 — Non-admin cannot access panel
  Scenario: Regular user cannot access Feature Flags panel
    Given I am authenticated as a user with role "user"
    When I try to open the Feature Flags panel
    Then I should see an access denied message
    And the Feature Flags menu item should not be visible

  # ─────────────────────────────────────────────────────────────────────────────
  # SYSTEM-FACING SCENARIOS
  # Subject: the system / resolution behavior | Language: observable behavior
  # ─────────────────────────────────────────────────────────────────────────────

  Scenario: Flag resolution falls back through hierarchy
    Given the flag "voice.enabled" has:
      | level       | target     | value |
      | default     | global     | false |
      | workspace   | work_A     | true  |
    When a user in workspace "work_A" resolves the flag
    Then the value should be true
    And the source should be "workspace_override"
    When a user in workspace "work_B" resolves the flag
    Then the value should be false
    And the source should be "default"

  Scenario: Flag with no overrides returns default
    Given the flag "onboarding.flow" has no overrides
    When any user resolves the flag
    Then the value should be "v1"
    And the source should be "default"

  Scenario: Non-existent flag returns null
    When a user resolves the flag "does.not.exist"
    Then the result should be null

  Scenario: Override deletion removes override immediately
    Given the flag "voice.enabled" has a workspace override for "work_A" set to true
    When an admin deletes that override
    Then the override should no longer exist
    And users in "work_A" should fall back to the global default

  Scenario: Search filters flags by key
    Given I am viewing the Feature Flags panel
    And the registry contains flags "voice.enabled", "files.max-size-mb", "onboarding.flow"
    When I type "voice" in the search box
    Then I should see only "voice.enabled"
    And "files.max-size-mb" and "onboarding.flow" should be hidden
