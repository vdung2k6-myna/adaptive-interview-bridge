import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frame, unfold } from "../src/protocol/framing.js";

/**
 * The framing is four bytes of header, and getting it wrong does not throw
 * anywhere — it hands the decoder a short block of garbage, which surfaces as a
 * transcriber that heard nothing. So the round trip is checked in all three
 * versions, and separately against a payload that is not self-describing.
 */
describe("binary framing", () => {
  const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);

  for (const version of [1, 2, 3] as const) {
    it(`round-trips a payload under version ${version}`, () => {
      const wire = frame(payload, version);
      assert.deepEqual(unfold(wire, version), payload);
    });
  }

  it("version 1 is the payload itself, with no header at all", () => {
    assert.deepEqual(frame(payload, 1), payload);
  });

  it("version 3 declares the payload length in a 4-byte header", () => {
    const wire = frame(payload, 3);
    assert.equal(wire.length, payload.length + 4);
    assert.equal(wire.readUInt8(0), 0, "type 0 is opus");
    assert.equal(wire.readUInt16BE(2), payload.length);
  });

  it("version 2 declares the payload length in a 16-byte header", () => {
    const wire = frame(payload, 2, 1234);
    assert.equal(wire.length, payload.length + 16);
    assert.equal(wire.readUInt16BE(0), 2, "the version the device negotiated");
    assert.equal(wire.readUInt32BE(8), 1234, "the timestamp travels in the header");
    assert.equal(wire.readUInt32BE(12), payload.length);
  });

  it("truncates a packet that claims more than it carries rather than reading past it", () => {
    // A device whose socket dies mid-packet leaves a short buffer; the decoder
    // needs the bytes that arrived, and the process needs to not read out of
    // bounds.
    const short = Buffer.from([0x00, 0x00, 0xff, 0xff, 0x01]);
    assert.deepEqual(unfold(short, 3), Buffer.from([0x01]));
  });

  it("answers an empty payload for a header that did not fully arrive", () => {
    assert.deepEqual(unfold(Buffer.from([0x00, 0x00]), 3), Buffer.alloc(0));
    assert.deepEqual(unfold(Buffer.alloc(8), 2), Buffer.alloc(0));
  });
});
