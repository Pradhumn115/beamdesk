import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeAudioFrame,
  decodeFrame,
  encodeMessage,
  FrameFormat,
  isAudioFrame,
  isFrame,
  parseAgentMessage,
  type AgentMessage,
  type ClientMessage,
  type DecodedAudioFrame,
  type DecodedFrame,
  type DiagnosticCheck,
} from "@bcsa/shared";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error"
  | "reconnecting";

/** Info the user provides to connect. */
export interface ConnectParams {
  /** LAN address, e.g. "192.168.1.20:8443". Tried first. */
  lanAddress: string;
  /** Optional Tailscale address, e.g. "100.x.y.z:8443". Tried second. */
  tailscaleAddress: string;
  /**
   * Optional Cloudflare Tunnel hostname, e.g. "foo.trycloudflare.com" (no port
   * — Cloudflare serves it on 443). Tried last, since it routes through
   * Cloudflare's edge and is the highest-latency path.
   */
  tunnelAddress: string;
  /** Shared secret sent in the auth message. */
  secret: string;
}

export interface AgentInfo {
  screenWidth: number;
  screenHeight: number;
  nickname: string;
  /** Agent's detected display refresh rate (Hz), if reported. */
  refreshHz?: number;
  /** Where to reach the agent's QUIC video listener, when it has one. */
  webtransport?: { port: number; certHash: string };
}

/** The latest frame, exposed as an object URL ready to draw. */
export interface LatestFrame {
  url: string;
  seq: number;
  timestamp: number;
  format: FrameFormat;
}

export interface AutotypeStatus {
  done: number;
  total: number;
  active: boolean;
}

export interface InputLockStatus {
  locked: boolean;
  /** Whether the agent's OS supports blocking local input at all. */
  supported: boolean;
}

/** The agent machine's own output volume, as last reported by the agent. */
export interface OutputVolumeStatus {
  supported: boolean;
  /** 0..100. */
  level: number;
  muted: boolean;
}

export interface AudioStatus {
  /** Whether the agent has a system-audio loopback device available. */
  supported: boolean;
  /** Whether the agent is currently streaming audio. */
  enabled: boolean;
}

export interface UseConnectionOptions {
  /** Called for every decoded audio frame (16 kHz mono PCM) from the agent. */
  onAudioFrame?: (frame: DecodedAudioFrame) => void;
  /**
   * Receives H.264 frames, which cannot be rendered as images and must go to a
   * WebCodecs decoder. Separate from the JPEG/PNG path because that path keeps
   * only the newest frame — correct for self-contained images, and corrupting
   * for a codec whose delta frames reference earlier ones.
   */
  onVideoFrame?: (frame: DecodedFrame) => void;
}

export interface DiagnosticsState {
  running: boolean;
  /** Agent-reported checks from the last run (empty until run). */
  checks: DiagnosticCheck[];
}

/**
 * What the agent is actually encoding right now.
 *
 * Null until the agent reports it (engines without scaling never do), so the
 * UI can distinguish "not reported" from "reported as full resolution".
 */
export interface QualityStatus {
  width: number;
  fps: number;
  /** The controller's target — what the encoder MAY spend, not what it does. */
  bitrateKbps: number | null;
  /** What the stream is actually costing, measured by the agent. */
  measuredKbps: number | null;
  /** The adaptive controller has stepped below the session's starting rung. */
  degraded: boolean;
  /** "manual" once a resolution has been pinned from the picker. */
  mode: "auto" | "manual";
  /** Frames are queueing to hold a pinned resolution the link can't sustain. */
  buffering: boolean;
  /** Selectable rungs, best first. */
  options: Array<{ width: number; fps: number }>;
}

export interface UseConnection {
  status: ConnectionStatus;
  /** Index into buildTargets()'s LAN/Tailscale/Tunnel order for the target
   *  that most recently completed auth, or null if not connected. */
  connectedTargetIndex: number | null;
  /**
   * Hostname of the agent currently connected to, without port or scheme.
   *
   * Needed to reach the agent's QUIC listener, which runs on a different port
   * on the same host — and which must be addressed by the SAME host string the
   * WebSocket used, since the certificate hash is bound to that listener.
   */
  connectedHost: string | null;
  agentInfo: AgentInfo | null;
  latestFrame: LatestFrame | null;
  autotype: AutotypeStatus;
  inputLock: InputLockStatus;
  audio: AudioStatus;
  outputVolume: OutputVolumeStatus;
  setOutputVolume: (level: number) => void;
  setOutputMute: (muted: boolean) => void;
  diagnostics: DiagnosticsState;
  /** Live encode resolution/fps, or null if the agent has not reported any. */
  quality: QualityStatus | null;
  /** Pin a streaming width (with its rung's fps), or null to return to Auto. */
  setQuality: (width: number | null, fps?: number) => void;
  lastError: string | null;
  params: ConnectParams;
  connect: (params: ConnectParams) => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  setAudio: (enabled: boolean) => void;
  runDiagnostics: () => void;
  /** Fetch the agent's clipboard text and write it into this browser's clipboard. */
  getClipboard: () => void;
  /**
   * Read this browser's clipboard text and set it as the agent's clipboard.
   * Resolves once the send has gone out (never rejects) — useful for
   * sequencing a paste keystroke after it.
   */
  setClipboard: () => Promise<void>;
  /** Retire the current error banner; used once a session comes up healthy. */
  clearError: () => void;
}

const STORAGE_KEY = "bcsa.connect";
const LAN_TIMEOUT_MS = 1500;
const MAX_BACKOFF_MS = 15000;

const EMPTY_PARAMS: ConnectParams = {
  lanAddress: "",
  tailscaleAddress: "",
  tunnelAddress: "",
  secret: "",
};

function loadParams(): ConnectParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PARAMS;
    const parsed = JSON.parse(raw) as Partial<ConnectParams>;
    return {
      lanAddress: parsed.lanAddress ?? "",
      tailscaleAddress: parsed.tailscaleAddress ?? "",
      tunnelAddress: parsed.tunnelAddress ?? "",
      secret: parsed.secret ?? "",
    };
  } catch {
    return EMPTY_PARAMS;
  }
}

function saveParams(p: ConnectParams): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // localStorage may be unavailable (private mode); non-fatal.
  }
}

/**
 * MIME type for the image formats that can be rendered as a Blob URL.
 *
 * H.264 is deliberately absent: it is not a self-contained image and cannot be
 * handed to an <img>. Those frames go to a WebCodecs VideoDecoder instead, so
 * the map is `Partial` and callers must handle the missing case rather than
 * silently mislabelling a video frame as an image.
 */
const mimeForFormat: Partial<Record<FrameFormat, string>> = {
  [FrameFormat.JPEG]: "image/jpeg",
  [FrameFormat.PNG]: "image/png",
};

/**
 * Turn user-entered address into a `wss://` URL, tolerating pasted schemes and
 * trailing slashes (Cloudflare prints its tunnel URL as `https://…/`). Returns
 * "" for blank input so callers can skip it.
 */
function normalizeTarget(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const hostPart = trimmed.replace(/^(wss?|https?):\/\//i, "");
  return `wss://${hostPart}`;
}

/**
 * Ordered list of wss:// URLs to try for a given set of params.
 * LAN first (fastest), then Tailscale, then Cloudflare Tunnel (highest latency).
 */
function buildTargets(p: ConnectParams): string[] {
  return [p.lanAddress, p.tailscaleAddress, p.tunnelAddress]
    .map(normalizeTarget)
    .filter((t) => t !== "");
}

/**
 * Parallel to buildTargets(), but yields each surviving entry's original
 * fixed slot (0=LAN, 1=Tailscale, 2=Tunnel) instead of its URL. Index-aligned
 * with buildTargets()'s output, so `slots[targetIdxRef.current]` recovers the
 * fixed slot for whichever target just authed — without matching by address
 * string, which would resolve to the first slot if two fields happened to
 * hold the same host.
 */
function buildTargetSlots(p: ConnectParams): number[] {
  return [p.lanAddress, p.tailscaleAddress, p.tunnelAddress]
    .map((raw, slot) => ({ url: normalizeTarget(raw), slot }))
    .filter((t) => t.url !== "")
    .map((t) => t.slot);
}

/**
 * React hook that owns the whole WebSocket lifecycle: dual-path connect with a
 * per-target timeout, auth handshake, frame decoding (latest-only), and
 * reconnect-with-backoff. All timers/sockets live in refs so re-renders never
 * disturb them.
 */
export function useConnection(opts: UseConnectionOptions = {}): UseConnection {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [connectedTargetIndex, setConnectedTargetIndex] = useState<number | null>(null);
  const [connectedHost, setConnectedHost] = useState<string | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [latestFrame, setLatestFrame] = useState<LatestFrame | null>(null);
  const [outputVolume, setOutputVolumeState] = useState<OutputVolumeStatus>({
    supported: false,
    level: 0,
    muted: false,
  });
  const [audio, setAudioState] = useState<AudioStatus>({
    supported: false,
    enabled: false,
  });
  // Keep the frame callback in a ref so the socket handlers always call the
  // latest one without needing to re-open the connection.
  const onAudioFrameRef = useRef(opts.onAudioFrame);
  onAudioFrameRef.current = opts.onAudioFrame;
  const onVideoFrameRef = useRef(opts.onVideoFrame);
  onVideoFrameRef.current = opts.onVideoFrame;
  const [autotype, setAutotype] = useState<AutotypeStatus>({
    done: 0,
    total: 0,
    active: false,
  });
  const [inputLock, setInputLock] = useState<InputLockStatus>({
    locked: false,
    supported: false,
  });
  const [quality, setQualityState] = useState<QualityStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>({
    running: false,
    checks: [],
  });
  const [lastError, setLastError] = useState<string | null>(null);
  const [params, setParams] = useState<ConnectParams>(loadParams);

  // Mutable connection state kept out of React render cycle.
  const wsRef = useRef<WebSocket | null>(null);
  const paramsRef = useRef<ConnectParams>(params);
  const targetIdxRef = useRef<number>(0);
  const connectTimerRef = useRef<number | null>(null);
  const backoffTimerRef = useRef<number | null>(null);
  const backoffMsRef = useRef<number>(500);
  // Set once auth fails, to stop the reconnect loop until a fresh connect().
  const stoppedRef = useRef<boolean>(false);
  // The object URL currently held by latestFrame, so we can revoke on replace.
  const currentUrlRef = useRef<string | null>(null);
  const authedRef = useRef<boolean>(false);

  const clearTimers = useCallback(() => {
    if (connectTimerRef.current !== null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (backoffTimerRef.current !== null) {
      window.clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  }, []);

  const revokeCurrentUrl = useCallback(() => {
    if (currentUrlRef.current) {
      URL.revokeObjectURL(currentUrlRef.current);
      currentUrlRef.current = null;
    }
  }, []);

  // Forward declaration via ref so open/close handlers can call it.
  const openTargetRef = useRef<(idx: number) => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (stoppedRef.current) return;
    setStatus("reconnecting");
    // Stale during the reconnect window otherwise: connectedTargetIndex
    // would still reflect the target from the just-dropped session, which
    // could leave transport gates (e.g. WebRTC's Tunnel gate) looking
    // connected-to-a-target when nothing is actually connected.
    setConnectedTargetIndex(null);
    const delay = backoffMsRef.current;
    backoffMsRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
    backoffTimerRef.current = window.setTimeout(() => {
      // Restart the target sweep from the top (LAN first).
      openTargetRef.current(0);
    }, delay);
  }, []);

  const handleAgentMessage = useCallback((msg: AgentMessage) => {
    switch (msg.type) {
      case "authResult": {
        if (msg.ok) {
          authedRef.current = true;
          setStatus("connected");
          // A successful connection retires whatever went wrong last time.
          // Without this the banner is sticky: a certificate hint, or a
          // transient "webrtcAnswer received with no active WebRTC session"
          // from a session that has since been replaced, stays on screen and
          // makes an already-fixed problem look broken.
          setLastError(null);
          // targetIdxRef.current indexes into buildTargets()'s *filtered*
          // array (blank fields are skipped), so it does not line up with
          // the fixed LAN(0)/Tailscale(1)/Tunnel(2) slots whenever an
          // earlier field is blank. Recover the fixed slot positionally via
          // buildTargetSlots(), which is index-aligned with buildTargets() —
          // this avoids matching by address string, which would resolve to
          // the first slot if two fields held the same host.
          const slotIdx = buildTargetSlots(paramsRef.current)[targetIdxRef.current];
          setConnectedTargetIndex(slotIdx !== undefined ? slotIdx : null);
          backoffMsRef.current = 500; // reset backoff after a good auth
        } else {
          // Auth is wrong: stop retrying entirely.
          authedRef.current = false;
          stoppedRef.current = true;
          setLastError(msg.reason ?? "Authentication failed");
          setStatus("error");
          setConnectedTargetIndex(null);
          wsRef.current?.close();
        }
        break;
      }
      case "agentInfo":
        setAgentInfo({
          screenWidth: msg.screenWidth,
          screenHeight: msg.screenHeight,
          nickname: msg.nickname,
          refreshHz: msg.refreshHz,
          webtransport: msg.webtransport,
        });
        break;
      case "autotypeProgress":
        setAutotype({ done: msg.done, total: msg.total, active: true });
        break;
      case "autotypeDone":
        // On cancel, keep the bar where it stopped; on completion, fill it.
        setAutotype((s) => ({
          done: msg.cancelled ? s.done : s.total,
          total: s.total,
          active: false,
        }));
        break;
      case "inputLockState":
        setInputLock({ locked: msg.locked, supported: msg.supported });
        break;
      case "audioState":
        setAudioState({ supported: msg.supported, enabled: msg.enabled });
        break;
      case "outputVolumeState":
        // Always the agent's reading of its own machine, never an echo of what
        // was requested — the OS clamps and quantises, and someone at the
        // machine can turn the knob too.
        setOutputVolumeState({
          supported: msg.supported,
          level: msg.level,
          muted: msg.muted,
        });
        break;
      case "qualityState":
        setQualityState({
          width: msg.width,
          fps: msg.fps,
          bitrateKbps: msg.bitrateKbps,
          measuredKbps: msg.measuredKbps,
          degraded: msg.degraded,
          mode: msg.mode,
          buffering: msg.buffering,
          options: msg.options,
        });
        break;
      case "diagnostics":
        setDiagnostics({ running: false, checks: msg.checks });
        break;
      case "clipboardContent":
        // Writing needs to happen close enough to the "Get remote clipboard"
        // click for the browser's transient-activation window to still be
        // open; a same-LAN round trip is comfortably within it.
        void navigator.clipboard.writeText(msg.text).catch((err) => {
          setLastError(`Couldn't write to your clipboard: ${String(err)}`);
        });
        break;
      case "agentError":
        setLastError(msg.message);
        break;
    }
  }, []);

  const handleFrame = useCallback(
    (decoded: DecodedFrame) => {
      // H.264 frames are not images and cannot become a Blob URL — they go to
      // the WebCodecs decoder instead, which the view owns. Routed here rather
      // than in the view so the drop-stale policy below applies only to the
      // intra-only formats it is correct for: dropping an H.264 delta frame
      // would corrupt the stream until the next keyframe.
      if (decoded.format === FrameFormat.H264) {
        onVideoFrameRef.current?.(decoded);
        return;
      }
      // Drop-stale policy: build a URL for the newest frame and revoke the
      // previous one immediately. Only the latest frame is ever kept.
      const blob = new Blob([decoded.payload as BlobPart], {
        type: mimeForFormat[decoded.format] ?? "image/jpeg",
      });
      const url = URL.createObjectURL(blob);
      revokeCurrentUrl();
      currentUrlRef.current = url;
      setLatestFrame({
        url,
        seq: decoded.seq,
        timestamp: decoded.timestamp,
        format: decoded.format,
      });
    },
    [revokeCurrentUrl],
  );

  const openTarget = useCallback(
    (idx: number) => {
      clearTimers();
      const targets = buildTargets(paramsRef.current);
      if (targets.length === 0) {
        setLastError("No address provided");
        setStatus("error");
        return;
      }
      if (idx >= targets.length) {
        // Exhausted all targets for this attempt: back off and retry.
        scheduleReconnect();
        return;
      }

      targetIdxRef.current = idx;
      authedRef.current = false;
      setStatus(idx === 0 ? "connecting" : "connecting");

      // Track whether this socket ever opened. A wss:// connection that fails
      // during the handshake is almost always an unaccepted self-signed
      // certificate, and the browser deliberately withholds the reason from the
      // WebSocket API — the page sees only "closed". Without saying so, the UI
      // shows "reconnecting…" forever, which is indistinguishable from the
      // agent being down and gives no hint that the fix is one click away.
      let everOpened = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(targets[idx]);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
        openTargetRef.current(idx + 1);
        return;
      }
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      // Per-target connect timeout: if it doesn't open in time, move on.
      connectTimerRef.current = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          try {
            ws.close();
          } catch {
            // ignore
          }
          // onclose will advance; guard against double-advance by nulling ref.
          if (wsRef.current === ws) wsRef.current = null;
          openTargetRef.current(idx + 1);
        }
      }, LAN_TIMEOUT_MS);

      ws.onopen = () => {
        everOpened = true;
        try {
          setConnectedHost(new URL(ws.url).hostname);
        } catch {
          setConnectedHost(null);
        }
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        setStatus("authenticating");
        ws.send(
          encodeMessage({ type: "auth", secret: paramsRef.current.secret }),
        );
      };

      ws.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (typeof data === "string") {
          try {
            handleAgentMessage(parseAgentMessage(data));
          } catch (err) {
            setLastError(
              `Bad message: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        if (data instanceof ArrayBuffer) {
          // Audio and video share the socket; route on the frame magic.
          if (isAudioFrame(data)) {
            const audioFrame = decodeAudioFrame(data);
            if (audioFrame) onAudioFrameRef.current?.(audioFrame);
          } else if (isFrame(data)) {
            const decoded = decodeFrame(data);
            if (decoded) handleFrame(decoded);
          }
        }
      };

      ws.onerror = () => {
        // Errors are followed by a close event; let onclose drive transitions.
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return; // superseded by a newer socket
        wsRef.current = null;
        if (!everOpened) {
          // Never completed the handshake. The agent's certificate is
          // self-signed and per-address: accepting it for one address does
          // nothing for the others the agent prints, so this is hit routinely
          // by connecting over LAN after accepting the cert over Tailscale (or
          // vice versa). Name the exact URL to open, since the browser will not.
          setLastError(
            `Couldn't open a secure connection to ${targets[idx].replace(/^wss:\/\//, "")}. ` +
              `If this is the agent's address, open ${targets[idx].replace(/^wss:\/\//, "https://")} ` +
              `in a tab and accept its certificate, then press Connect again. ` +
              `The certificate must be accepted separately for every address.`,
          );
        }
        if (connectTimerRef.current !== null) {
          window.clearTimeout(connectTimerRef.current);
          connectTimerRef.current = null;
        }
        if (stoppedRef.current) {
          // Auth failed or user disconnected: do not reconnect.
          return;
        }
        if (authedRef.current) {
          // Unexpected drop after a good session: reconnect with backoff.
          authedRef.current = false;
          scheduleReconnect();
        } else {
          // Never authed on this target: try the next target immediately.
          openTargetRef.current(idx + 1);
        }
      };
    },
    [clearTimers, handleAgentMessage, handleFrame, scheduleReconnect],
  );

  useEffect(() => {
    openTargetRef.current = openTarget;
  }, [openTarget]);

  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    clearTimers();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    authedRef.current = false;
    revokeCurrentUrl();
    setLatestFrame(null);
    setAgentInfo(null);
    setAutotype({ done: 0, total: 0, active: false });
    setInputLock({ locked: false, supported: false });
    setAudioState({ supported: false, enabled: false });
    setStatus("idle");
    setConnectedTargetIndex(null);
  }, [clearTimers, revokeCurrentUrl]);

  const connect = useCallback(
    (next: ConnectParams) => {
      // Tear down any existing connection first.
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      clearTimers();
      revokeCurrentUrl();
      setLatestFrame(null);
      setAgentInfo(null);
      setAutotype({ done: 0, total: 0, active: false });
      setInputLock({ locked: false, supported: false });
      setAudioState({ supported: false, enabled: false });
      setDiagnostics({ running: false, checks: [] });
      setLastError(null);
      setConnectedTargetIndex(null);

      paramsRef.current = next;
      setParams(next);
      saveParams(next);
      stoppedRef.current = false;
      authedRef.current = false;
      backoffMsRef.current = 500;
      openTargetRef.current(0);
    },
    [clearTimers, revokeCurrentUrl],
  );

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(msg));
    }
  }, []);

  const setOutputVolume = useCallback(
    (level: number) => {
      // No optimistic echo: the agent replies with what the machine actually
      // ended up at, which the OS may have clamped or quantised.
      send({ type: "setOutputVolume", level });
    },
    [send],
  );

  const setOutputMute = useCallback(
    (muted: boolean) => {
      send({ type: "setOutputMute", muted });
    },
    [send],
  );

  const setQuality = useCallback(
    (width: number | null, fps?: number) => {
      // No optimistic echo: the agent snaps the request to a real ladder rung,
      // so showing the requested width could differ from what is encoded.
      send({ type: "setQuality", width, fps });
    },
    [send],
  );

  const setAudio = useCallback(
    (enabled: boolean) => {
      // Optimistic local echo; the agent confirms with an audioState message.
      setAudioState((a) => ({ ...a, enabled }));
      send({ type: "setAudio", enabled });
    },
    [send],
  );

  const runDiagnostics = useCallback(() => {
    setDiagnostics((d) => ({ ...d, running: true }));
    send({ type: "runDiagnostics" });
  }, [send]);

  const getClipboard = useCallback(() => {
    send({ type: "getClipboard" });
  }, [send]);

  const setClipboard = useCallback(() => {
    // Read must happen directly in this click handler, not after the send —
    // readText() also needs a user gesture, and there is no round trip to
    // wait on for this direction. Returns a promise so a caller that needs to
    // sequence something after the send (e.g. forwarding a paste keystroke
    // only once this has gone out) can wait on it; a read failure degrades to
    // "did nothing" rather than rejecting, so callers don't need a catch too.
    return navigator.clipboard
      .readText()
      .then((text) => {
        send({ type: "setClipboard", text });
      })
      .catch((err) => {
        setLastError(`Couldn't read your clipboard: ${String(err)}`);
      });
  }, [send]);

  const clearError = useCallback(() => setLastError(null), []);


  // Clean up on unmount.
  useEffect(() => {
    return () => {
      stoppedRef.current = true;
      clearTimers();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      revokeCurrentUrl();
    };
  }, [clearTimers, revokeCurrentUrl]);

  return {
    status,
    connectedTargetIndex,
    connectedHost,
    agentInfo,
    latestFrame,
    autotype,
    inputLock,
    audio,
    outputVolume,
    setOutputVolume,
    setOutputMute,
    diagnostics,
    quality,
    setQuality,
    lastError,
    params,
    connect,
    disconnect,
    send,
    setAudio,
    runDiagnostics,
    getClipboard,
    setClipboard,
    clearError,
  };
}
