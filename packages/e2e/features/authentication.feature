Feature: User authentication
  As a Teros user
  I want to be able to authenticate in the system
  To access the platform's functionalities

  # This lane runs against the embedded TestServer (MockAuthHandler): any
  # well-formed email authenticates and the userId follows the
  # "user:test_<localPart>" convention. Real-credential rejection paths are
  # covered by the against-real-backend lane (src/tests/auth.test.ts).

  Background:
    Given the WebSocket server is available

  @auth @happy-path
  Scenario: Successful login with valid credentials
    When I connect to the WebSocket server
    And I authenticate with email "user1@test.local" and password "user123"
    Then I should receive a response of type "auth_success"
    And I should receive a session token
    And I should receive the userId "user:test_user1"

  @auth @error
  Scenario: Failed login with a malformed email
    When I connect to the WebSocket server
    And I authenticate with email "not-an-email" and password "password123"
    Then I should receive a response of type "auth_error"
    And I should receive an error message

  @auth @token
  Scenario: Authentication with valid token
    Given I am authenticated as "user1@test.local" with password "user123"
    And I save the session token
    When I disconnect from the server
    And I connect to the WebSocket server
    And I authenticate with the saved token
    Then I should receive a response of type "auth_success"
    And I should receive the userId "user:test_user1"

  @auth @token @error
  Scenario: Failed authentication with invalid token
    When I connect to the WebSocket server
    And I authenticate with the token "token-invalido-12345"
    Then I should receive a response of type "auth_error"
