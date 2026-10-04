/**
 * The framing in front of every binary packet.
 *
 * The firmware sends and expects a small header before each Opus payload, and the
 * version it uses is fixed in its own build rather than negotiated at runtime —
 * so this side answers in the version the device negotiated, which makes the
 * version configuration (see `BRIDGE_FRAMING`) rather than a constant. Version 3
 * is what this deployment's board uses; 2 and 1 are kept because a reflashed
 * device can arrive with either and the difference is four bytes of header.
 *
 * Unfold before decoding. Handing a framed packet straight to an Opus decoder
 * does not throw — it returns a short, quiet block of garbage, which is a bug
 * that presents as "the transcriber heard nothing" and gives no clue where to
 * look. The rig that preceded this service lost three turns to exactly that.
 */
export type FramingVersion = 1 | 2 | 3;

/**
 * Wrap a payload for sending. Version 1 is the payload itself: the "header" only
 * exists from version 2 on.
 */
export function frame(payload: Buffer, version: FramingVersion, timestamp = 0): Buffer {
  if (version === 2) {
    const out = Buffer.alloc(16 + payload.length);
    out.writeUInt16BE(2, 0); // version
    out.writeUInt16BE(0, 2); // type: 0 = opus, 1 = json
    out.writeUInt32BE(0, 4); // reserved
    out.writeUInt32BE(timestamp >>> 0, 8);
    out.writeUInt32BE(payload.length, 12);
    payload.copy(out, 16);
    return out;
  }
  if (version === 3) {
    const out = Buffer.alloc(4 + payload.length);
    out.writeUInt8(0, 0); // type: 0 = opus
    out.writeUInt8(0, 1); // reserved
    out.writeUInt16BE(payload.length, 2);
    payload.copy(out, 4);
    return out;
  }
  return payload;
}

/**
 * Strip the header from a received packet, leaving the payload. The declared
 * length is honoured rather than trusted blindly: a packet whose header claims
 * more than it carries is truncated to what arrived, which is what the decoder
 * needs and what the device means.
 */
export function unfold(wire: Buffer, version: FramingVersion): Buffer {
  if (version === 2) {
    if (wire.length < 16) return Buffer.alloc(0);
    const declared = wire.readUInt32BE(12);
    return wire.subarray(16, Math.min(16 + declared, wire.length));
  }
  if (version === 3) {
    if (wire.length < 4) return Buffer.alloc(0);
    const declared = wire.readUInt16BE(2);
    return wire.subarray(4, Math.min(4 + declared, wire.length));
  }
  return wire;
}
