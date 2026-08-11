import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseClientMessage,
  parseAgentMessage,
  ClientMessage,
  AutotypeMessage,
  MouseMessage,
} from "./messages.js";

test("parses a valid auth message", () => {
  const msg = parseClientMessage(JSON.stringify({ type: "auth", secret: "hunter2" }));
  assert.equal(msg.type, "auth");
  if (msg.type === "auth") assert.equal(msg.secret, "hunter2");
});

test("rejects auth with empty secret", () => {
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "auth", secret: "" })));
});

test("rejects unknown message type", () => {
  assert.throws(() => parseClientMessage(JSON.stringify({ type: "nope" })));
});

test("mouse coords must be within 0..1", () => {
  assert.throws(() =>
    MouseMessage.parse({ type: "mouse", action: "move", x: 1.5, y: 0.2 }),
  );
  const ok = MouseMessage.parse({ type: "mouse", action: "move", x: 0.5, y: 0.5 });
  assert.equal(ok.action, "move");
});

test("autotype applies profile defaults", () => {
  const msg = AutotypeMessage.parse({ type: "autotype", text: "hi" });
  assert.equal(msg.profile.baseDelayMs, 90);
  assert.equal(msg.profile.jitterMs, 60);
  assert.equal(msg.profile.typoRate, 0.03);
});

test("key message defaults modifiers to empty array", () => {
  const msg = ClientMessage.parse({ type: "key", action: "press", key: "a" });
  assert.deepEqual(msg.type === "key" ? msg.modifiers : null, []);
});

test("parses agent-side messages", () => {
  const info = parseAgentMessage(
    JSON.stringify({ type: "agentInfo", screenWidth: 1920, screenHeight: 1080, nickname: "pc" }),
  );
  assert.equal(info.type, "agentInfo");
  const res = parseAgentMessage(JSON.stringify({ type: "authResult", ok: false, reason: "bad" }));
  assert.equal(res.type, "authResult");
});

test("setMode enforces interval bounds", () => {
  // Below 4ms is rejected...
  assert.throws(() =>
    ClientMessage.parse({ type: "setMode", mode: "video", intervalMs: 2 }),
  );
  // ...but high-fps intervals (120fps≈8ms, 60fps≈17ms) must be accepted.
  for (const intervalMs of [8, 17, 50]) {
    const ok = ClientMessage.parse({ type: "setMode", mode: "video", intervalMs });
    assert.equal(ok.type, "setMode");
  }
});

test("rejects webrtcAnswer with empty sdp", () => {
  assert.throws(() =>
    parseClientMessage(JSON.stringify({ type: "webrtcAnswer", sdp: "" })),
  );
});


test("parses a qualityState report, including a null bitrate", () => {
  const msg = parseAgentMessage(
    JSON.stringify({
      type: "qualityState",
      width: 1536,
      fps: 30,
      bitrateKbps: 4200,
      degraded: true,
      mode: "auto",
      buffering: false,
      options: [{ width: 1536, fps: 30 }],
    }),
  );
  assert.equal(msg.type, "qualityState");
  if (msg.type === "qualityState") {
    assert.equal(msg.width, 1536);
    assert.equal(msg.degraded, true);
  }

  // Null until the adaptive controller has run a tick — must not be rejected.
  const early = parseAgentMessage(
    JSON.stringify({
      type: "qualityState",
      width: 1920,
      fps: 60,
      bitrateKbps: null,
      degraded: false,
      mode: "auto",
      buffering: false,
      options: [{ width: 1920, fps: 60 }],
    }),
  );
  assert.equal(early.type === "qualityState" && early.bitrateKbps, null);
});

test("setQuality accepts a pinned width and null for auto", () => {
  const pinned = ClientMessage.parse({ type: "setQuality", width: 1280 });
  assert.equal(pinned.type === "setQuality" && pinned.width, 1280);
  const auto = ClientMessage.parse({ type: "setQuality", width: null });
  assert.equal(auto.type === "setQuality" && auto.width, null);
  // A width of 0 or negative is meaningless; reject rather than clamp.
  assert.throws(() => ClientMessage.parse({ type: "setQuality", width: 0 }));
});

test("qualityState carries mode, buffering and the pickable rungs", () => {
  const msg = parseAgentMessage(
    JSON.stringify({
      type: "qualityState",
      width: 1280,
      fps: 59,
      bitrateKbps: 8000,
      degraded: false,
      mode: "manual",
      buffering: true,
      options: [
        { width: 1280, fps: 59 },
        { width: 1024, fps: 30 },
      ],
    }),
  );
  assert.equal(msg.type, "qualityState");
  if (msg.type === "qualityState") {
    assert.equal(msg.mode, "manual");
    assert.equal(msg.buffering, true);
    assert.equal(msg.options.length, 2);
  }
});
