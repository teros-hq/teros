import { Given, Then, When } from "@cucumber/cucumber"
import { expect } from "chai"
import { E2E_CONFIG } from "../../src/fixtures/test-data"
import type { CustomWorld } from "../support/world"

// ============================================================================
// GIVEN - Preconditions
// ============================================================================

Given("the WebSocket server is available", async function (this: CustomWorld) {
  const response = await fetch(`${E2E_CONFIG.httpUrl}/health`)
  expect(response.ok).to.be.true
})

Given(
  "I am authenticated as {string} with password {string}",
  async function (this: CustomWorld, email: string, password: string) {
    await this.createClient()
    this.lastResponse = await this.client!.authenticate(email, password)
    expect(this.lastResponse.type).to.equal("auth_success")
    this.sessionToken = this.lastResponse.sessionToken
    this.userId = this.lastResponse.userId
  },
)

Given("I save the session token", function (this: CustomWorld) {
  expect(this.sessionToken).to.not.be.null
})

Given(
  "I have created a channel with the agent {string}",
  async function (this: CustomWorld, agentId: string) {
    const response = await this.client!.sendAndWait({ type: "create_channel", agentId }, [
      "channel_created",
      "error",
    ])
    expect(response.type).to.equal("channel_created")
    this.channelId = response.channelId
  },
)

Given("I reconnect to the server", async function (this: CustomWorld) {
  const savedToken = this.sessionToken
  const savedChannelId = this.channelId

  await this.client!.disconnect()
  await this.createClient()

  this.lastResponse = await this.client!.authenticateWithToken(savedToken!)
  expect(this.lastResponse.type).to.equal("auth_success")

  this.sessionToken = savedToken
  this.channelId = savedChannelId
})

// ============================================================================
// WHEN - Actions
// ============================================================================

When("I connect to the WebSocket server", async function (this: CustomWorld) {
  await this.createClient()
  expect(this.client!.isConnected()).to.be.true
})

When(
  "I authenticate with email {string} and password {string}",
  async function (this: CustomWorld, email: string, password: string) {
    this.lastResponse = await this.client!.authenticate(email, password)
  },
)

When("I authenticate with the saved token", async function (this: CustomWorld) {
  expect(this.sessionToken).to.not.be.null
  this.lastResponse = await this.client!.authenticateWithToken(this.sessionToken!)
})

When("I authenticate with the token {string}", async function (this: CustomWorld, token: string) {
  this.lastResponse = await this.client!.authenticateWithToken(token)
})

When("I disconnect from the server", async function (this: CustomWorld) {
  await this.client!.disconnect()
})

When(
  "I create a channel with the agent {string}",
  async function (this: CustomWorld, agentId: string) {
    this.lastResponse = await this.client!.sendAndWait({ type: "create_channel", agentId }, [
      "channel_created",
      "error",
    ])
    if (this.lastResponse.type === "channel_created") {
      this.channelId = this.lastResponse.channelId
    }
  },
)

When("I request the list of channels", async function (this: CustomWorld) {
  this.lastResponse = await this.client!.sendAndWait({ type: "list_channels" }, "channels_list")
})

When("I close the channel", async function (this: CustomWorld) {
  expect(this.channelId).to.not.be.null
  this.client!.send({ type: "close_channel", channelId: this.channelId })
  this.lastResponse = await this.client!.waitFor(["channel_list_status", "error"], 5000)
})

When("I send the message {string}", async function (this: CustomWorld, message: string) {
  expect(this.channelId).to.not.be.null
  this.lastResponse = await this.client!.sendAndWait(
    {
      type: "send_message",
      channelId: this.channelId,
      content: { type: "text", text: message },
    },
    ["message_sent", "error"],
  )
})

When("I request the message history", async function (this: CustomWorld) {
  expect(this.channelId).to.not.be.null
  this.lastResponse = await this.client!.sendAndWait(
    { type: "get_messages", channelId: this.channelId },
    "messages_history",
  )
})

// ============================================================================
// THEN - Assertions
// ============================================================================

Then(
  "I should receive a response of type {string}",
  function (this: CustomWorld, expectedType: string) {
    expect(this.lastResponse).to.not.be.null
    expect(this.lastResponse.type).to.equal(expectedType)
  },
)

Then("I should receive a session token", function (this: CustomWorld) {
  expect(this.lastResponse.sessionToken).to.be.a("string")
  expect(this.lastResponse.sessionToken.length).to.be.greaterThan(0)
  this.sessionToken = this.lastResponse.sessionToken
})

Then("I should receive the userId {string}", function (this: CustomWorld, expectedUserId: string) {
  expect(this.lastResponse.userId).to.equal(expectedUserId)
})

Then("I should receive an error message", function (this: CustomWorld) {
  expect(this.lastResponse.error).to.be.a("string")
  expect(this.lastResponse.error.length).to.be.greaterThan(0)
})

Then(
  "the channel should have an ID starting with {string}",
  function (this: CustomWorld, prefix: string) {
    expect(this.lastResponse.channelId).to.match(new RegExp(`^${prefix}`))
  },
)

Then(
  "the channel should be associated with the agent {string}",
  function (this: CustomWorld, agentId: string) {
    expect(this.lastResponse.agentId).to.equal(agentId)
  },
)

Then(
  "the list should contain at least {int} channel(s)",
  function (this: CustomWorld, minCount: number) {
    expect(this.lastResponse.channels).to.be.an("array")
    expect(this.lastResponse.channels.length).to.be.at.least(minCount)
  },
)

Then(
  "the list should contain at least {int} channel",
  function (this: CustomWorld, minCount: number) {
    expect(this.lastResponse.channels).to.be.an("array")
    expect(this.lastResponse.channels.length).to.be.at.least(minCount)
  },
)

Then("I should receive a channel deleted notification", function (this: CustomWorld) {
  expect(this.lastResponse.type).to.equal("channel_list_status")
  expect(this.lastResponse.action).to.equal("deleted")
  expect(this.lastResponse.channelId).to.equal(this.channelId)
})

Then("I should receive a message sent confirmation", function (this: CustomWorld) {
  expect(this.lastResponse.type).to.equal("message_sent")
})

Then("the confirmation should include a message ID", function (this: CustomWorld) {
  expect(this.lastResponse.messageId).to.be.a("string")
})

Then("the history should be a list", function (this: CustomWorld) {
  expect(this.lastResponse.messages).to.be.an("array")
})

Then(
  "I should receive a typing notification or send confirmation",
  async function (this: CustomWorld) {
    expect(["typing", "message_sent"]).to.include(this.lastResponse.type)
  },
)
