/**
 * Server-side model-health merge (TER-668 / A4.3).
 *
 * The model-health handler used to read EVERY rollup of the range with no limit
 * and merge the embedded `modelHealth` histograms in JS on the single-process
 * backend — ~82 MB BSON at ×100/30d, ~820 MB at ×1000 → event-loop block / OOM
 * for ALL WS users. This builds a Mongo aggregation that pre-reduces the N
 * rollup docs down to ONE merged `ModelHealthEntry` per `${actualProvider}::${modelId}`
 * (a handful of docs, tens of KB) BEFORE anything crosses to Node. The pure
 * `aggregateModelHealth` then does the final tiny combine (merged rollups + the
 * live in-progress hour) and derives the percentiles — unchanged, so the numbers
 * are identical to the old all-in-JS path (proven by the equivalence test).
 *
 * The histograms are additive: bucket arrays are fixed-length (`emptyHistogram`),
 * so the element-wise `$reduce`+`$map` sum is exact. The dynamic-key maps
 * (statusCounts/errorCounts/finishReasons) are summed by key with
 * `$map`/`$filter`/`$setUnion`/`$arrayToObject` — `$setField` with a dynamic
 * `field` is rejected by Mongo 7.0, so this key-sum form is the version-safe one.
 */

import { LATENCY_BUCKET_BOUNDS_MS } from "./latency-histogram.js"

const NUM_BUCKETS = LATENCY_BUCKET_BOUNDS_MS.length + 1
const ZERO_BUCKETS: number[] = new Array(NUM_BUCKETS).fill(0)

/** Element-wise sum of a `$push`ed array of fixed-length bucket arrays. */
function elementwiseBucketSum(arraysExpr: string): object {
  return {
    $reduce: {
      input: arraysExpr,
      initialValue: ZERO_BUCKETS,
      in: {
        $map: {
          input: { $range: [0, NUM_BUCKETS] },
          as: "i",
          in: {
            $add: [
              { $arrayElemAt: ["$$value", "$$i"] },
              { $ifNull: [{ $arrayElemAt: ["$$this", "$$i"] }, 0] },
            ],
          },
        },
      },
    },
  }
}

/**
 * Sum a `$push`ed array of dynamic-key count maps by key → one merged object.
 * Flattens each map via `$objectToArray`, then for every distinct key sums the
 * matching values. Handles arbitrary keys (finish_reason strings are provider-
 * dependent) with only operators supported for expression field names in 7.0.
 */
function sumMapsByKey(mapsExpr: string): object {
  return {
    $let: {
      vars: {
        flat: {
          $reduce: {
            input: {
              $map: {
                input: mapsExpr,
                as: "m",
                in: { $objectToArray: { $ifNull: ["$$m", {}] } },
              },
            },
            initialValue: [],
            in: { $concatArrays: ["$$value", "$$this"] },
          },
        },
      },
      in: {
        $arrayToObject: {
          $map: {
            input: { $setUnion: { $map: { input: "$$flat", as: "e", in: "$$e.k" } } },
            as: "key",
            in: {
              k: "$$key",
              v: {
                $sum: {
                  $map: {
                    input: { $filter: { input: "$$flat", as: "f", cond: { $eq: ["$$f.k", "$$key"] } } },
                    as: "g",
                    in: "$$g.v",
                  },
                },
              },
            },
          },
        },
      },
    },
  }
}

/**
 * Build the aggregation that merges the per-hour `modelHealth` blocks into one
 * `ModelHealthEntry` per model. Pass `byHour: true` to keep the hourBucket in the
 * group key (for the time-series handler) — each hour is then merged on its own.
 *
 * `match` is the same `$match` the JS path used (range + logical group-key
 * filters + demoSeed exclusion), so scope is identical.
 */
export function buildModelHealthMergePipeline(
  match: Record<string, unknown>,
  opts: { byHour?: boolean } = {},
): object[] {
  const groupId = opts.byHour
    ? { key: "$entries.k", hourBucket: "$hourBucket" }
    : "$entries.k"

  return [
    { $match: match },
    {
      $project: {
        ...(opts.byHour ? { hourBucket: 1 } : {}),
        entries: { $objectToArray: { $ifNull: ["$modelHealth", {}] } },
      },
    },
    { $unwind: "$entries" },
    {
      $group: {
        _id: groupId,
        actualProvider: { $first: "$entries.v.actualProvider" },
        modelId: { $first: "$entries.v.modelId" },
        requestCount: { $sum: "$entries.v.requestCount" },
        emptyCount: { $sum: { $ifNull: ["$entries.v.emptyCount", 0] } },
        // Denominators for empty/truncation rates (TER-674) — fall back to
        // requestCount for legacy entries, exactly like the JS aggregator merge.
        measuredCount: { $sum: { $ifNull: ["$entries.v.measuredCount", "$entries.v.requestCount"] } },
        stopReasonCount: {
          $sum: { $ifNull: ["$entries.v.stopReasonCount", "$entries.v.requestCount"] },
        },
        fallbackCount: { $sum: { $ifNull: ["$entries.v.fallbackCount", 0] } },
        toolCallCount: { $sum: { $ifNull: ["$entries.v.toolCallCount", 0] } },
        toolErrorCount: { $sum: { $ifNull: ["$entries.v.toolErrorCount", 0] } },
        latCount: { $sum: { $ifNull: ["$entries.v.latency.count", 0] } },
        latSum: { $sum: { $ifNull: ["$entries.v.latency.sum", 0] } },
        latMax: { $max: { $ifNull: ["$entries.v.latency.max", 0] } },
        latBuckets: { $push: { $ifNull: ["$entries.v.latency.buckets", ZERO_BUCKETS] } },
        ttftCount: { $sum: { $ifNull: ["$entries.v.ttft.count", 0] } },
        ttftSum: { $sum: { $ifNull: ["$entries.v.ttft.sum", 0] } },
        ttftMax: { $max: { $ifNull: ["$entries.v.ttft.max", 0] } },
        ttftBuckets: { $push: { $ifNull: ["$entries.v.ttft.buckets", ZERO_BUCKETS] } },
        statusMaps: { $push: "$entries.v.statusCounts" },
        errorMaps: { $push: "$entries.v.errorCounts" },
        subReasonMaps: { $push: "$entries.v.subReasonCounts" },
        finishMaps: { $push: "$entries.v.finishReasons" },
      },
    },
    {
      $project: {
        _id: 0,
        ...(opts.byHour ? { hourBucket: "$_id.hourBucket" } : {}),
        actualProvider: 1,
        modelId: 1,
        requestCount: 1,
        emptyCount: 1,
        measuredCount: 1,
        stopReasonCount: 1,
        fallbackCount: 1,
        toolCallCount: 1,
        toolErrorCount: 1,
        latency: {
          buckets: elementwiseBucketSum("$latBuckets"),
          count: "$latCount",
          sum: "$latSum",
          max: "$latMax",
        },
        ttft: {
          buckets: elementwiseBucketSum("$ttftBuckets"),
          count: "$ttftCount",
          sum: "$ttftSum",
          max: "$ttftMax",
        },
        statusCounts: sumMapsByKey("$statusMaps"),
        errorCounts: sumMapsByKey("$errorMaps"),
        subReasonCounts: sumMapsByKey("$subReasonMaps"),
        finishReasons: sumMapsByKey("$finishMaps"),
      },
    },
  ]
}
