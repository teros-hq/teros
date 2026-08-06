Feature: Smoke — server is reachable and auth works
  As a developer
  I want to verify the test server starts and accepts connections
  So that the Cucumber infrastructure is confirmed working

  Background:
    Given the WebSocket server is available

  @smoke
  Scenario: Server responds to health check
    Then the HTTP health endpoint should return OK

  @smoke
  Scenario: Successful login with valid credentials
    When I connect to the WebSocket server
    And I authenticate with email "test@example.com" and password "password"
    Then I should receive a response of type "auth_success"
    And I should receive a session token

  @smoke
  Scenario: Rejected login with invalid email
    When I connect to the WebSocket server
    And I authenticate with email "not-an-email" and password "password"
    Then I should receive a response of type "auth_error"
