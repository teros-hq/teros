Feature: User authentication
  As a Teros user
  I want to be able to authenticate in the system
  To access the platform's functionalities

  Background:
    Given the WebSocket server is available

  @auth @happy-path
  Scenario: Successful login with valid credentials
    When I connect to the WebSocket server
    And I authenticate with email "user1@test.local" and password "user123"
    Then I should receive a response of type "auth_success"
    And I should receive a session token
    And I should receive the userId "user_user1"

  @auth @error
  Scenario: Failed login with incorrect password
    When I connect to the WebSocket server
    And I authenticate with email "user1@test.local" and password "wrongpassword"
    Then I should receive a response of type "auth_error"
    And I should receive an error message

  @auth @error
  Scenario: Failed login with non-existent user
    When I connect to the WebSocket server
    And I authenticate with email "noexiste@test.local" and password "password123"
    Then I should receive a response of type "auth_error"

  @auth @token
  Scenario: Authentication with valid token
    Given I am authenticated as "user1@test.local" with password "user123"
    And I save the session token
    When I disconnect from the server
    And I connect to the WebSocket server
    And I authenticate with the saved token
    Then I should receive a response of type "auth_success"
    And I should receive the userId "user_user1"

  @auth @token @error
  Scenario: Failed authentication with invalid token
    When I connect to the WebSocket server
    And I authenticate with the token "token-invalido-12345"
    Then I should receive a response of type "auth_error"
