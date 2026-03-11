# app - Use Cases

**Package**: `@teros/app`  
**Purpose**: Behavioral specifications using Gherkin syntax

---

## UC-1: User Login

```gherkin
Feature: User Login
  As a user
  I want to login with my credentials
  So that I can access my conversations

Scenario: Successful login
  Given I am on the login screen
  And a user exists with email "alice@example.com" and password "SecurePass123!"
  When I enter email "alice@example.com"
  And I enter password "SecurePass123!"
  And I tap "Login"
  Then I am authenticated successfully
  And I receive a JWT token
  And the token is stored in secure storage
  And I am redirected to the conversation list
  And I see my active conversations

Scenario: Login with incorrect password
  Given I am on the login screen
  When I enter email "alice@example.com"
  And I enter incorrect password
  And I tap "Login"
  Then I see error message "Invalid credentials"
  And I remain on the login screen
  And no token is stored

Scenario: Login with network error
  Given I am on the login screen
  And the backend is unavailable
  When I tap "Login"
  Then I see error message "Unable to connect. Please try again."
  And I remain on the login screen

Scenario: Session persistence
  Given I logged in previously
  And my session is still valid
  When I open the app
  Then I am automatically logged in
  And I am taken directly to conversation list
  And I do not see the login screen
```

---

## UC-2: View Conversation List

```gherkin
Feature: Conversation List
  As a logged-in user
  I want to see my conversations
  So that I can continue or start new chats

Scenario: View active conversations
  Given I am logged in as "alice@example.com"
  And I have 3 active conversations
  When I view the conversation list
  Then I see all 3 conversations
  And each shows agent name, avatar, and last message
  And conversations are sorted by most recent
  And I see timestamps for each conversation

Scenario: Empty conversation list
  Given I am logged in
  And I have no conversations
  When I view the conversation list
  Then I see "No conversations yet"
  And I see a "New Conversation" button
  And I see a list of available agents

Scenario: Search conversations
  Given I have 20 conversations
  When I enter "project" in search box
  Then I see only conversations containing "project"
  And results are filtered in real-time
  And I can clear search to see all conversations

Scenario: Pull to refresh
  Given I am viewing conversation list
  When I pull down to refresh
  Then the conversation list is reloaded from backend
  And new messages are fetched
  And the list is updated
```

---

## UC-3: Start New Conversation

```gherkin
Feature: New Conversation
  As a user
  I want to start a conversation with an agent
  So that I can get help or chat

Scenario: Select agent and start conversation
  Given I am on the conversation list
  When I tap "New Conversation"
  Then I see a list of available agents
  And each agent shows name, avatar, and description
  When I tap on "Alice" agent
  Then a new conversation is created
  And I am taken to the chat screen
  And I can start sending messages
  And the conversation appears in my list

Scenario: Filter agents by capability
  Given I am selecting an agent
  When I filter by "Code Assistant"
  Then I see only agents with code capabilities
  And other agents are hidden

Scenario: Cancel agent selection
  Given I am selecting an agent
  When I tap "Cancel" or back button
  Then I return to conversation list
  And no conversation is created
```

---

## UC-4: Send and Receive Messages

```gherkin
Feature: Messaging
  As a user
  I want to exchange messages with agents
  So that I can have conversations

Scenario: Send text message
  Given I am in a conversation with Alice
  When I type "Hello, Alice!" in the message input
  And I tap "Send"
  Then my message appears in the chat with sending status
  And the message is sent via WebSocket
  And the status changes to sent (✓)
  And then to delivered (✓✓) when acknowledged
  And the input is cleared

Scenario: Receive agent response
  Given I sent a message to Alice
  When Alice processes and responds
  Then I see typing indicator "Alice is typing..."
  And after a moment, the typing indicator disappears
  And Alice's message appears in the chat
  And the message includes timestamp
  And I receive a notification if app is backgrounded

Scenario: Send message while offline
  Given I am in a conversation
  And my device is offline
  When I send a message
  Then the message is queued locally
  And it shows "Pending" status
  When connection is restored
  Then the message is sent automatically
  And status updates to sent

Scenario: Render markdown in messages
  Given Alice sends a message with markdown
  And the message contains **bold**, *italic*, and code blocks
  When the message is displayed
  Then markdown is rendered correctly
  And code blocks are syntax-highlighted
  And links are clickable
```

---

## UC-5: Real-Time Updates via WebSocket

```gherkin
Feature: WebSocket Real-Time
  As a user
  I want to receive messages instantly
  So that conversations feel natural

Scenario: Establish WebSocket connection
  Given I am logged in
  When the app opens a conversation
  Then it establishes WebSocket connection to backend
  And it subscribes to my user channel
  And it listens for incoming messages

Scenario: Receive message while in conversation
  Given I am viewing conversation with Alice
  And WebSocket is connected
  When Alice sends a message
  Then I receive the message via WebSocket
  And the message appears immediately in chat
  And I see no loading spinner

Scenario: WebSocket disconnection
  Given WebSocket is connected
  When connection drops (network issue)
  Then I see "Reconnecting..." indicator
  And the app attempts to reconnect
  When connection is restored
  Then I see "Connected" briefly
  And any missed messages are fetched

Scenario: Receive message for different conversation
  Given I am in conversation with Alice
  When I receive a message for conversation with Bob
  Then Bob's conversation shows unread badge
  And I see a subtle notification
  And the message does not interrupt Alice conversation
```

---

## UC-6: Typing Indicators

```gherkin
Feature: Typing Indicators
  As a user
  I want to see when the agent is typing
  So that I know my message is being processed

Scenario: Agent starts typing
  Given I sent a message to Alice
  When Alice starts processing the message
  Then I receive "typing.start" event via WebSocket
  And I see "Alice is typing..." below the last message
  And I see animated dots (...)

Scenario: Agent stops typing
  Given Alice is typing
  When Alice sends her response
  Then I receive "typing.stop" event
  And the typing indicator disappears
  And Alice's message appears

Scenario: Typing timeout
  Given Alice started typing 30 seconds ago
  But no message arrived
  When 30 seconds elapse
  Then the typing indicator disappears automatically
  And I can send another message
```

---

## UC-7: Message Status Indicators

```gherkin
Feature: Message Status
  As a user
  I want to see message delivery status
  So that I know if my messages were received

Scenario: Message sending
  Given I send a message
  When the message is being sent
  Then I see a clock icon (⏱️) or "Sending..."
  And the message is slightly grayed out

Scenario: Message sent
  Given my message was sent to backend
  When backend acknowledges receipt
  Then I see single checkmark (✓)
  And the message is normal opacity

Scenario: Message delivered
  Given my message was sent
  When the agent acknowledges receipt
  Then I see double checkmark (✓✓)
  And I know the agent received it

Scenario: Message failed
  Given I send a message
  When sending fails (network error)
  Then I see error icon (⚠️)
  And I see "Tap to retry"
  When I tap the message
  Then it retries sending
```

---

## UC-8: Archive Conversation

```gherkin
Feature: Archive Conversation
  As a user
  I want to archive old conversations
  So that my conversation list stays clean

Scenario: Archive a conversation
  Given I am viewing conversation list
  When I swipe left on a conversation
  And I tap "Archive"
  Then the conversation is moved to archived
  And it disappears from active list
  And I see "Conversation archived" confirmation

Scenario: View archived conversations
  Given I have archived conversations
  When I tap "Archived" tab or filter
  Then I see all archived conversations
  And I can open and read them
  And I can send new messages (unarchives automatically)

Scenario: Unarchive conversation
  Given I am viewing archived conversations
  When I swipe left on a conversation
  And I tap "Unarchive"
  Then the conversation returns to active list
  And I see "Conversation unarchived" confirmation
```

---

## UC-9: Delete Conversation

```gherkin
Feature: Delete Conversation
  As a user
  I want to delete conversations
  So that I can remove unwanted chats

Scenario: Delete conversation with confirmation
  Given I am viewing conversation list
  When I swipe left on a conversation
  And I tap "Delete"
  Then I see confirmation dialog "Delete this conversation?"
  When I tap "Delete" in dialog
  Then the conversation is deleted from backend
  And it is removed from the list
  And I see "Conversation deleted"

Scenario: Cancel delete
  Given I see the delete confirmation dialog
  When I tap "Cancel"
  Then the dialog closes
  And the conversation is not deleted
  And it remains in the list

Scenario: Delete active conversation
  Given I am inside a conversation with Alice
  When I tap menu and select "Delete Conversation"
  And I confirm deletion
  Then the conversation is deleted
  And I am returned to conversation list
```

---

## UC-10: Logout

```gherkin
Feature: Logout
  As a user
  I want to logout
  So that I can protect my privacy

Scenario: Successful logout
  Given I am logged in
  When I tap "Logout" in settings or menu
  Then my session token is removed from storage
  And WebSocket connection is closed
  And I am redirected to login screen
  And all conversation data is cleared from memory

Scenario: Logout with pending messages
  Given I have unsent messages queued
  When I attempt to logout
  Then I see warning "You have unsent messages"
  And I can choose to wait or logout anyway
  When I choose "Logout anyway"
  Then unsent messages are discarded
  And logout completes
```

---

*Last updated: 2024-12-07*
