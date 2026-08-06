Feature: Sanity — backend real is reachable and login works
  As a developer
  I want to verify the backend is up and accepts logins
  So that I know the deployment is healthy

  Background:
    Given the backend is reachable

  @sanity
  Scenario: Health check passes
    Then the HTTP health endpoint should return OK

  @sanity
  Scenario: Login with valid credentials
    When I connect to the WebSocket server
    And I authenticate with email "admin@test.local" and password "admin123"
    Then I should receive a response of type "auth_success"
    And I should receive a session token

  @sanity
  Scenario: Login with invalid credentials is rejected
    When I connect to the WebSocket server
    And I authenticate with email "admin@test.local" and password "wrongpassword"
    Then I should receive a response of type "auth_error"
