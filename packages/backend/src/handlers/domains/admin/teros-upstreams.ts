/**
 * admin.teros-upstreams — the upstream catalogue + secret presence (TPROV-REQ-11).
 * admin.test-teros-size — run a size of a config against its upstream: a short
 * text request through the real size router, then an image request on the
 * route the router picks for images (TPROV-REQ-10). The test runs one lane of
 * the size, named by the caller (TLANE-REQ-10, TLANE-REQ-11).
 *
 * Admin/super only. Secrets never leave the server: the test runs here and
 * reports latency, the model that answered and whether the image was described.
 *
 * @spec TPROV-REQ-10, TPROV-REQ-11, TLANE-REQ-10, TLANE-REQ-11
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { UserService } from '../../../auth/user-service'
import { getTerosProviderConfigsCollection } from '../../../models/billing.js'
import {
  findTerosUpstreamModel,
  TEROS_EFFORTS,
  TEROS_LANES,
  TEROS_SIZES,
  TEROS_UPSTREAM_CATALOG,
  type TerosLane,
  type TerosSize,
  type TerosSizeRoute,
} from '../../../models/providers/teros.js'
import { secrets } from '../../../secrets/secrets-manager'
import { TerosRouterClient } from '../../../services/teros-router-client.js'
import { terosUpstreamStatus } from '../../../services/teros-upstream.js'
import { describesTestImage, terosTestImagePng } from '../../../lib/teros-test-image.js'

async function assertAdmin(userService: UserService, userId: string) {
  const caller = await userService.getByUserId(userId)
  if (caller?.role !== 'admin' && caller?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

/** @spec TPROV-REQ-11 */
export function createTerosUpstreamsHandler(userService: UserService) {
  return async function terosUpstreams(ctx: WsHandlerContext, _rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const status = terosUpstreamStatus(secrets)
    return {
      upstreams: status.map((u) => ({ ...u, models: TEROS_UPSTREAM_CATALOG[u.upstream] })),
      sizes: TEROS_SIZES,
      lanes: TEROS_LANES,
      efforts: TEROS_EFFORTS,
    }
  }
}

interface TestSizeData {
  configId: string
  size: TerosSize
  /** The lane whose route is tested (TLANE-REQ-11). */
  lane: TerosLane
  /** The route on screen (unsaved draft); when absent the stored route is tested. */
  route?: TerosSizeRoute
}

const TEXT_PROMPT = 'Reply with the single word OK.'
const IMAGE_PROMPT = 'Describe exactly what is in this image: shapes, their colours and positions (left/right). One sentence.'

/** @spec TPROV-REQ-10, TLANE-REQ-11 */
export function createTestTerosSizeHandler(userService: UserService, db: Db) {
  return async function testTerosSize(ctx: WsHandlerContext, rawData: unknown) {
    await assertAdmin(userService, ctx.userId)
    const data = rawData as TestSizeData
    if (!data?.configId || !TEROS_SIZES.includes(data.size) || !TEROS_LANES.includes(data.lane)) {
      throw new HandlerError('MISSING_FIELDS', 'configId, size (l|m|s) and lane (interactive|background) are required')
    }
    const lane = data.lane
    const config = await getTerosProviderConfigsCollection(db).findOne({ _id: data.configId })
    if (!config) throw new HandlerError('NOT_FOUND', `Config ${data.configId} not found`)
    if (!config.sizes || !config.failover) {
      throw new HandlerError('INVALID_ROUTE', 'Config has no size routes — run migrations 20261103_001 and 20261109_001')
    }

    // Test what the admin sees: the draft route when given (validated against
    // the catalogue), else the stored one.
    let sizes = config.sizes
    if (data.route) {
      const model = findTerosUpstreamModel(data.route.upstream, data.route.modelString)
      if (!model) throw new HandlerError('INVALID_ROUTE', `Invalid route: sizes.${data.size}.${lane}.modelString`)
      sizes = {
        ...config.sizes,
        [data.size]: { ...config.sizes[data.size], [lane]: { ...data.route, modelString: model.modelString } },
      }
    }
    const router = new TerosRouterClient({
      size: data.size,
      config: { sizes, failover: config.failover },
      secrets,
      maxTokens: 400,
    })
    const route = router.primaryRoute(lane)
    if (!route) {
      return {
        ok: false,
        lane,
        upstream: sizes[data.size][lane].upstream,
        model: sizes[data.size][lane].modelString,
        error: 'TEROS_UPSTREAM_UNAVAILABLE: missing system secret, unknown model or non-ZDR upstream',
      }
    }

    // 1. Text, through the real router + adapter.
    const t0 = Date.now()
    let text = ''
    try {
      await router.streamMessage({
        messages: [
          {
            info: { id: 'teros-test', sessionID: 'teros-test', role: 'user', time: { created: Date.now() } },
            parts: [{ type: 'text', id: 'p1', sessionID: 'teros-test', messageID: 'teros-test', text: TEXT_PROMPT }],
          } as any,
        ],
        maxTokens: 400,
        lane,
        callbacks: { onText: (chunk) => void (text += chunk) },
      })
    } catch (err: any) {
      return { ok: false, lane, upstream: route.upstream, model: route.modelString, latencyMs: Date.now() - t0, error: err?.message ?? String(err) }
    }
    const latencyMs = Date.now() - t0

    // 2. Image, sent to the size's OWN model: the empirical answer to "does it
    // see?", independent of the catalogue flag. The router's own choice for an
    // image request is reported beside it so a stale catalogue flag is visible.
    const routerImageRoute =
      router.routeFor({
        messages: [{ info: { role: 'user' }, parts: [{ type: 'file', mime: 'image/png', url: 'x' }] } as any],
        lane,
      }) ?? route
    const imageRoute = route
    let vision: boolean | null = null
    let imageText = ''
    let imageError: string | undefined
    try {
      const res = await fetch(`${imageRoute.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${imageRoute.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: imageRoute.modelString,
          max_tokens: 600,
          reasoning_effort: imageRoute.reasoningEffort,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: IMAGE_PROMPT },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${terosTestImagePng().toString('base64')}` } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      const json: any = await res.json().catch(() => ({}))
      imageText = String(json?.choices?.[0]?.message?.content ?? '')
      if (!res.ok) {
        // An upstream that rejects the image (400 "Invalid image", "multimodal_not_supported")
        // is the empirical "does not see"; the message is kept for the admin.
        vision = false
        imageError = `HTTP ${res.status}: ${String(json?.error?.message ?? json?.message ?? JSON.stringify(json)).slice(0, 160)}`
      } else vision = describesTestImage(imageText)
    } catch (err: any) {
      imageError = err?.message ?? String(err)
    }

    return {
      ok: true,
      lane,
      upstream: route.upstream,
      model: route.modelString,
      reasoningEffort: route.reasoningEffort,
      latencyMs,
      text: text.trim().slice(0, 200),
      image: {
        model: imageRoute.modelString,
        vision,
        catalogueVision: route.vision,
        rerouted: routerImageRoute.modelString !== route.modelString,
        reroutedTo: routerImageRoute.modelString !== route.modelString ? routerImageRoute.modelString : undefined,
        text: imageText.trim().slice(0, 200),
        error: imageError,
      },
    }
  }
}
