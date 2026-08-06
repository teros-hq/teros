/**
 * EmailService unit tests — Resend is mocked, no real API calls.
 *
 * For testing actual email delivery via the Resend API, use: scripts/test-email.ts
 *
 * Usage:
 *   bun test tests/unit/email-service.test.ts
 */

import { join } from "node:path"
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
// Capture the REAL config before mocking it. `mock.module` is process-global and
// does NOT reset between test files, so an incomplete mock here leaks into every
// other suite: any module that resolves this mock and reads a field we omitted
// (e.g. message-handler reading `config.uploads.basePath`) throws. Spreading the
// real config keeps the mock complete; we only override what EmailService needs.
import { config as realConfig } from "../../src/config"

const defaultResendResponse = () =>
  Promise.resolve({ data: { id: "mock-id" }, error: null })

const mockResendSend = mock(defaultResendResponse)

mock.module("../../src/config", () => ({
  config: {
    ...realConfig,
    static: { baseUrl: "https://static.teros.ai" },
    email: { fromEmail: "hello@teros.ai", fromName: "Teros" },
  },
}))

mock.module("resend", () => ({
  Resend: class {
    emails = { send: mockResendSend }
  },
}))

import { EmailService } from "../../src/services/email-service"

const templatesDir = join(import.meta.dir, "../../templates/emails")

function skipSleep(svc: EmailService) {
  // @ts-expect-error — skip real delays in tests
  svc.sleep = () => Promise.resolve()
}

function makeMockDb() {
  const mockInsertOne = mock(() => Promise.resolve())
  const mockUpdateOne = mock(() => Promise.resolve({ matchedCount: 0 }))
  const mockCreateIndex = mock(() => Promise.resolve())
  return {
    db: {
      collection: () => ({
        insertOne: mockInsertOne,
        updateOne: mockUpdateOne,
        createIndex: mockCreateIndex,
      }),
    } as any,
    mockInsertOne,
    mockUpdateOne,
  }
}

describe("EmailService", () => {
  let service: EmailService

  beforeEach(() => {
    mockResendSend.mockReset()
    mockResendSend.mockImplementation(defaultResendResponse)
    const { db } = makeMockDb()
    service = new EmailService("mock-key", { templatesDir, db })
    skipSleep(service)
  })

  describe("send", () => {
    it("sends email with rendered template and returns success", async () => {
      const result = await service.send({
        to: "user@example.com",
        subject: "Test Subject",
        template: "welcome-registered",
        variables: { USER_NAME: "Alice" },
      })

      expect(result.success).toBe(true)
      expect(result.messageId).toBe("mock-id")
      expect(mockResendSend).toHaveBeenCalledTimes(1)

      const call = mockResendSend.mock.calls[0][0] as any
      expect(call.to).toBe("user@example.com")
      expect(call.subject).toBe("Test Subject")
      expect(call.from).toBe("Teros <hello@teros.ai>")
      expect(call.html).toContain("Alice")
      expect(call.html).not.toContain("{{USER_NAME}}")
    })

    it("injects STATIC_BASE_URL from config", async () => {
      await service.send({
        to: "user@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "X" },
      })

      const html = (mockResendSend.mock.calls[0][0] as any).html as string
      expect(html).not.toContain("{{STATIC_BASE_URL}}")
      expect(html).toContain("https://static.teros.ai")
    })

    it("returns error after exhausting retries when Resend responds with error", async () => {
      mockResendSend.mockImplementation(() =>
        Promise.resolve({ data: null, error: { message: "Rate limited" } }),
      )

      const result = await service.send({
        to: "user@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "X" },
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe("Rate limited")
      expect(mockResendSend).toHaveBeenCalledTimes(4)
    })

    it("returns error after exhausting retries when Resend throws", async () => {
      mockResendSend.mockImplementation(() => {
        throw new Error("Network failure")
      })

      const result = await service.send({
        to: "user@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "X" },
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe("Network failure")
      expect(mockResendSend).toHaveBeenCalledTimes(4)
    })
  })

  describe("template caching", () => {
    it("caches templates after first load", async () => {
      await service.send({
        to: "a@example.com",
        subject: "First",
        template: "welcome-registered",
        variables: { USER_NAME: "A" },
      })
      await service.send({
        to: "b@example.com",
        subject: "Second",
        template: "welcome-registered",
        variables: { USER_NAME: "B" },
      })

      const html1 = (mockResendSend.mock.calls[0][0] as any).html as string
      const html2 = (mockResendSend.mock.calls[1][0] as any).html as string
      expect(html1).toContain("A")
      expect(html2).toContain("B")
    })

    it("clearCache forces re-read from disk", async () => {
      await service.send({
        to: "a@example.com",
        subject: "First",
        template: "welcome-registered",
        variables: { USER_NAME: "A" },
      })

      service.clearCache()

      await service.send({
        to: "b@example.com",
        subject: "Second",
        template: "welcome-registered",
        variables: { USER_NAME: "B" },
      })

      expect(mockResendSend).toHaveBeenCalledTimes(2)
      const html = (mockResendSend.mock.calls[1][0] as any).html as string
      expect(html).toContain("B")
    })
  })

  describe("variable substitution", () => {
    it("replaces all occurrences of a variable", async () => {
      await service.send({
        to: "x@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "RepeatedName" },
      })

      const html = (mockResendSend.mock.calls[0][0] as any).html as string
      expect(html).not.toContain("{{USER_NAME}}")
    })

    it("leaves unmatched placeholders intact", async () => {
      await service.send({
        to: "x@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: {},
      })

      const html = (mockResendSend.mock.calls[0][0] as any).html as string
      expect(html).toContain("{{USER_NAME}}")
    })
  })

  describe("audit logging", () => {
    it("refuses to send when no db is configured", async () => {
      const svc = new EmailService("mock-key", { templatesDir })

      const result = await svc.send({
        to: "user@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "X" },
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("not configured")
      expect(mockResendSend).not.toHaveBeenCalled()
    })

    it("calls insertOne on first email to a recipient/template", async () => {
      const { db, mockInsertOne, mockUpdateOne } = makeMockDb()
      const svc = new EmailService("mock-key", { templatesDir, db })
      skipSleep(svc)

      await svc.send({
        to: "audit@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "Audited" },
      })

      expect(mockUpdateOne).toHaveBeenCalledTimes(1)
      expect(mockInsertOne).toHaveBeenCalledTimes(1)
    })

    it("appends attempt via updateOne when audit doc exists", async () => {
      const mockInsertOne = mock(() => Promise.resolve())
      const mockUpdateOne = mock(() => Promise.resolve({ matchedCount: 1 }))
      const db = {
        collection: () => ({
          insertOne: mockInsertOne,
          updateOne: mockUpdateOne,
          createIndex: mock(() => Promise.resolve()),
        }),
      } as any
      const svc = new EmailService("mock-key", { templatesDir, db })
      skipSleep(svc)

      await svc.send({
        to: "audit@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "Retry" },
      })

      expect(mockUpdateOne).toHaveBeenCalledTimes(1)
      expect(mockInsertOne).not.toHaveBeenCalled()
    })

    it("does not throw when audit logging fails", async () => {
      const db = {
        collection: () => ({
          updateOne: mock(() => { throw new Error("DB down") }),
          createIndex: mock(() => Promise.resolve()),
        }),
      } as any
      const svc = new EmailService("mock-key", { templatesDir, db })
      skipSleep(svc)

      const result = await svc.send({
        to: "audit@example.com",
        subject: "Test",
        template: "welcome-registered",
        variables: { USER_NAME: "X" },
      })

      expect(result.success).toBe(true)
    })

  })

  describe("retry with exponential backoff", () => {
    let sleepCalls: number[]

    beforeEach(() => {
      sleepCalls = []
    })

    function makeRetryService() {
      const { db, mockInsertOne, mockUpdateOne } = makeMockDb()
      mockUpdateOne.mockImplementation(() => Promise.resolve({ matchedCount: 1 }))
      const svc = new EmailService("mock-key", { templatesDir, db })
      // @ts-expect-error — spy on private sleep
      svc.sleep = (ms: number) => {
        sleepCalls.push(ms)
        return Promise.resolve()
      }
      return { svc, mockInsertOne, mockUpdateOne }
    }

    const emailOpts = {
      to: "retry@example.com",
      subject: "Test",
      template: "welcome-registered" as const,
      variables: { USER_NAME: "X" },
    }

    it("retries up to 3 times on failure then returns last error", async () => {
      mockResendSend.mockImplementation(() =>
        Promise.resolve({ data: null, error: { message: "Service unavailable" } }),
      )
      const { svc } = makeRetryService()

      const result = await svc.send(emailOpts)

      expect(result.success).toBe(false)
      expect(result.error).toBe("Service unavailable")
      expect(mockResendSend).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
    })

    it("stops retrying on first success", async () => {
      let callCount = 0
      mockResendSend.mockImplementation(() => {
        callCount++
        if (callCount <= 2) {
          return Promise.resolve({ data: null, error: { message: "Temporary" } })
        }
        return Promise.resolve({ data: { id: "success-id" }, error: null })
      })
      const { svc } = makeRetryService()

      const result = await svc.send(emailOpts)

      expect(result.success).toBe(true)
      expect(result.messageId).toBe("success-id")
      expect(mockResendSend).toHaveBeenCalledTimes(3) // 2 failures + 1 success
    })

    it("uses exponential backoff delays starting at 8s", async () => {
      mockResendSend.mockImplementation(() =>
        Promise.resolve({ data: null, error: { message: "fail" } }),
      )
      const { svc } = makeRetryService()

      await svc.send(emailOpts)

      expect(sleepCalls).toEqual([8000, 16000, 32000])
    })

    it("logs each attempt to audit with correct success status", async () => {
      let callCount = 0
      mockResendSend.mockImplementation(() => {
        callCount++
        if (callCount <= 1) {
          return Promise.resolve({ data: null, error: { message: "fail" } })
        }
        return Promise.resolve({ data: { id: "ok" }, error: null })
      })
      const { svc, mockUpdateOne } = makeRetryService()

      await svc.send(emailOpts)

      expect(mockUpdateOne).toHaveBeenCalledTimes(2)
      const firstAttempt = mockUpdateOne.mock.calls[0][1] as any
      expect(firstAttempt.$push.attempts.success).toBe(false)
      expect(firstAttempt.$push.attempts.error).toBe("fail")
      const secondAttempt = mockUpdateOne.mock.calls[1][1] as any
      expect(secondAttempt.$push.attempts.success).toBe(true)
      expect(secondAttempt.$push.attempts.resendMessageId).toBe("ok")
    })
  })
})
