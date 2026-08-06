/**
 * Realtime cross-user steps (TER-453).
 *
 * Two independent WS clients (A = world.client, B = world.clientB). The event
 * wait on B is ALWAYS armed BEFORE the trigger on A — asserting after the
 * fact only verifies DB consistency, not realtime delivery (see
 * feedback_realtime_test_intercept_ws).
 */

import { Given, Then, When } from '@cucumber/cucumber'
import { expect } from 'chai'
import { getTestServer } from '../support/server'
import type { CustomWorld } from '../support/world'

Given('user A is authenticated as {string}', async function (this: CustomWorld, email: string) {
  await this.createClient()
  const auth = await this.client!.authenticate(email, 'password')
  expect(auth.type).to.equal('auth_success')
  this.userId = auth.userId!
})

Given('user B is authenticated as {string}', async function (this: CustomWorld, email: string) {
  await this.createClientB()
  const auth = await this.clientB!.authenticate(email, 'password')
  expect(auth.type).to.equal('auth_success')
  this.userIdB = auth.userId!
})

Given(
  'user A has a workspace named {string} with user B as member',
  async function (this: CustomWorld, name: string) {
    const data = await this.client!.requestOk<{ workspace: { workspaceId: string } }>(
      'workspace.create',
      { name },
    )
    this.workspaceId = data.workspace.workspaceId

    // There is no workspace.add-member WS action yet — membership is seeded
    // directly in the DB. The SUT here is the broadcast fan-out, not the
    // member-management API.
    const server = getTestServer()
    await server.db
      .collection('workspaces')
      .updateOne(
        { workspaceId: this.workspaceId },
        { $push: { members: { userId: this.userIdB, role: 'write' } } as never },
      )
  },
)

Given(
  'user A has a workspace named {string} without user B',
  async function (this: CustomWorld, name: string) {
    const data = await this.client!.requestOk<{ workspace: { workspaceId: string } }>(
      'workspace.create',
      { name },
    )
    this.workspaceId = data.workspace.workspaceId
  },
)

Given(
  'user B is waiting for a {string} event',
  function (this: CustomWorld, eventType: string) {
    // Armed BEFORE the trigger — this is the realtime contract under test.
    this.pendingEvent = this.clientB!.waitForEvent(eventType, 8000)
    // Pre-register a catch so a scenario that expects NO event does not die
    // with an unhandled rejection when the waiter times out.
    this.pendingEvent.catch(() => {})
  },
)

When(
  'user A creates a project named {string} in the workspace',
  async function (this: CustomWorld, projectName: string) {
    this.lastResponse = await this.client!.request('board.create-project', {
      workspaceId: this.workspaceId,
      name: projectName,
    })
  },
)

Then('the request should succeed for user A', function (this: CustomWorld) {
  expect(this.lastResponse.type).to.equal('response')
  expect(this.lastResponse.data.project).to.be.an('object')
})

Then(
  'user B receives the {string} event for the project {string}',
  async function (this: CustomWorld, eventType: string, projectName: string) {
    const event = await this.pendingEvent!
    expect(event.type).to.equal(eventType)
    expect(event.project).to.be.an('object')
    expect(event.project.name).to.equal(projectName)
    expect(event.board).to.be.an('object')
  },
)

Then(
  'user B does NOT receive the event within {int} ms',
  async function (this: CustomWorld, windowMs: number) {
    // The waiter was armed with a long timeout; race it against the isolation
    // window — receiving anything inside the window is a broadcast leak.
    const result = await Promise.race([
      this.pendingEvent!.then((evt) => ({ leaked: true as const, evt })),
      new Promise<{ leaked: false }>((resolve) =>
        setTimeout(() => resolve({ leaked: false }), windowMs),
      ),
    ])
    if (result.leaked) {
      throw new Error(
        `Broadcast leak: non-member received ${JSON.stringify((result as { evt: unknown }).evt)}`,
      )
    }
  },
)
