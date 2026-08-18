import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedFrame, StreamMode } from "@bcsa/shared";
import { useConnection } from "./connect/useConnection";
import { useAudioTranscription } from "./audio/useAudioTranscription";
import { useAudioPlayback } from "./audio/useAudioPlayback";
import { useRemoteSlider } from "./audio/useRemoteSlider";
import { useRemoteControl } from "./control/useRemoteControl";
import { useTouchControl } from "./control/useTouchControl";
import { useSoftKeyboard } from "./control/useSoftKeyboard";
import { ScreenView, intervalForMode, type ContentRect } from "./view/ScreenView";
import { useFullscreen, useIdleChrome } from "./view/useFullscreen";
import type { FitMode } from "./view/fit";
import { useH264Decoder } from "./view/useH264Decoder";
import { useWebtransport } from "./connect/useWebtransport";
import { AutotypePanel } from "./autotype-panel/AutotypePanel";
import { DiagnosticsPanel } from "./diagnostics/DiagnosticsPanel";

/** Format elapsed milliseconds as M:SS for the record timer. */
function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The measured stream rate, in the unit that keeps it readable.
 *
 * A quiet desktop genuinely costs a few hundred kbit/s, and rounding that to
 * "0.2 Mbps" throws away the part that moves — the number the viewer watches to
 * tell a working link from a stalling one.
 */
function formatRate(kbps: number): string {
  return kbps < 1000 ? `${Math.round(kbps)} kbps` : `${Math.round(kbps / 100) / 10} Mbps`;
}

/** The controller's target, shown on hover: a ceiling, not a speed. */
function budgetHint(bitrateKbps: number | null): string {
  return bitrateKbps === null ? "" : ` Encoder budget: ${formatRate(bitrateKbps)}.`;
}

export function App() {
  // Owns the Whisper worker; conn feeds it decoded audio frames.
  const audioTx = useAudioTranscription();
  const listen = useAudioPlayback();
  // Declared before useConnection because the H.264 decoder needs the canvas
  // and useConnection needs the decoder's pushFrame.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // H.264 frames bypass the image path entirely and go to a WebCodecs decoder
  // that paints straight onto the Classic canvas — same surface, same click
  // mapping, so remote control needs no special case for it.
  /**
   * How the remote screen is laid out in the view.
   *
   * Kept in both a state (to re-render the toolbar and redraw still frames) and
   * a ref (because the decoder paints from a callback that outlives the render
   * which created it, and would otherwise never see a change).
   */
  const [fit, setFit] = useState<FitMode>("contain");
  const fitRef = useRef<FitMode>(fit);
  fitRef.current = fit;

  // The rectangle the frame occupies inside the canvas, shared between the view
  // (which computes it) and the control layer (which maps clicks with it).
  const contentRectRef = useRef<ContentRect>({ dx: 0, dy: 0, dw: 0, dh: 0 });

  const h264 = useH264Decoder(canvasRef, fitRef, contentRectRef);
  // Video can arrive over QUIC instead of the control socket. Frames carry the
  // same envelope either way, so both feed the same decoder and the fallback is
  // invisible to everything downstream.
  const conn = useConnection({
    onAudioFrame: (frame) => {
      // One stream, two independent consumers: transcribing ignores it when
      // off, and playback ignores it when off.
      audioTx.pushFrame(frame);
      listen.pushFrame(frame);
    },
    onVideoFrame: h264.pushFrame,
  });
  // Declared AFTER conn so QUIC frames can be timed the same way socket frames
  // are. They never pass through useConnection, so without this the agent's
  // delay-gradient estimator would go blind on exactly the transport that
  // carries the video.
  const noteArrival = conn.noteArrival;
  const wt = useWebtransport(
    useCallback(
      (frame: DecodedFrame) => {
        noteArrival(frame);
        h264.pushFrame(frame);
      },
      [noteArrival, h264],
    ),
  );
  // The agent's volume lives on another machine, so the slider needs to follow
  // the finger locally and reconcile with the machine afterwards.
  const agentVolume = useRemoteSlider(conn.outputVolume.level, conn.setOutputVolume);
  // Connect-bar form fields, seeded from cached params.
  const [lan, setLan] = useState<string>(conn.params.lanAddress);
  const [ts, setTs] = useState<string>(conn.params.tailscaleAddress);
  const [tunnel, setTunnel] = useState<string>(conn.params.tunnelAddress);
  const [secret, setSecret] = useState<string>(conn.params.secret);

  const [mode, setMode] = useState<StreamMode>("screenshot");
  const [controlEnabled, setControlEnabled] = useState<boolean>(false);
  /**
   * Open by default on desktop, closed on a phone.
   *
   * On desktop the panel is a column beside the screen view and costs nothing
   * to leave open. On a phone it is a sheet covering most of the screen, so
   * opening by default means the app starts by hiding the thing it exists to
   * show — and the connect fields are in the top bar, not in here, so nothing
   * about getting started needs it.
   */
  const [panelOpen, setPanelOpen] = useState<boolean>(
    () => !globalThis.matchMedia?.("(max-width: 860px)").matches,
  );

  // Wire mouse/keyboard to the canvas, gated by the control toggle. Video of
  // every kind lands on that one surface, so control needs no special case.
  useRemoteControl(
    canvasRef,
    contentRectRef,
    conn.send,
    controlEnabled,
    conn.getClipboard,
    conn.setClipboard,
  );
  // Touch gestures and the on-screen keyboard are the mobile equivalents of the
  // two halves above: a canvas gets neither for free.
  const stageRef = useRef<HTMLElement>(null);
  const fullscreen = useFullscreen(stageRef);
  // Controls are worth less than the pixels they cover, until you reach for
  // them — so they fade while fullscreen and idle, and return on any activity.
  const chrome = useIdleChrome(fullscreen.active);

  const softKeyboard = useSoftKeyboard(conn.send, controlEnabled);
  useTouchControl(canvasRef, contentRectRef, conn.send, controlEnabled, softKeyboard.show);

  const connected = conn.status === "connected";

  const refreshHz = conn.agentInfo?.refreshHz;

  // Attach to the agent's QUIC listener once it advertises one.
  //
  // Opportunistic: a browser without WebTransport, or a Cloudflare Tunnel with
  // no UDP route, simply never connects and keeps taking video over the
  // WebSocket — which the agent goes on sending until a session appears.
  const wtInfo = conn.agentInfo?.webtransport;
  const wtHost = conn.connectedHost;
  useEffect(() => {
    if (!connected || !wtInfo || !wtHost) {
      wt.disconnect();
      return;
    }
    wt.connect(wtHost, wtInfo.port, wtInfo.certHash);
    return () => wt.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, wtInfo?.port, wtInfo?.certHash, wtHost]);

  // On (re)connect, tell the agent the current mode so streaming starts, and
  // auto-run diagnostics once so the panel is populated without a manual press.
  useEffect(() => {
    if (!connected) return;
    conn.send({ type: "setMode", mode, intervalMs: intervalForMode(mode, refreshHz) });
    conn.runDiagnostics();
    // Only fire on transition into connected; mode changes send their own
    // setMode from onSetMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const onConnect = () => {
    conn.connect({
      lanAddress: lan,
      tailscaleAddress: ts,
      tunnelAddress: tunnel,
      secret,
    });
  };

  const onSetMode = (next: StreamMode) => {
    setMode(next);
    conn.send({ type: "setMode", mode: next, intervalMs: intervalForMode(next, refreshHz) });
  };

  // Live captions: continuous, VAD-gated transcription.
  const onToggleLive = (on: boolean) => {
    if (on) audioTx.startLive();
    else audioTx.stopLive();
  };

  // Record mode: buffer the take while recording; transcribe it on pause.
  const onRecordToggle = () => {
    if (audioTx.recording) void audioTx.pauseRecording();
    else audioTx.startRecording();
  };

  // Switching modes stops any active capture/transcription first.
  const onSwitchMode = (next: "live" | "record") => {
    if (next === audioTx.mode) return;
    audioTx.setMode(next);
  };

  /**
   * The agent captures while anything wants audio, and stops when nothing does.
   *
   * Previously each transcription control started and stopped the capture
   * itself, which was correct only while transcription was the sole consumer.
   * With listening added, "stop transcribing" would also have silenced audio
   * the user had deliberately turned on. Deriving the capture state from who
   * actually wants it makes that impossible to get wrong as consumers are
   * added.
   */
  const audioWanted = listen.enabled || audioTx.liveActive || audioTx.recording;
  useEffect(() => {
    if (!connected) return;
    conn.setAudio(audioWanted);
  }, [audioWanted, connected, conn.setAudio]);

  // Stop live transcription if the connection drops (audio stops arriving),
  // and drop the H.264 decoder with it — it was primed against a keyframe from
  // a stream that no longer exists, and reusing it against the next one leaves
  // the picture frozen or corrupt.
  useEffect(() => {
    if (!connected) {
      audioTx.stopLive();
      // Playback too: the queue would otherwise sit holding its last scheduled
      // chunks with nothing arriving to follow them, and the context would stay
      // open on a dead stream.
      listen.setEnabled(false);
      h264.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const statusText = (() => {
    switch (conn.status) {
      case "connected":
        return "connected";
      case "connecting":
        return "connecting…";
      case "authenticating":
        return "authenticating…";
      case "reconnecting":
        return "reconnecting…";
      case "error":
        return "error";
      default:
        return "idle";
    }
  })();

  const canConnect = conn.status === "idle" || conn.status === "error";

  return (
    <div
      className={`app${fullscreen.active ? " immersive" : ""}${
        fullscreen.active && !chrome.visible ? " chrome-hidden" : ""
      }`}
    >
      <header className="topbar">
        <div className={`brand ${connected ? "is-live" : ""}`}>
          <span className="brand-mark" />
          <span className="brand-name">
            beam<b>desk</b>
          </span>
          <span className="live-pill">{connected ? "LIVE" : "OFFLINE"}</span>
        </div>

        <div className="conn-fields">
          <input
            className="field-input"
            placeholder="LAN  host:port"
            value={lan}
            onChange={(e) => setLan(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            placeholder="Tailscale  host:port"
            value={ts}
            onChange={(e) => setTs(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            placeholder="Tunnel  host"
            value={tunnel}
            onChange={(e) => setTunnel(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            className="field-input"
            type="password"
            placeholder="secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>

        <div className="topbar-actions">
          {canConnect ? (
            <button className="btn btn-primary" onClick={onConnect}>
              Connect
            </button>
          ) : (
            <button className="btn btn-danger" onClick={conn.disconnect}>
              Disconnect
            </button>
          )}
          <button
            className="btn btn-ghost panel-toggle-desktop"
            onClick={() => setPanelOpen((v) => !v)}
          >
            {panelOpen ? "Hide" : "Panel"}
          </button>
        </div>
      </header>

      <div className="status-strip">
        <span className={`status-dot s-${conn.status}`} />
        <span className="status-text">{statusText}</span>
        {connected && conn.agentInfo && (
          <>
            <span className="status-sep">/</span>
            <span>{conn.agentInfo.nickname}</span>
            <span className="status-sep">/</span>
            <span>
              {conn.agentInfo.screenWidth}×{conn.agentInfo.screenHeight}
            </span>
          </>
        )}
        {connected && conn.quality && (
          <>
            <span className="status-sep">/</span>
            {/* The stream's own resolution, which is NOT the agent's screen
                size once the adaptive controller has stepped down. */}
            <span
              className={conn.quality.degraded ? "status-degraded" : undefined}
              title={
                conn.quality.degraded
                  ? `Reduced to fit the link; recovers automatically when it improves.${budgetHint(conn.quality.bitrateKbps)}`
                  : `Streaming at full resolution.${budgetHint(conn.quality.bitrateKbps)}`
              }
            >
              {conn.quality.width}p @ {conn.quality.fps}fps
              {/* The MEASURED rate, not the controller's target. The target is
                  a budget the encoder rarely spends in full -- a static desktop
                  costs a fraction of it -- so showing it reported a speed the
                  link was not carrying. */}
              {conn.quality.measuredKbps !== null &&
                ` · ${formatRate(conn.quality.measuredKbps)}`}
              {conn.quality.degraded && " ↓"}
            </span>
            <select
              className="quality-picker"
              aria-label="Streaming resolution"
              // Auto is the empty value; a pinned rung shows its own width even
              // though the agent keeps reporting the live geometry.
              value={
                conn.quality.mode === "auto"
                  ? ""
                  : `${conn.quality.width}x${conn.quality.fps}`
              }
              onChange={(e) => {
                if (e.target.value === "") return conn.setQuality(null);
                const [w, f] = e.target.value.split("x").map(Number);
                conn.setQuality(w, f);
              }}
            >
              <option value="">
                Auto{conn.quality.mode === "auto" ? ` (${conn.quality.width}p)` : ""}
              </option>
              {/* The ladder can hold two rungs at the same width but different
                  fps (full-rate and 30fps), which would render as duplicate
                  entries with the same value — the second unreachable. Label
                  the fps whenever a width repeats. */}
              {conn.quality.options.map((o, i, all) => {
                const ambiguous = all.some((x, j) => j !== i && x.width === o.width);
                return (
                  <option key={`${o.width}x${o.fps}`} value={`${o.width}x${o.fps}`}>
                    {o.width}p{ambiguous || o.fps < 30 ? ` @ ${o.fps}fps` : ""}
                  </option>
                );
              })}
            </select>
            {conn.quality.buffering && (
              <span className="status-buffering" title="Holding your chosen resolution; the link is behind">
                <span className="spinner" aria-hidden="true" /> buffering
              </span>
            )}
          </>
        )}
        {conn.lastError && (
          <>
            <span className="status-sep">/</span>
            <span className="status-error">{conn.lastError}</span>
          </>
        )}
      </div>

      <div className={`workspace ${panelOpen ? "" : "panel-closed"}`}>
        <main className="stage" ref={stageRef}>
          <ScreenView
            frame={conn.latestFrame}
            mode={mode}
            controlEnabled={controlEnabled}
            onSetMode={onSetMode}
            canvasRef={canvasRef}
            contentRectRef={contentRectRef}
            refreshHz={refreshHz}
            h264={{ active: h264.active, fps: h264.fps, status: h264.status, error: h264.error }}
            softKeyboard={softKeyboard}
            fullscreen={fullscreen}
            fit={fit}
            onSetFit={setFit}
            fitRef={fitRef}
          />
        </main>

        <aside className="panel">
          {/* The sheet's own way out. The floating button is off at the screen
              edge and easy to miss, so the sheet carries a close control of its
              own, at the top where a bottom sheet is grabbed. Hidden on desktop,
              where the panel is a fixed column that never covers anything. */}
          <button
            className="panel-close"
            onClick={() => setPanelOpen(false)}
            aria-label="Close controls"
          >
            <span className="panel-close-grip" />
            <span className="panel-close-text">Close</span>
          </button>
          <div className="card">
            <label className="switch">
              <input
                type="checkbox"
                checked={controlEnabled}
                onChange={(e) => setControlEnabled(e.target.checked)}
                disabled={!connected}
              />
              <span className="switch-track" />
              <span className="switch-label">Remote control</span>
            </label>
            <p className="hint">
              When on, your mouse &amp; keyboard over the screen drive the agent.
              Click the screen to focus it for keystrokes.
            </p>
          </div>

          <div className="card">
            <label className="switch">
              <input
                type="checkbox"
                checked={conn.inputLock.locked}
                onChange={(e) =>
                  conn.send({ type: "setInputLock", locked: e.target.checked })
                }
                disabled={!connected || !conn.inputLock.supported}
              />
              <span className="switch-track" />
              <span className="switch-label">Lock agent's local input</span>
            </label>
            <p className={`hint ${conn.inputLock.locked ? "warn" : ""}`}>
              {connected && !conn.inputLock.supported
                ? "Not supported on this agent's OS yet."
                : conn.inputLock.locked
                  ? "Agent's physical keyboard/mouse are blocked. Auto-releases after 10s idle or on disconnect."
                  : "Blocks the person at the agent from interfering — only your input gets through."}
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Clipboard</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn-mini"
                onClick={conn.getClipboard}
                disabled={!connected}
              >
                ⬇ Get remote clipboard
              </button>
              <button
                type="button"
                className="btn-mini"
                onClick={conn.setClipboard}
                disabled={!connected}
              >
                ⬆ Send to remote
              </button>
            </div>
            <p className="hint">
              Get pulls the agent's clipboard text into yours; Send pushes
              yours to the agent. Text only. Also happens automatically on
              Ctrl/Cmd+C, +X and +V while Remote control is on — these buttons
              are the manual fallback (e.g. after a right-click copy).
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Listen</span>
              {listen.enabled && listen.status === "running" && (
                <span className="card-note on">live</span>
              )}
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={listen.enabled}
                // The change event is a user gesture, which is what lets the
                // audio context start — a browser refuses to open one otherwise.
                onChange={(e) => listen.setEnabled(e.target.checked)}
                disabled={!connected || !conn.audio.supported}
              />
              <span className="switch-track" />
              <span className="switch-label">Play the agent's audio here</span>
            </label>
            {listen.enabled && (
              <label className="volume-row">
                <span className="volume-label">Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={listen.volume}
                  onChange={(e) => listen.setVolume(Number(e.target.value))}
                />
                <span className="volume-value">{Math.round(listen.volume * 100)}%</span>
              </label>
            )}
            {/* The agent machine's own speakers. Deliberately below the local
                volume and separately labelled: this one is heard in the room
                the agent is in, by whoever is standing there. */}
            <div className="agent-volume">
              <div className="agent-volume-head">
                <span className="agent-volume-title">Agent's own speakers</span>
                <button
                  type="button"
                  className={`btn-mini ${conn.outputVolume.muted ? "active" : ""}`}
                  onClick={() => conn.setOutputMute(!conn.outputVolume.muted)}
                  disabled={!connected || !conn.outputVolume.supported}
                >
                  {conn.outputVolume.muted ? "🔇 Unmute" : "🔈 Mute"}
                </button>
              </div>
              <label className="volume-row">
                <span className="volume-label">Level</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={agentVolume.value}
                  onChange={(e) => agentVolume.onChange(Number(e.target.value))}
                  disabled={!connected || !conn.outputVolume.supported}
                />
                <span className="volume-value">
                  {conn.outputVolume.supported ? `${agentVolume.value}%` : "—"}
                </span>
              </label>
              <p className="hint">
                {!conn.outputVolume.supported
                  ? "This agent can't control its output volume."
                  : conn.outputVolume.muted
                    ? "The agent machine is muted — silent in the room it's in, too."
                    : "Changes the volume on the agent machine itself."}
              </p>
            </div>
            <p className="hint">
              {!conn.audio.supported
                ? "This agent can't capture its system audio."
                : listen.error
                  ? listen.error
                  : listen.enabled
                    ? `Hearing the remote machine.${
                        listen.resyncs > 0 ? ` ${listen.resyncs} dropout(s).` : ""
                      }`
                    : "Hear what the agent is playing. Independent of transcription."}
            </p>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Transcribe audio</span>
              <div className="seg seg-sm">
                <button
                  className={audioTx.mode === "live" ? "active" : ""}
                  onClick={() => onSwitchMode("live")}
                  disabled={!connected || !conn.audio.supported}
                >
                  Live
                </button>
                <button
                  className={audioTx.mode === "record" ? "active" : ""}
                  onClick={() => onSwitchMode("record")}
                  disabled={!connected || !conn.audio.supported}
                >
                  Record
                </button>
              </div>
            </div>

            {/* Model picker: lets you A/B the two STT models' output quality
                and per-utterance latency (see lastLatencyMs in the hint below)
                without restarting the session. Switching re-triggers a load
                only the first time a given model is picked. */}
            <div className="model-picker">
              <span className="model-picker-label">Model</span>
              <div className="seg seg-sm">
                <button
                  className={audioTx.model === "whisper" ? "active" : ""}
                  onClick={() => audioTx.setModel("whisper")}
                  title="onnx-community/whisper-base.en"
                >
                  Whisper
                </button>
                <button
                  className={audioTx.model === "moonshine" ? "active" : ""}
                  onClick={() => audioTx.setModel("moonshine")}
                  title="onnx-community/moonshine-base-ONNX"
                >
                  Moonshine
                </button>
              </div>
            </div>

            {audioTx.mode === "live" ? (
              <label className="switch">
                <input
                  type="checkbox"
                  checked={audioTx.liveActive}
                  onChange={(e) => onToggleLive(e.target.checked)}
                  disabled={!connected || !conn.audio.supported}
                />
                <span className="switch-track" />
                <span className="switch-label">Live captions</span>
              </label>
            ) : (
              <div className="record-row">
                <button
                  className={`btn ${audioTx.recording ? "btn-danger" : "btn-primary"}`}
                  onClick={onRecordToggle}
                  disabled={!connected || !conn.audio.supported || audioTx.transcribing}
                >
                  {audioTx.recording ? "⏸ Pause & transcribe" : "⏺ Record"}
                </button>
                {(audioTx.recording || audioTx.elapsedMs > 0) && (
                  <span className="record-time">{fmtElapsed(audioTx.elapsedMs)}</span>
                )}
              </div>
            )}

            {/* Play back the last take. The same audio that was transcribed,
                kept as a WAV so a wrong-looking transcript can be checked
                against what was actually captured. */}
            {audioTx.mode === "record" && audioTx.recordingUrl && (
              <div className="playback">
                <audio controls src={audioTx.recordingUrl} className="playback-audio" />
                <a
                  className="btn btn-ghost btn-xs"
                  href={audioTx.recordingUrl}
                  download="recording.wav"
                >
                  Download
                </a>
              </div>
            )}

            <p className={`hint ${audioTx.status === "error" ? "warn" : ""}`}>
              {connected && !conn.audio.supported
                ? "No loopback device on the agent — install BlackHole (macOS) / VB-Cable (Windows). See README."
                : audioTx.status === "loading"
                  ? `Loading speech model… ${audioTx.progress}%`
                  : audioTx.status === "error"
                    ? `Model error: ${audioTx.error ?? "failed to load"}`
                    : audioTx.transcribing
                      ? "Transcribing the recording…"
                      : audioTx.mode === "record"
                        ? "Record a take, then Pause to transcribe the whole thing."
                        : audioTx.status === "ready"
                          ? `Live captions${audioTx.device ? ` · ${audioTx.device}` : ""}${audioTx.lastLatencyMs !== null ? ` · last ${audioTx.lastLatencyMs}ms` : ""} — speech only, silence skipped.`
                          : "Transcribes whatever's playing on the agent to text, in your browser."}
            </p>

            {(audioTx.transcript || audioTx.status === "ready" || audioTx.transcribing) && (
              <div className="transcript">
                <div className="transcript-head">
                  <span>Transcript</span>
                  <button className="btn btn-ghost btn-xs" onClick={audioTx.reset}>
                    Clear
                  </button>
                </div>
                <div className="transcript-body">
                  {audioTx.transcript || (
                    <span className="transcript-empty">
                      {audioTx.transcribing
                        ? "Transcribing…"
                        : audioTx.mode === "record"
                          ? "Press Record to start."
                          : "Listening…"}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <AutotypePanel
            send={conn.send}
            autotype={conn.autotype}
            disabled={!connected}
          />

          <DiagnosticsPanel
            connected={connected}
            // Video reaches the canvas by three different routes, and only one
            // of them produces a `latestFrame`. Reporting on that alone told
            // the user "no frames yet" while the screen was visibly updating.
            hasFrame={conn.latestFrame !== null || h264.active}
            videoPath={
              h264.active
                ? {
                    transport: wt.frames > 0 ? "QUIC (WebTransport)" : "WebSocket (TCP)",
                    codec: h264.codec,
                  }
                : conn.latestFrame !== null
                  ? { transport: "WebSocket (TCP)", codec: "MJPEG" }
                  : null
            }
            frameSource={
              h264.active
                ? wt.frames > 0
                  ? "H.264 over QUIC"
                  : "H.264 over WebSocket"
                : conn.latestFrame !== null
                  ? "MJPEG"
                  : undefined
            }
            diagnostics={conn.diagnostics}
            onRun={conn.runDiagnostics}
            onReconnect={onConnect}
          />
        </aside>
      </div>

      <button className="panel-fab" onClick={() => setPanelOpen((v) => !v)}>
        {panelOpen ? "✕ Close" : "⚙ Controls"}
      </button>
    </div>
  );
}
