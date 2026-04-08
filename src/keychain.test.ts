import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildAccountLabels } from "./keychain.ts"

const makeAccountCreds = (
  sub?: string,
): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
} => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 9999999999999,
  subscriptionType: sub,
})

describe("account labelling", () => {
  it("uses subscription type as label when available", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
    assert.equal(buildAccountLabels([makeAccountCreds("max")])[0], "Claude Max")
    assert.equal(
      buildAccountLabels([makeAccountCreds("free")])[0],
      "Claude Free",
    )
  })

  it("capitalises the subscription tier", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
  })

  it("falls back to 'Claude' when no subscription type", () => {
    assert.equal(buildAccountLabels([makeAccountCreds()])[0], "Claude")
  })

  it("deduplicates labels with counter when multiple accounts share a tier", () => {
    const labels = buildAccountLabels([
      makeAccountCreds("pro"),
      makeAccountCreds("pro"),
      makeAccountCreds("max"),
    ])
    assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2", "Claude Max"])
  })

  it("keeps single account of each tier un-numbered", () => {
    assert.deepEqual(
      buildAccountLabels([makeAccountCreds("pro"), makeAccountCreds("max")]),
      ["Claude Pro", "Claude Max"],
    )
  })

  it("handles three accounts of the same tier", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
      ]),
      ["Claude Pro 1", "Claude Pro 2", "Claude Pro 3"],
    )
  })

  it("handles mixed known and unknown subscription types", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds(),
        makeAccountCreds("pro"),
        makeAccountCreds(),
      ]),
      ["Claude 1", "Claude Pro", "Claude 2"],
    )
  })
})
