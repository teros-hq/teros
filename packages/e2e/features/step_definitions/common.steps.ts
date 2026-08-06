import { Given, Then, When } from "@cucumber/cucumber"
import { expect } from "chai"
import { E2E_CONFIG } from "../../src/fixtures/test-data"
import type { CustomWorld } from "../support/world"

function getHttpUrl(): string {
  return process.env.E2E_HTTP_URL || 'http://localhost:3002';
}

// ============================================================================
// GIVEN - Preconditions
// ============================================================================

Given("the WebSocket server is available", async function (this: CustomWorld) {
  // Use getHttpUrl() so we hit the embedded TestServer, not the stale E2E_CONFIG constant
  const response = await fetch(`${getHttpUrl()}/health`)
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

Given("I have a workspace named {string}", async function (this: CustomWorld, name: string) {
  // channel.create is workspace-sovereign — every channel needs a workspaceId.
  const data = await this.client!.requestOk<{ workspace: { workspaceId: string } }>(
    'workspace.create',
    { name },
  )
  this.workspaceId = data.workspace.workspaceId
  expect(this.workspaceId).to.match(/^work_/)
})

Given(
  "I have created a channel with the agent {string}",
  async function (this: CustomWorld, agentId: string) {
    if (!this.workspaceId) {
      const data = await this.client!.requestOk<{ workspace: { workspaceId: string } }>(
        'workspace.create',
        { name: 'E2E Workspace' },
      )
      this.workspaceId = data.workspace.workspaceId
    }
    const data = await this.client!.requestOk<{ channelId: string; agentId: string }>(
      'channel.create',
      { agentId, workspaceId: this.workspaceId },
    )
    this.channelId = data.channelId
  },
)

Given("I reconnect to the server", async function (this: CustomWorld) {
  const savedToken = this.sessionToken
  const savedChannelId = this.channelId
  const savedWorkspaceId = this.workspaceId

  await this.client!.disconnect()
  await this.createClient()

  this.lastResponse = await this.client!.authenticateWithToken(savedToken!)
  expect(this.lastResponse.type).to.equal("auth_success")

  this.sessionToken = savedToken
  this.channelId = savedChannelId
  this.workspaceId = savedWorkspaceId
})

// ============================================================================
// WHEN - Actions (real WsFramework envelope — TER-453)
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
    if (!this.workspaceId) {
      const data = await this.client!.requestOk<{ workspace: { workspaceId: string } }>(
        'workspace.create',
        { name: 'E2E Workspace' },
      )
      this.workspaceId = data.workspace.workspaceId
    }
    this.lastResponse = await this.client!.request('channel.create', {
      agentId,
      workspaceId: this.workspaceId,
    })
    if (this.lastResponse.type === 'response') {
      this.channelId = this.lastResponse.data.channelId
    }
  },
)

When("I request the list of channels", async function (this: CustomWorld) {
  this.lastResponse = await this.client!.request('channel.list', {
    workspaceId: this.workspaceId ?? undefined,
  })
})

When("I close the channel", async function (this: CustomWorld) {
  expect(this.channelId).to.not.be.null
  this.lastResponse = await this.client!.request('channel.close', { channelId: this.channelId })
})

When("I send the message {string}", async function (this: CustomWorld, message: string) {
  expect(this.channelId).to.not.be.null
  // The envelope response is `{}` — the confirmation arrives as a flat
  // `message_sent` push (same hybrid contract the production frontend uses).
  const ack = await this.client!.request('channel.send-message', {
    channelId: this.channelId,
    content: { type: "text", text: message },
  })
  expect(ack.type).to.equal('response')
  this.lastResponse = await this.client!.waitFor(['message_sent', 'error'], 5000)
})

When("I request the message history", async function (this: CustomWorld) {
  expect(this.channelId).to.not.be.null
  const ack = await this.client!.request('channel.get-messages', { channelId: this.channelId })
  expect(ack.type).to.equal('response')
  this.lastResponse = await this.client!.waitFor(['messages_history', 'error'], 5000)
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

Then("the request should succeed", function (this: CustomWorld) {
  expect(this.lastResponse).to.not.be.null
  expect(this.lastResponse.type).to.equal('response')
})

Then(
  "the request should fail with code {string}",
  function (this: CustomWorld, code: string) {
    expect(this.lastResponse.type).to.equal('error')
    expect(this.lastResponse.code).to.equal(code)
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
    expect(this.lastResponse.data.channelId).to.match(new RegExp(`^${prefix}`))
  },
)

Then(
  "the channel should be associated with the agent {string}",
  function (this: CustomWorld, agentId: string) {
    expect(this.lastResponse.data.agentId).to.equal(agentId)
  },
)

Then(
  "the list should contain at least {int} channel(s)",
  function (this: CustomWorld, minCount: number) {
    expect(this.lastResponse.data.channels).to.be.an("array")
    expect(this.lastResponse.data.channels.length).to.be.at.least(minCount)
  },
)

Then("the channel should be reported closed", function (this: CustomWorld) {
  expect(this.lastResponse.type).to.equal('response')
  expect(this.lastResponse.data).to.deep.equal({
    channelId: this.channelId,
    status: 'closed',
  })
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
