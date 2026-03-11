Feature: Conversation channel management
  As an authenticated Teros user
  I want to be able to create and manage conversation channels
  To interact with AI agents

  Background:
    Given the WebSocket server is available
    And I am authenticated as "user1@test.local" with password "user123"

  @channels @create
  Scenario: Create a new conversation channel
    When I create a channel with the agent "agent_e2e_assistant"
    Then I should receive a response of type "channel_created"
    And the channel should have an ID starting with "ch_"
    And the channel should be associated with the agent "agent_e2e_assistant"

  @channels @list
  Scenario: List user channels
    Given I have created a channel with the agent "agent_e2e_assistant"
    When I request the list of channels
    Then I should receive a response of type "channels_list"
    And the list should contain at least 1 channel

  @channels @close
  Scenario: Close an existing channel
    Given I have created a channel with the agent "agent_e2e_assistant"
    And I reconnect to the server
    When I close the channel
    Then I should receive a channel deleted notification
