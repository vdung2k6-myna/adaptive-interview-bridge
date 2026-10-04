import type { BridgeConfig } from "./config.js";

/**
 * The bridge's side of the boundary, and the only place it crosses.
 *
 * The platform's credential reaches exactly one kind of request — the ones this
 * bridge makes to the platform, server to server, on a device's behalf. It must
 * not reach any other kind, and in particular nothing this service sends to a
 * device: not the OTA answer, not the hello reply, not a message inside a turn.
 * That is the spec's "A gadget holds no credential the platform accepts" (2.3),
 * and it is why the credential is turned into a header *here* rather than at
 * each call site: one audited place is the difference between an invariant and a
 * promise. A future call that builds its own `Authorization` header is the way
 * this leaks.
 *
 * The platform's own validator compares the presented token to its configured
 * one with `===`, so the token is passed through byte for byte — no trimming, no
 * case folding, no normalization. Anything helpful here is a credential that no
 * longer authenticates.
 *
 * The bridge does not yet call the platform: the persona catalog is 3.1 and a
 * turn is 4.1, and both take their requests through this module.
 */
export function platformAuthHeaders(config: BridgeConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiAuthToken}` };
}
