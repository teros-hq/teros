Feature: Realtime cross-user broadcasts
  As a workspace member
  I want to receive realtime events triggered by other members
  So that my UI stays in sync without polling

  Background:
    Given the WebSocket server is available

  @realtime @cross-user
  Scenario: A member receives project.created when another member creates a project
    Given user A is authenticated as "user1@test.com"
    And user B is authenticated as "user2@test.com"
    And user A has a workspace named "Shared Workspace" with user B as member
    And user B is waiting for a "project.created" event
    When user A creates a project named "Roadmap Q3" in the workspace
    Then the request should succeed for user A
    And user B receives the "project.created" event for the project "Roadmap Q3"

  @realtime @cross-user @isolation
  Scenario: A non-member does NOT receive workspace broadcasts
    Given user A is authenticated as "user1@test.com"
    And user B is authenticated as "user2@test.com"
    And user A has a workspace named "Private Workspace" without user B
    And user B is waiting for a "project.created" event
    When user A creates a project named "Secreto" in the workspace
    Then the request should succeed for user A
    And user B does NOT receive the event within 1500 ms
