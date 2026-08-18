import { z } from "zod";

/**
 * All JSON control messages exchanged over the WebSocket, as a discriminated
 * union on `type`. Binary frames are handled separately (see frame.ts).
 *
 * Coordinates on mouse messages are normalized 0..1 relative to the agent's
 * screen so the client never needs to know the agent's real resolution.
 */

export const StreamMode = z.enum(["screenshot", "video"]);
export type StreamMode = z.infer<typeof StreamMode>;

// ---- client -> agent ----

export const AuthMessage = z.object({
  type: z.literal("auth"),
  secret: z.string().min(1),
});

export const SetModeMessage = z.object({
  type: z.literal("setMode"),
  mode: StreamMode,
  // Min 4ms allows up to ~250fps requests (agent caps the real rate to 120 and
  // to what the display/capture can sustain). It must stay below the highest-fps
  // interval the client sends — 120fps = ~8ms, 60fps = ~17ms — or the agent
  // rejects setMode as malformed and streaming stalls at the default interval.
  intervalMs: z.number().int().min(4).max(60_000),
});

/**
 * Pick a streaming resolution, YouTube-style.
 *
 * `width: null` is Auto — the adaptive controller owns quality, exactly as
 * before. A concrete width PINS that rung: the controller stops moving
 * resolution and the link is expected to buffer rather than quietly hand back
 * a smaller picture, because a size the viewer chose explicitly should not be
 * overridden without them noticing.
 */
export const SetQualityMessage = z.object({
  type: z.literal("setQuality"),
  width: z.number().int().positive().nullable(),
  fps: z.number().int().positive().optional(),
});

export const MouseButton = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButton>;

export const MouseMessage = z.object({
  type: z.literal("mouse"),
  action: z.enum(["move", "down", "up", "click", "scroll"]),
  // normalized 0..1; required for move/down/up/click, optional for scroll
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
  button: MouseButton.optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
});
export type MouseMessage = z.infer<typeof MouseMessage>;

export const KeyMessage = z.object({
  type: z.literal("key"),
  action: z.enum(["down", "up", "press"]),
  // a single key name, e.g. "a", "Enter", "ArrowLeft", "F5"
  key: z.string().min(1),
  modifiers: z
    .array(z.enum(["ctrl", "alt", "shift", "meta"]))
    .optional()
    .default([]),
});
export type KeyMessage = z.infer<typeof KeyMessage>;

export const AutotypeProfile = z.object({
  // average delay between keystrokes, ms
  baseDelayMs: z.number().int().min(0).max(2000).default(90),
  // +/- random jitter applied to each delay, ms
  jitterMs: z.number().int().min(0).max(2000).default(60),
  // probability [0..1] of a mistyped char that gets backspaced & corrected
  typoRate: z.number().min(0).max(1).default(0.03),
});
export type AutotypeProfile = z.infer<typeof AutotypeProfile>;

export const AutotypeMessage = z.object({
  type: z.literal("autotype"),
  text: z.string(),
  profile: AutotypeProfile.default({
    baseDelayMs: 90,
    jitterMs: 60,
    typoRate: 0.03,
  }),
});

/** Cancel an in-progress autotype run. No-op if nothing is typing. */
export const CancelAutotypeMessage = z.object({
  type: z.literal("cancelAutotype"),
});

/** Ask the agent to run its self-diagnostics and report back. */
export const RunDiagnosticsMessage = z.object({
  type: z.literal("runDiagnostics"),
});

/**
 * Ask the agent to lock (or unlock) the physical keyboard + mouse at the agent
 * machine, so only the client controls it. The agent auto-releases the lock
 * after a period of no client activity, and unlocks if the client disconnects.
 */
export const SetInputLockMessage = z.object({
  type: z.literal("setInputLock"),
  locked: z.boolean(),
});

/**
 * Ask the agent to start (or stop) capturing its system output audio and
 * streaming it as binary audio frames. Used by the client only to transcribe —
 * there is no client-side playback. No-op if the agent has no loopback device.
 */
export const SetAudioMessage = z.object({
  type: z.literal("setAudio"),
  enabled: z.boolean(),
});

/**
 * Set the agent machine's own output volume, or mute it.
 *
 * Distinct from anything the client plays locally: this changes what the remote
 * machine itself is doing, so muting it silences the person sitting in front of
 * it as well as the stream. That is the point — it is the same control you
 * would reach for if you were there — but it is why the two volumes are
 * deliberately separate controls rather than one slider.
 *
 * `level` is a percentage so the wire format does not commit to any platform's
 * scale; each agent maps it onto whatever its OS uses.
 */
export const SetOutputVolumeMessage = z.object({
  type: z.literal("setOutputVolume"),
  level: z.number().min(0).max(100),
});

export const SetOutputMuteMessage = z.object({
  type: z.literal("setOutputMute"),
  muted: z.boolean(),
});

/**
 * Ask the agent for its current clipboard text. Text-only, matching nut-js's
 * own clipboard API — no images/rich content.
 */
export const GetClipboardMessage = z.object({
  type: z.literal("getClipboard"),
});

/** Ask the agent to set its clipboard to this text. */
export const SetClipboardMessage = z.object({
  type: z.literal("setClipboard"),
  text: z.string(),
});

// ---- agent -> client ----

export const AuthResultMessage = z.object({
  type: z.literal("authResult"),
  ok: z.boolean(),
  reason: z.string().optional(),
});

export const AgentInfoMessage = z.object({
  type: z.literal("agentInfo"),
  screenWidth: z.number().int().positive(),
  screenHeight: z.number().int().positive(),
  nickname: z.string(),
  /** Detected display refresh rate (Hz); the client uses it to target fps. */
  refreshHz: z.number().positive().optional(),
  /**
   * How to reach the agent's QUIC/WebTransport video listener, when it has one.
   *
   * Video over QUIC avoids TCP's head-of-line blocking: on the WebSocket a lost
   * packet stalls every frame behind it while it is retransmitted, and for live
   * video that retransmission is usually worthless because the frame is stale
   * by the time it lands.
   *
   * The certificate is self-signed and verified by hash rather than by the
   * browser's trust store, so `certHash` must reach the client for it to
   * connect at all. Sent here, after authentication, rather than advertised
   * publicly — only a client that already proved it knows the secret learns it.
   *
   * Absent when the agent could not start the listener, in which case the
   * client simply keeps taking video over the WebSocket.
   */
  webtransport: z
    .object({
      port: z.number().int().positive(),
      /** Lowercase hex SHA-256 of the DER certificate. */
      certHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});

export const AutotypeProgressMessage = z.object({
  type: z.literal("autotypeProgress"),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
});

export const AutotypeDoneMessage = z.object({
  type: z.literal("autotypeDone"),
  /** True if the run was cancelled before finishing. */
  cancelled: z.boolean().optional().default(false),
});

/**
 * The stream quality the agent is currently encoding at.
 *
 * Sent whenever the adaptive controller changes resolution/fps, and once on
 * connect, so the viewer can tell a genuinely soft picture from a link that
 * quietly stepped down. Without it a degraded session is indistinguishable
 * from a broken one.
 */
export const QualityStateMessage = z.object({
  type: z.literal("qualityState"),
  width: z.number().int().positive(),
  fps: z.number().int().positive(),
  /**
   * What the encoder is ALLOWED to spend — the adaptive controller's target,
   * not what the stream costs. Null until the controller has run its first tick.
   */
  bitrateKbps: z.number().int().positive().nullable(),
  /**
   * What the stream is ACTUALLY costing: bytes handed to the transport over the
   * last reporting window, as kbit/s.
   *
   * The two differ by a lot and in both directions, which is why the target
   * alone made a poor readout. A static desktop spends a fraction of its budget
   * (measured 1.8Mbit/s against a 60Mbit/s target), so a strip showing the
   * target reports a speed the link is not carrying; and when the controller
   * bottomed out it read 0.4Mbit/s while the encoder was still sending far
   * more. Only this one answers "how fast is my connection actually going".
   *
   * Null until a full window has elapsed.
   */
  measuredKbps: z.number().int().nonnegative().nullable(),
  /** True when the controller has stepped below the session's starting rung. */
  degraded: z.boolean(),
  /** "manual" once the viewer has pinned a rung; "auto" is controller-owned. */
  mode: z.enum(["auto", "manual"]),
  /**
   * The link is behind and frames are queueing rather than being dropped.
   * Only reachable in manual mode: auto stays real-time by discarding frames.
   */
  buffering: z.boolean(),
  /** Selectable rungs, best first — the picker's menu. */
  options: z.array(z.object({ width: z.number().int().positive(), fps: z.number().int().positive() })),
});

export const AgentErrorMessage = z.object({
  type: z.literal("agentError"),
  message: z.string(),
});

/** One agent-side diagnostic result. */
export const DiagnosticStatus = z.enum(["ok", "warn", "fail"]);
export type DiagnosticStatus = z.infer<typeof DiagnosticStatus>;

export const DiagnosticCheck = z.object({
  id: z.string(),
  label: z.string(),
  status: DiagnosticStatus,
  /** What was found. */
  detail: z.string(),
  /** How to fix it, if not ok. Instructions only — never executed remotely. */
  fix: z.string().optional(),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheck>;

/** Agent's self-diagnostics report, sent in reply to runDiagnostics. */
export const DiagnosticsMessage = z.object({
  type: z.literal("diagnostics"),
  checks: z.array(DiagnosticCheck),
});

/**
 * Reports the agent's local-input lock state. `supported` is false on agent OSes
 * where physical-input blocking isn't implemented, so the client can disable the
 * control and never show a false "locked" state.
 */
export const InputLockStateMessage = z.object({
  type: z.literal("inputLockState"),
  locked: z.boolean(),
  supported: z.boolean(),
});

/**
 * Reports the agent's system-audio capture state. `supported` is false when the
 * agent has no loopback device (e.g. BlackHole/VB-Cable not installed), so the
 * client can disable the transcribe toggle and never wait on audio that will
 * never arrive.
 */
export const AudioStateMessage = z.object({
  type: z.literal("audioState"),
  enabled: z.boolean(),
  supported: z.boolean(),
});

/**
 * The agent machine's current output volume.
 *
 * `supported` is false where the platform offers no way to read or set it, so
 * the client shows the control as unavailable rather than moving a slider that
 * silently does nothing. The agent sends this on connect and after every
 * change, including changes it did not make — the level is the machine's, and
 * anyone sitting at it can turn the knob too.
 */
export const OutputVolumeStateMessage = z.object({
  type: z.literal("outputVolumeState"),
  supported: z.boolean(),
  level: z.number().min(0).max(100),
  muted: z.boolean(),
});

/** Reply to getClipboard, with the agent's current clipboard text. */
export const ClipboardContentMessage = z.object({
  type: z.literal("clipboardContent"),
  text: z.string(),
});

// ---- unions ----

/**
 * Per-frame arrival timings, reported back so the agent can measure the
 * one-way delay GRADIENT — the signal WebRTC's congestion control is built on.
 *
 * The agent's own send queue only grows once a bottleneck is already saturated,
 * which makes it a lagging indicator. Delay starts rising while the bottleneck
 * is still filling, so it leads. Measuring it needs the receiver's clock,
 * hence this message.
 *
 * Absolute clock agreement is NOT required: the estimator uses only differences
 * between consecutive frames, in which any fixed offset cancels. `sendMs` is
 * echoed from the frame header rather than looked up, so the agent needs to
 * keep no per-frame state.
 */
export const TransportFeedbackMessage = z.object({
  type: z.literal("transportFeedback"),
  samples: z
    .array(
      z.object({
        seq: z.number().int().nonnegative(),
        /** The frame header's timestamp, in the AGENT's clock. */
        sendMs: z.number(),
        /** When the client finished receiving it, in the CLIENT's clock. */
        arrivalMs: z.number(),
      }),
    )
    // Bounded so a misbehaving or hostile client cannot make the agent chew
    // through an unbounded array on the control path.
    .max(512),
});

export const ClientMessage = z.discriminatedUnion("type", [
  AuthMessage,
  SetModeMessage,
  SetQualityMessage,
  MouseMessage,
  KeyMessage,
  AutotypeMessage,
  CancelAutotypeMessage,
  SetInputLockMessage,
  SetAudioMessage,
  SetOutputVolumeMessage,
  SetOutputMuteMessage,
  RunDiagnosticsMessage,
  GetClipboardMessage,
  SetClipboardMessage,
  TransportFeedbackMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const AgentMessage = z.discriminatedUnion("type", [
  AuthResultMessage,
  AgentInfoMessage,
  AutotypeProgressMessage,
  AutotypeDoneMessage,
  AgentErrorMessage,
  InputLockStateMessage,
  AudioStateMessage,
  OutputVolumeStateMessage,
  DiagnosticsMessage,
  ClipboardContentMessage,
  QualityStateMessage,
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Any message that can appear on the wire (either direction), for parsing. */
export const AnyMessage = z.union([ClientMessage, AgentMessage]);
export type AnyMessage = z.infer<typeof AnyMessage>;

/** Parse a JSON string into a validated ClientMessage. Throws on invalid. */
export function parseClientMessage(raw: string): ClientMessage {
  return ClientMessage.parse(JSON.parse(raw));
}

/** Parse a JSON string into a validated AgentMessage. Throws on invalid. */
export function parseAgentMessage(raw: string): AgentMessage {
  return AgentMessage.parse(JSON.parse(raw));
}

/** Serialize any message to a JSON string for sending. */
export function encodeMessage(msg: ClientMessage | AgentMessage): string {
  return JSON.stringify(msg);
}
