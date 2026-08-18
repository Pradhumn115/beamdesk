import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect as tlsConnect } from "node:tls";
import WebSocket from "ws";
import selfsigned from "selfsigned";
import {
  decodeFrame,
  encodeMessage,
  isFrame,
  parseAgentMessage,
  FrameFormat,
  type AgentMessage,
} from "@bcsa/shared";
import { ConnectionServer } from "./index.js";
import { AudioCapture } from "../audio/index.js";
import { UnsupportedVolumeController } from "../audio/volume.js";
import { CaptureLoop, type CapturedImage } from "../capture/index.js";
import { InputController, type InputBackend } from "../input/index.js";
import type { TypingBackend } from "../autotyper/index.js";
import { InputLockManager } from "../inputlock/index.js";
import type { ClipboardBackend } from "../clipboard/index.js";

function ephemeralTls(): { cert: string; key: string } {
  const pems = selfsigned.generate([{ name: "commonName", value: "test" }], {
    days: 1,
    keySize: 2048,
  });
  return { cert: pems.cert, key: pems.private };
}

function fakeCapture(stopCalls?: { count: number }): CaptureLoop {
  const image: CapturedImage = { data: new Uint8Array([1, 2, 3, 4]), format: FrameFormat.JPEG };
  const capture = new CaptureLoop(async () => image, 30);
  if (stopCalls) {
    const origStop = capture.stop.bind(capture);
    capture.stop = () => {
      stopCalls.count++;
      origStop();
    };
  }
  return capture;
}

function fakeInput(recorded: string[]): InputController {
  const backend: InputBackend = {
    async screenSize() {
      return { width: 1000, height: 500 };
    },
    async moveMouse(x, y) {
      recorded.push(`move(${x},${y})`);
    },
    async mouseButton(action, button) {
      recorded.push(`button(${action},${button})`);
    },
    async scroll() {},
    async keyAction(action, key) {
      recorded.push(`key(${action},${key})`);
    },
  };
  return new InputController(backend);
}

function fakeTyping(): TypingBackend {
  return { async typeChar() {}, async backspace() {}, async pressEnter() {} };
}

function fakeClipboard(initial = ""): ClipboardBackend {
  let content = initial;
  return {
    async getContent() {
      return content;
    },
    async setContent(text: string) {
      content = text;
    },
  };
}

function fakeInputLock(): InputLockManager {
  return new InputLockManager({
    backend: { supported: false, async lock() {}, async unlock() {} },
    autoReleaseMs: 10_000,
    onChange: () => {},
  });
}

async function startServer(
  secret: string,
  recorded: string[],
  opts: { captureStopCalls?: { count: number }; maxQueuedFrameBytes?: number } = {},
) {
  const server = new ConnectionServer({
    secret,
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput(recorded),
    capture: fakeCapture(opts.captureStopCalls),
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null), // no loopback device -> supported:false, no ffmpeg
    // A real controller would change the developer's actual speaker volume
    // while the suite runs; the tests here are about the connection, not the OS.
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    maxQueuedFrameBytes: opts.maxQueuedFrameBytes,
  });
  await server.listen();
  return server;
}

/** Collect the next JSON AgentMessage of a given type. */
function nextMessage(ws: WebSocket, type: AgentMessage["type"]): Promise<AgentMessage> {
  return new Promise((resolve) => {
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const msg = parseAgentMessage(data.toString());
      if (msg.type === type) {
        ws.off("message", onMsg);
        resolve(msg);
      }
    };
    ws.on("message", onMsg);
  });
}

test("full connect → auth → agentInfo → frame → control", async () => {
  const recorded: string[] = [];
  const server = await startServer("s3cret", recorded);
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));

  const info = await infoPromise;
  assert.equal(info.type, "agentInfo");
  if (info.type === "agentInfo") {
    assert.equal(info.screenWidth, 1000);
    assert.equal(info.nickname, "test-agent");
  }

  // Wait for a binary frame.
  const frame = await new Promise<Uint8Array>((resolve) => {
    const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = new Uint8Array(data as Buffer);
      if (isFrame(bytes)) {
        ws.off("message", onMsg);
        resolve(bytes);
      }
    };
    ws.on("message", onMsg);
  });
  const decoded = decodeFrame(frame);
  assert.ok(decoded);
  assert.deepEqual(Array.from(decoded!.payload), [1, 2, 3, 4]);

  // Send a click and verify the input backend received translated coords.
  ws.send(encodeMessage({ type: "mouse", action: "click", x: 0.5, y: 0.5, button: "left" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(recorded.includes("move(500,250)"));
  assert.ok(recorded.includes("button(click,left)"));

  ws.close();
  await server.close();
});

test("rejects an invalid secret", async () => {
  const server = await startServer("right", []);
  const port = server.boundPort();
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const resultPromise = nextMessage(ws, "authResult");
  ws.send(encodeMessage({ type: "auth", secret: "wrong" }));
  const result = await resultPromise;
  assert.equal(result.type, "authResult");
  if (result.type === "authResult") {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid secret");
  }
  await server.close();
});

test("rejects a second concurrent controller as busy", async () => {
  const server = await startServer("k", []);
  const port = server.boundPort();

  const a = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(a, "open");
  const aInfo = nextMessage(a, "agentInfo");
  a.send(encodeMessage({ type: "auth", secret: "k" }));
  await aInfo;

  const b = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(b, "open");
  const bResult = nextMessage(b, "authResult");
  b.send(encodeMessage({ type: "auth", secret: "k" }));
  const result = await bResult;
  assert.equal(result.type === "authResult" && result.reason, "busy");

  a.close();
  b.close();
  await server.close();
});

/**
 * Backpressure: Classic frames must be DROPPED, not queued, once the socket is
 * behind.
 *
 * Classic is MJPEG, so every frame is a full intra frame — measured at ~267KB
 * at 1920 wide, which is ~206 Mbit/s at the 120fps the client requests on a
 * 120Hz display. No WiFi or Tailscale link carries that, and with no ceiling ws
 * simply queued the surplus in memory: the backlog grew every second and the
 * picture fell permanently behind real time. That was the "Classic lags after
 * 10-15s" symptom — nothing was being dropped, and that was the bug.
 *
 * A loopback socket drains far too fast to build a real backlog on demand, so
 * the threshold is moved instead: at -1, `bufferedAmount > -1` is always true
 * and every frame must take the drop path. The control channel is exercised
 * afterwards to prove the connection is still healthy — i.e. that frames were
 * deliberately dropped rather than the session being broken.
 */
test("drops Classic frames instead of queueing them when the socket is behind", async () => {
  const recorded: string[] = [];
  const server = await startServer("s3cret", recorded, { maxQueuedFrameBytes: -1 });
  const port = server.boundPort();

  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  await once(ws, "open");

  const infoPromise = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await infoPromise;

  let frames = 0;
  ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary && isFrame(new Uint8Array(data as Buffer))) frames++;
  });

  // Comfortably longer than the 30fps fake capture's interval, so a working
  // send path would have delivered many frames by now.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(frames, 0, `expected every frame to be dropped, got ${frames}`);

  // The session must still be alive — dropping frames is not disconnecting.
  ws.send(encodeMessage({ type: "mouse", action: "click", x: 0.5, y: 0.5, button: "left" }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(recorded.includes("button(click,left)"), "control channel should still work");

  ws.close();
  await server.close();
});

/**
 * The adaptive controller must react to a congested link, not just to a
 * configured number.
 *
 * A fixed bitrate is wrong in both directions: too high on a poor link, where
 * frames queue and then get dropped and the picture stutters; too low on a good
 * one, where bandwidth sits unused and the image stays soft. The signal used
 * here is the socket's own send queue, which is a real measurement rather than
 * a guess.
 *
 * Congestion is simulated by setting the drop threshold to -1, so every frame
 * takes the backpressure path exactly as it would on a saturated link. The
 * assertion is that the encoder's bitrate is actually driven DOWN — the whole
 * point being that the agent stops sending more than the link can carry.
 */
test("lowers the encoder bitrate when the link is congested", async () => {
  const bitrates: number[] = [];
  const capture = fakeCapture();
  // The MJPEG fakes have no bitrate; give this one the H.264 engine's hook.
  (capture as unknown as { setBitrate: (k: number) => void }).setBitrate = (kbps) =>
    bitrates.push(kbps);

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    maxQueuedFrameBytes: -1, // every frame is "behind"; simulates saturation
    initialBitrateKbps: 2500,
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  // Two adaptation intervals, so a single step cannot be a coincidence.
  await new Promise((r) => setTimeout(r, 5000));
  ws.close();
  await server.close();

  assert.ok(bitrates.length > 0, "expected the controller to adjust the bitrate at all");
  assert.ok(
    bitrates[bitrates.length - 1] < 2500,
    `expected congestion to lower the bitrate below 2500, got ${JSON.stringify(bitrates)}`,
  );
});

/**
 * When bitrate alone cannot rescue a congested link, quality must step down.
 *
 * Below roughly 400kbps there are not enough bits to describe a full-size frame
 * 60 times a second, and the picture turns to mush rather than degrading
 * gracefully. Spending the remaining budget on fewer pixels and fewer frames is
 * what keeps text legible — so the controller is expected to walk DOWN the
 * quality ladder once bitrate has bottomed out, not sit at the floor producing
 * an unreadable image.
 *
 * Congestion is simulated by a drop threshold of -1, so every frame takes the
 * backpressure path exactly as on a saturated link.
 */
test("steps resolution and fps down when bitrate hits the floor", async () => {
  const scales: Array<{ width: number; fps: number }> = [];
  const bitrates: number[] = [];
  const capture = fakeCapture();
  const withHooks = capture as unknown as {
    setBitrate: (k: number) => void;
    setScale: (w: number, f: number) => void;
  };
  withHooks.setBitrate = (kbps) => bitrates.push(kbps);
  withHooks.setScale = (width, fps) => scales.push({ width, fps });

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    maxQueuedFrameBytes: -1, // permanently "behind"
    initialBitrateKbps: 700, // close to the floor, so it bottoms out quickly
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  // Long enough for bitrate to reach the floor AND for the descent to be
  // confirmed: the ladder deliberately waits LADDER_DOWN_CONFIRM checks at the
  // floor before spending a rung, so a step is ~5 ticks away, not ~2.
  await new Promise((r) => setTimeout(r, 15000));
  ws.close();
  await server.close();

  assert.ok(
    bitrates.length > 0 && bitrates[bitrates.length - 1] <= 400,
    `expected bitrate to reach the floor, got ${JSON.stringify(bitrates)}`,
  );
  assert.ok(
    scales.length > 0,
    "expected the controller to step quality down once bitrate could not recover the link",
  );
  const last = scales[scales.length - 1];
  assert.ok(
    last.width < 1920 || last.fps < 60,
    `expected a smaller frame or lower fps, got ${JSON.stringify(last)}`,
  );
});

test("getClipboard replies with the agent's clipboard text; setClipboard changes it", async () => {
  const clipboard = fakeClipboard("initial-agent-text");
  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture: fakeCapture(),
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard,
    refreshHz: 60,
  });
  await server.listen();

  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  const contentPromise = nextMessage(ws, "clipboardContent");
  ws.send(encodeMessage({ type: "getClipboard" }));
  const content = await contentPromise;
  assert.equal(content.type, "clipboardContent");
  if (content.type === "clipboardContent") {
    assert.equal(content.text, "initial-agent-text");
  }

  ws.send(encodeMessage({ type: "setClipboard", text: "from-the-client" }));
  // No reply to wait on for setClipboard; give the agent's handler a moment.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await clipboard.getContent(), "from-the-client");

  ws.close();
  await server.close();
});

/**
 * A congested session must not leave the encoder small for the next one.
 *
 * The encoder is shared process-wide, so a session that walked the ladder down
 * used to hand the next client a narrow picture while the controller reset its
 * rung to 0 — "already at the top" — and nothing ever stepped it back up. The
 * agent stayed degraded until it was restarted.
 */
test("restores the encoder to full quality when the session ends", async () => {
  const scales: Array<{ width: number; fps: number }> = [];
  const capture = fakeCapture();
  const withHooks = capture as unknown as {
    setBitrate: (k: number) => void;
    setScale: (w: number, f: number) => void;
    encodeWidth: number;
    encodeFps: number;
  };
  withHooks.encodeWidth = 1280;
  withHooks.encodeFps = 59;
  withHooks.setBitrate = () => {};
  withHooks.setScale = (width, fps) => {
    scales.push({ width, fps });
    // Mirror H264Capture: the live geometry follows the scale request, which
    // is exactly what made reading it back to build the ladder unsafe.
    withHooks.encodeWidth = width;
    withHooks.encodeFps = fps;
  };

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 59,
    maxQueuedFrameBytes: -1, // permanently "behind", so it walks down
    initialBitrateKbps: 700,
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  // As above: bitrate must bottom out and the descent be confirmed.
  await new Promise((r) => setTimeout(r, 15000));
  const duringSession = scales.length;
  assert.ok(duringSession > 0, "expected the congested link to step quality down");
  // Rung 1 is the SAME width at 30fps -- the ladder gives up frame rate before
  // pixels -- so "stepped down" means either dimension moved, not width alone.
  assert.ok(
    withHooks.encodeWidth < 1280 || withHooks.encodeFps < 59,
    `expected the encoder to have stepped down mid-session, got ${withHooks.encodeWidth}x@${withHooks.encodeFps}`,
  );

  ws.close();
  await server.close();

  const last = scales[scales.length - 1];
  assert.deepEqual(
    last,
    { width: 1280, fps: 59 },
    `expected a reset to the starting geometry, got ${JSON.stringify(last)}`,
  );
  assert.equal(withHooks.encodeWidth, 1280, "next session must start at full width");
});

/**
 * A pinned resolution is the viewer's explicit choice and must not be
 * overridden. Auto mode answers congestion by shrinking the picture; manual
 * mode answers it by queueing frames, exactly as a video player buffers rather
 * than silently switching you to 240p.
 */
test("a pinned resolution survives a congested link", async () => {
  const scales: Array<{ width: number; fps: number }> = [];
  const capture = fakeCapture();
  const withHooks = capture as unknown as {
    setBitrate: (k: number) => void;
    setScale: (w: number, f: number) => void;
    encodeWidth: number;
    encodeFps: number;
  };
  withHooks.encodeWidth = 1280;
  withHooks.encodeFps = 59;
  withHooks.setBitrate = () => {};
  withHooks.setScale = (width, fps) => {
    scales.push({ width, fps });
    withHooks.encodeWidth = width;
    withHooks.encodeFps = fps;
  };

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 59,
    maxQueuedFrameBytes: -1, // permanently "behind"
    initialBitrateKbps: 700,
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  // Pin a mid rung, then let the link stay congested for several adapt ticks.
  const pinnedReport = nextMessage(ws, "qualityState");
  ws.send(encodeMessage({ type: "setQuality", width: 1024 }));
  const report = await pinnedReport;
  assert.equal(report.type === "qualityState" && report.mode, "manual");

  const afterPin = scales.length;
  await new Promise((r) => setTimeout(r, 9000));

  const movedSincePin = scales.slice(afterPin);
  assert.deepEqual(
    movedSincePin,
    [],
    `pinned quality must not be changed by the controller, got ${JSON.stringify(movedSincePin)}`,
  );
  assert.equal(withHooks.encodeWidth, 1024, "encoder must still be at the pinned width");

  // Handing control back to Auto lets the controller move it again.
  ws.send(encodeMessage({ type: "setQuality", width: null }));
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(scales.length > afterPin, "expected auto to reassert control");

  ws.close();
  await server.close();
});

/**
 * Backpressure must follow the transport that actually carries video.
 *
 * Once a QUIC session attaches, frames go over WebTransport and the WebSocket
 * carries only control messages — so measuring the WebSocket's queue meant the
 * link always looked idle and nothing was ever dropped, however far behind
 * QUIC fell. Observed in the wild as "[adapt] ... (backlog 674KB, 0 dropped)".
 */
test("drops frames when the WebTransport backlog is behind, not just the WebSocket", async () => {
  const sent: number[] = [];
  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture: fakeCapture(),
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    webtransport: {
      port: 4433,
      certHash: "a".repeat(64),
      hasSession: true,
      // Far beyond the drop threshold: every frame must be discarded.
      backlogBytes: 5_000_000,
      async send(payload: Uint8Array) {
        sent.push(payload.length);
        return true;
      },
    },
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;
  ws.send(encodeMessage({ type: "setMode", mode: "video", intervalMs: 17 }));

  await new Promise((r) => setTimeout(r, 1500));
  ws.close();
  await server.close();

  assert.deepEqual(
    sent,
    [],
    `a saturated QUIC session must drop rather than queue, got ${sent.length} frames sent`,
  );
});

/**
 * Auto -> pinned -> Auto must not collapse the picture.
 *
 * While pinned the ladder is frozen but the BITRATE controller keeps running,
 * so a congested link winds bitrate down to the floor. Returning to Auto then
 * met "congested and at the floor" on the very first tick, and the old code
 * both snapped back to the pinned (full) width and gave up a rung every tick
 * afterwards — walking to the 320px floor every single time.
 */
test("returning to auto after a pin does not walk the ladder to the bottom", async () => {
  const scales: Array<{ width: number; fps: number }> = [];
  const capture = fakeCapture();
  const withHooks = capture as unknown as {
    setBitrate: (k: number) => void;
    setScale: (w: number, f: number) => void;
    encodeWidth: number;
    encodeFps: number;
  };
  withHooks.encodeWidth = 1920;
  withHooks.encodeFps = 60;
  withHooks.setBitrate = () => {};
  withHooks.setScale = (width, fps) => {
    scales.push({ width, fps });
    withHooks.encodeWidth = width;
    withHooks.encodeFps = fps;
  };

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    maxQueuedFrameBytes: -1, // permanently congested, as on the link that showed this
    initialBitrateKbps: 500, // bottoms out almost immediately
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;

  // Pin the top rung on a link that cannot carry it, exactly as a viewer would.
  ws.send(encodeMessage({ type: "setQuality", width: 1920 }));
  await new Promise((r) => setTimeout(r, 5000));

  // Hand control back; this is the moment the collapse used to start.
  const afterUnpin = scales.length;
  ws.send(encodeMessage({ type: "setQuality", width: null }));
  await new Promise((r) => setTimeout(r, 9000));
  // Snapshot BEFORE teardown: closing the session restores baseline quality,
  // which is another setScale and not a ladder move.
  const movesAfterUnpin = scales.slice(afterUnpin + 1); // skip the resume itself
  ws.close();
  await server.close();
  const widths = movesAfterUnpin.map((m) => m.width);
  // 9s is ~4 ticks. Unconfirmed descent gave up a rung per tick; confirmation
  // caps it at 1, and nothing may reach the 320px floor this quickly.
  assert.ok(
    movesAfterUnpin.length <= 2,
    `expected at most 2 rungs in ~4 ticks, got ${widths.length}: ${JSON.stringify(widths)}`,
  );
  assert.ok(
    !widths.includes(320),
    `must not collapse to the floor on un-pin, got ${JSON.stringify(widths)}`,
  );
});

/**
 * A keyframe burst is a transient, not congestion.
 *
 * The controller read `peakBacklog` — the MAXIMUM queue depth seen during the
 * 2s window — against ADAPT_BACKLOG_BYTES, a threshold that means "the queue is
 * standing behind". Those are different quantities. Every GOP boundary emits an
 * IDR carrying the whole picture, which momentarily fills the queue and drains
 * again immediately; the peak nevertheless reported congestion on EVERY tick.
 *
 * Lowering the bitrate cannot shrink that burst when the resolution is pinned —
 * an IDR's size is set by the pixel count — so the controller ratcheted 2500 ->
 * 400kbps and stayed at the floor for the rest of the session, on a link with
 * ten times the necessary capacity. Observed as a permanent "0.4 Mbps" in the
 * status strip, with no dropped frames and a perfectly healthy picture.
 */
test("a periodic keyframe burst is not mistaken for a congested link", async () => {
  const LINK_KBPS = 8000;
  const FPS = 30;
  // Drains at LINK_KBPS: a queue that a healthy link empties between bursts.
  let queue = 0;
  let lastDrain = Date.now();
  const drain = () => {
    const now = Date.now();
    queue = Math.max(0, queue - ((LINK_KBPS * 1000) / 8) * ((now - lastDrain) / 1000));
    lastDrain = now;
    return queue;
  };

  let bitrateKbps = 2500;
  let idrDue = true;
  const capture = new CaptureLoop(async (): Promise<CapturedImage> => {
    const avg = Math.round((bitrateKbps * 1000) / 8 / FPS);
    // 250KB: a 1228p IDR, whose size the target bitrate cannot shrink away.
    const size = idrDue ? 250 * 1024 : avg;
    const keyframe = idrDue;
    idrDue = false;
    return { data: new Uint8Array(size), format: FrameFormat.H264, keyframe };
  }, FPS);
  const gop = setInterval(() => {
    idrDue = true;
  }, 2000);

  const hooks = capture as unknown as {
    setBitrate: (k: number) => void;
    setScale: (w: number, f: number) => void;
    encodeWidth: number;
    encodeFps: number;
  };
  hooks.encodeWidth = 1228;
  hooks.encodeFps = FPS;
  hooks.setBitrate = (k) => {
    bitrateKbps = k;
    idrDue = true; // reopening the encoder forces an IDR
  };
  hooks.setScale = () => {};

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    webtransport: {
      port: 4433,
      certHash: "a".repeat(64),
      hasSession: true,
      get backlogBytes() {
        return drain();
      },
      async send(payload: Uint8Array) {
        drain();
        queue += payload.byteLength;
        return true;
      },
    },
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const reported: number[] = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = parseAgentMessage(data.toString());
    if (msg.type === "qualityState" && msg.bitrateKbps !== null) reported.push(msg.bitrateKbps);
  });
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;
  ws.send(encodeMessage({ type: "setMode", mode: "video", intervalMs: Math.round(1000 / FPS) }));
  // Pin the rung, as the viewer in the report had: this is what stops the IDR
  // from shrinking along with the bitrate.
  ws.send(encodeMessage({ type: "setQuality", width: 1228, fps: FPS }));

  await new Promise((r) => setTimeout(r, 14000));
  clearInterval(gop);
  ws.close();
  await server.close();

  const settled = reported.at(-1) ?? 0;
  assert.ok(
    settled > 1000,
    `a link with 8Mbps of headroom must not park at the bitrate floor; ` +
      `settled at ${settled}kbps (series: ${JSON.stringify(reported)})`,
  );
});

/**
 * close() must not be held open by a socket the peer never closes.
 *
 * Node's `server.close()` waits for every open connection to end, and an idle
 * keep-alive TLS socket never does — a browser leaves several behind after
 * fetching the certificate-accept page. So close() never resolved, the SIGINT
 * handler in index.ts never reached process.exit(0), and Ctrl+C printed
 * "Shutting down…" and then hung forever with no way out but kill -9.
 */
test("close() completes even while an idle TLS connection is open", async () => {
  const server = await startServer("s3cret", []);
  // A connection that finishes the handshake and then just sits there.
  const idle = tlsConnect({
    host: "127.0.0.1",
    port: server.boundPort(),
    rejectUnauthorized: false,
  });
  await once(idle, "secureConnect");

  const closed = server.close();
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("close() did not resolve within 5s")), 5000),
  );
  try {
    await Promise.race([closed, timeout]);
  } finally {
    idle.destroy();
  }
});

/**
 * The strip must report what the stream costs, not what it is allowed to cost.
 *
 * The target bitrate is a budget the encoder rarely spends in full — a static
 * desktop was measured at 1.8Mbit/s against a 60Mbit/s target — so a readout
 * built on the target reported a speed the link was not carrying. It also moved
 * only when the controller moved, which is why it appeared frozen.
 */
test("qualityState reports the measured stream rate, not the target", async () => {
  const FPS = 30;
  const BYTES_PER_FRAME = 4166; // 4166 * 30 * 8 / 1000 ~= 1000 kbit/s
  const capture = new CaptureLoop(
    async (): Promise<CapturedImage> => ({
      data: new Uint8Array(BYTES_PER_FRAME),
      format: FrameFormat.H264,
      keyframe: true,
    }),
    FPS,
  );
  const hooks = capture as unknown as {
    setBitrate: (k: number) => void;
    encodeWidth: number;
    encodeFps: number;
  };
  hooks.encodeWidth = 1280;
  hooks.encodeFps = FPS;
  hooks.setBitrate = () => {};

  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
    // A target far above what these frames cost: the two must not be confused.
    initialBitrateKbps: 20000,
  });
  await server.listen();
  const ws = new WebSocket(`wss://127.0.0.1:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const reports: Array<{ measured: number | null; target: number | null }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = parseAgentMessage(data.toString());
    if (msg.type === "qualityState") {
      reports.push({ measured: msg.measuredKbps, target: msg.bitrateKbps });
    }
  });
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;
  ws.send(encodeMessage({ type: "setMode", mode: "video", intervalMs: Math.round(1000 / FPS) }));

  await new Promise((r) => setTimeout(r, 7000));
  ws.close();
  await server.close();

  const measured = reports.map((r) => r.measured).filter((m): m is number => m !== null);
  assert.ok(measured.length >= 2, `expected repeated reports, got ${measured.length}`);
  // Reported every tick, so it keeps arriving even though the target never moves.
  const settled = measured.at(-1)!;
  assert.ok(
    settled > 600 && settled < 1400,
    `expected ~1000kbps measured, got ${settled} (series: ${JSON.stringify(measured)})`,
  );
  // And it must be its own number, nowhere near the 20000kbps budget.
  assert.ok(settled < 5000, `measured rate must not track the target, got ${settled}`);
});

/**
 * The measured rate must survive on engines with no bitrate control.
 *
 * MJPEG and screenshot-desktop expose no setBitrate, so the adaptive controller
 * never starts on them. Measuring inside its tick therefore left those paths
 * with no rate to report at all — the strip simply showed nothing.
 */
test("the measured rate is reported even without an adaptive encoder", async () => {
  const FPS = 20;
  const BYTES_PER_FRAME = 6250; // 6250 * 20 * 8 / 1000 = 1000 kbit/s
  // No setBitrate, no setScale: exactly what the MJPEG path offers.
  const capture = new CaptureLoop(
    async (): Promise<CapturedImage> => ({
      data: new Uint8Array(BYTES_PER_FRAME),
      format: FrameFormat.JPEG,
    }),
    FPS,
  );
  const server = new ConnectionServer({
    secret: "s3cret",
    nickname: "test-agent",
    port: 0,
    host: "127.0.0.1",
    tls: ephemeralTls(),
    input: fakeInput([]),
    capture,
    typingBackend: fakeTyping(),
    inputLock: fakeInputLock(),
    audio: new AudioCapture(null),
    volume: new UnsupportedVolumeController(),
    clipboard: fakeClipboard(),
    refreshHz: 60,
  });
  await server.listen();
  const ws = new WebSocket(`wss://${"127.0.0.1"}:${server.boundPort()}`, { rejectUnauthorized: false });
  await once(ws, "open");
  const measured: Array<number | null> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = parseAgentMessage(data.toString());
    if (msg.type === "qualityState") measured.push(msg.measuredKbps);
  });
  const info = nextMessage(ws, "agentInfo");
  ws.send(encodeMessage({ type: "auth", secret: "s3cret" }));
  await info;
  ws.send(encodeMessage({ type: "setMode", mode: "video", intervalMs: Math.round(1000 / FPS) }));

  await new Promise((r) => setTimeout(r, 7000));
  ws.close();
  await server.close();

  const rates = measured.filter((m): m is number => m !== null);
  assert.ok(rates.length >= 2, `expected repeated reports, got ${JSON.stringify(measured)}`);
  const settled = rates.at(-1)!;
  assert.ok(
    settled > 600 && settled < 1400,
    `expected ~1000kbps on an engine with no bitrate control, got ${settled} (${JSON.stringify(rates)})`,
  );
});
