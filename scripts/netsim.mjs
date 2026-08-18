// Network impairment proxy, for testing the adaptive controller against a link
// that misbehaves the way real ones do.
//
//   node scripts/netsim.mjs <agentPort> <listenPort> <profile>
//   node scripts/netsim.mjs 8443 8702 cliff
//
// Then point a client at http://127.0.0.1:<listenPort> (browser) or connect a
// WebSocket to ws://127.0.0.1:<listenPort> (headless). Loopback has effectively
// infinite capacity and zero delay, so nothing about congestion control can be
// exercised on it without something like this in the middle.
//
// Two things it does. It serves the agent's own client bundle over plain HTTP,
// rewriting wss:// to ws://, because a browser will not accept the agent's
// self-signed certificate without a click-through that automation cannot give.
// And it meters the agent->client direction through a token bucket with delay
// and jitter, which is where all the impairment lives; client->agent is left
// alone, being a few hundred bytes of control traffic.
//
// NOTE: video sent over WebTransport bypasses this proxy entirely and goes
// straight to the browser over QUIC. Use a WebSocket client to exercise the
// metered path.
//
// Profiles:
//   steady  a clean but limited link
//   laggy   same capacity with real-world latency and jitter
//   cliff   capacity collapses partway through and recovers -- the case the
//           controller exists for
//   wobble  continuously varying capacity, as congested wifi behaves
//
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { WebSocketServer, WebSocket } from "ws";

const AGENT_PORT = Number(process.argv[2] ?? 8700);
const PORT = Number(process.argv[3] ?? 8702);
const PROFILE = process.argv[4] ?? "steady";

/** kbit/s at time t, plus one-way delay and jitter. */
const PROFILES = {
  // A clean but limited link.
  steady: { rate: () => 3000, delayMs: 5, jitterMs: 1 },
  // Same capacity, real-world latency and jitter on top.
  laggy: { rate: () => 3000, delayMs: 80, jitterMs: 20 },
  // Capacity collapses partway through, then recovers: the case the controller
  // exists for.
  cliff: { rate: (t) => (t > 25 && t < 55 ? 800 : 10000), delayMs: 40, jitterMs: 10 },
  // Continuously varying capacity, as a congested wifi or mobile link behaves.
  wobble: {
    rate: (t) => 2500 + 1800 * Math.sin(t / 7) + 700 * Math.sin(t / 2.3),
    delayMs: 40,
    jitterMs: 15,
  },
};
/** Bottleneck buffer size. Past this the link drops rather than queues. */
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;

const profile = PROFILES[PROFILE];
if (!profile) {
  console.error(`unknown profile ${PROFILE}; have: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const rateNow = () => Math.max(200, profile.rate(elapsed()));

const server = createServer((req, res) => {
  const up = httpsRequest(
    {
      host: "127.0.0.1",
      port: AGENT_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
      rejectUnauthorized: false,
    },
    (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        let body = Buffer.concat(chunks);
        if (/javascript|html/.test(upRes.headers["content-type"] ?? "")) {
          body = Buffer.from(body.toString("utf8").replaceAll("wss://", "ws://"), "utf8");
        }
        const headers = { ...upRes.headers };
        delete headers["content-length"];
        delete headers["content-encoding"];
        res.writeHead(upRes.statusCode ?? 200, headers);
        res.end(body);
      });
    },
  );
  up.on("error", (e) => {
    res.writeHead(502);
    res.end(String(e));
  });
  req.pipe(up);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (client) => {
  const upstream = new WebSocket(`wss://127.0.0.1:${AGENT_PORT}`, { rejectUnauthorized: false });
  const pending = [];
  let sentBytes = 0;
  let queuedBytes = 0;
  let dropped = 0;

  upstream.on("open", () => {
    for (const m of pending) upstream.send(m.d, { binary: m.bin });
    pending.length = 0;
  });
  // Client -> agent is unimpaired: it is control traffic, a few hundred bytes.
  client.on("message", (d, bin) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: bin });
    else pending.push({ d, bin });
  });

  // Agent -> client is the metered direction, modelled store-and-forward.
  //
  // A frame occupies the link for as long as its bytes take to serialise at the
  // current capacity, and arrives when its LAST byte lands -- not when its
  // first does. Getting that backwards is what made an earlier version of this
  // useless for testing congestion control: frames were handed over at the
  // moment they entered the queue and the delay was applied afterwards, so
  // arrival timestamps recorded queue-entry time. Every delay-gradient reading
  // taken through it was measuring the wrong thing, and a 200KB keyframe that
  // genuinely monopolises an 800kbit/s link for two seconds looked instant.
  //
  // `linkBusyUntil` is the serialisation model: each frame starts transmitting
  // when the one before it finishes, which is precisely how a queue behind a
  // bottleneck builds the rising delay that congestion control exists to see.
  let linkBusyUntil = 0;
  upstream.on("message", (d, bin) => {
    const now = Date.now();
    // Drop-tail, as a real bottleneck behaves. Without a bound the queue simply
    // grows without limit and the proxy stops resembling a network: measured at
    // 42MB backlog and zero delivery, which no router would do.
    if (queuedBytes + d.length > MAX_QUEUE_BYTES) {
      dropped++;
      return;
    }
    queuedBytes += d.length;
    const serialiseMs = (d.length * 8) / rateNow();
    linkBusyUntil = Math.max(now, linkBusyUntil) + serialiseMs;
    const jitter = profile.jitterMs * (Math.random() * 2 - 1);
    const arriveAt = linkBusyUntil + Math.max(0, profile.delayMs + jitter);
    setTimeout(
      () => {
        queuedBytes -= d.length;
        if (client.readyState === WebSocket.OPEN) client.send(d, { binary: bin });
        sentBytes += d.length;
      },
      Math.max(0, arriveAt - now),
    );
  });

  const bye = () => {
    try {
      client.close();
    } catch {}
    try {
      upstream.close();
    } catch {}
  };
  client.on("close", bye);
  upstream.on("close", bye);
  client.on("error", bye);
  upstream.on("error", bye);

  let last = 0;
  const stats = setInterval(() => {
    const through = ((sentBytes - last) * 8) / 1000 / 2;
    last = sentBytes;
    console.log(
      `[net] t=${elapsed().toFixed(0)}s capacity=${rateNow().toFixed(0)}kbps ` +
        `delivered=${through.toFixed(0)}kbps queued=${(queuedBytes / 1024).toFixed(0)}KB ` +
        `dropped=${dropped}`,
    );
  }, 2000);
  client.on("close", () => clearInterval(stats));
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`netsim "${PROFILE}" on http://127.0.0.1:${PORT} -> agent ${AGENT_PORT}`),
);
