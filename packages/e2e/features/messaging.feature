Feature: Sending and receiving messages
  As an authenticated Teros user
  I want to be able to send messages to agents
  To get responses and assistance

  Background:
    Given the WebSocket server is available
    And I am authenticated as "user1@test.local" with password "user123"
    And I have created a channel with the agent "agent_e2e_assistant"

  @messaging @send
  Scenario: Send a message and receive confirmation
    When I send the message "Hola, how are you?"
    Then I should receive a message sent confirmation
    And the confirmation should include a message ID

  @messaging @history
  Scenario: Get message history from a new channel
    When I request the message history
    Then I should receive a response of type "messages_history"
    And the history should be a list

  @messaging @typing
  Scenario: Receive typing indicator when sending a message
    Given I reconnect to the server
    When I send the message "Hola!"
    Then I should receive a typing notification or send confirmation
