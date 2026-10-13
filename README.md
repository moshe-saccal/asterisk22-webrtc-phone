# Asterisk 22 + PJSIP + WebRTC phone

A complete, containerised **Asterisk 22 LTS** PBX built on the PJSIP stack. It comes with a
**browser softphone** (TypeScript) for HD audio and video calls end to end.

- **Asterisk 22.11.0** built from source (SHA-256 verified), bundled pjproject, `res_srtp`
  (DTLS-SRTP), ICE, Opus with the transcoder, VP8/H.264 passthrough, and SIP over WebSocket.
- **PJSIP configuration** generated from one `users.json`, with WebRTC users, classic SIP phones
  (UDP/TCP/TLS), presence hints, and precise failure codes (busy, unavailable, not found).
- **Web phone** with sign-in, a directory with live presence, a dial pad, and audio and video calls.
  During a call you can mute, turn the camera on or off, share your screen, hold, send DTMF and do
  a blind transfer. It also has live call statistics, call history, device settings, ringtones and
  desktop notifications.
- **Node HTTPS server** that serves the app and proxies the SIP WebSocket, so the browser only
  trusts a single origin.
- **End-to-end tests** (Playwright) where real browsers call each other through Asterisk and assert
  that audio and video packets actually flow.

```
 Browser (JsSIP)                    web (Node 24)                 asterisk (22.11)
┌──────────────┐  HTTPS + WSS /ws  ┌───────────────┐  WS :8088   ┌──────────────────────┐
│  web phone   │ ────────────────▶ │ static files  │ ──────────▶ │ res_pjsip (WebSocket)│
│ getUserMedia │                   │ /api/config   │             │ dialplan / ConfBridge│
│ RTCPeerConn. │ ◀═══════ SRTP media (ICE, DTLS) over UDP 10000-10099 ══════▶ │ res_rtp_asterisk  │
└──────────────┘                   └───────────────┘             └──────────────────────┘
                                                      SIP phones ──▶ 5060/udp,tcp  5061/tls
```

## Quick start

Prerequisites: Docker with Compose v2, plus `bash` and `openssl` for the setup script.

```bash
make up
```

`make up` runs `scripts/setup.sh` the first time, which:

1. writes `.env` with this machine's LAN IP as `EXTERNAL_IP`;
2. creates `users.json` with six accounts and **random passwords**;
3. creates a local certificate authority and server certificate in `certs/`.

It then builds and starts both containers and prints the URL and accounts. Open
**https://&lt;your-ip&gt;:8443** (or https://localhost:8443), sign in as `1001` in one browser and
as `1002` in another (or a private window, or another device), and call.

> **Certificate warning?** The certificate is signed by the local CA in `certs/ca.crt`. Either
> click through the warning once, or trust the CA (see [Trusting the certificate](#trusting-the-certificate))
> so every device works without warnings. Phones and tablets need it trusted, because mobile
> browsers refuse camera access on untrusted pages.

Useful commands:

| Command             | What it does                                         |
|---------------------|------------------------------------------------------|
| `make up` / `make down` | Start / stop everything                          |
| `make logs`         | Follow the Asterisk and web logs                     |
| `make cli`          | Asterisk CLI (`pjsip show contacts`, `core show channels`, …) |
| `make status`       | Registrations and active channels                    |
| `make reload-users` | Apply `users.json` edits live                        |
| `make test`         | Browser end-to-end tests (in a container)            |

## Accounts and dialplan

Accounts live in `users.json`, which is the single source of truth for both containers:

```json
{ "extension": "1001", "name": "Alice Johnson", "type": "webrtc", "password": "…" }
```

- `type: "webrtc"` is for browsers. It uses WSS, DTLS-SRTP, ICE, AVPF, rtcp-mux and BUNDLE, with
  Opus, G.722, µ-law, VP8 and H.264.
- `type: "sip"` is for desk phones and softphones. It uses plain RTP over UDP, TCP or TLS, with
  G.722, µ-law, Opus, H.264 and VP8.

Edit the file and run `make reload-users`; no restart is needed. Passwords must be at least 8
characters and must not contain spaces, quotes, `;`, `#` or `\`. The web server only ever exposes
names and extensions, never passwords.

| Dial        | Result |
|-------------|--------|
| any user extension | Rings every device that user is signed in on (up to 5). Busy returns 486, offline returns 480 and no answer returns 480. |
| `600`       | Echo test: you hear and **see** yourself. Use it to check camera, mic and network. |
| `601`       | Plays a greeting and the time (transcoding test). |
| `602`       | Music on hold. |
| `603`       | DTMF test: reads back the digits you press, and `#` ends the input. |
| `700`       | Video conference room (ConfBridge, video follows the active talker). |
| anything else | 404 “Number not found”. |

The dialplan is in `asterisk/config/extensions.conf`. The per-user entries and BLF/presence hints
are generated into `/var/lib/asterisk/generated/` when the container starts.

### Using a regular SIP phone

Point Zoiper, Linphone, MicroSIP or a desk phone at `EXTERNAL_IP:5060` (UDP or TCP) or `:5061`
(TLS), with username and password from a `"type": "sip"` entry. It can call the browser users and
the reverse; Asterisk transcodes the audio as needed (Opus ⇄ G.722/µ-law). Video between a browser
and a SIP phone works when both sides support VP8 or H.264.

## The web phone

| Feature | Details |
|---------|---------|
| Calls | Audio or video, to contacts, recents or the dial pad (Enter = audio, Shift+Enter = video) |
| Incoming | Full-screen ringing card with *Decline*, *Audio* and *Video*. Ringtone, tab title and desktop notification. A second call while busy is declined with 486. |
| In call | Mute (`M`), camera on/off (`V`, the camera light really turns off), screen share, hold/resume (Asterisk plays music on hold), DTMF keypad (RFC 4733), blind transfer (REFER), full screen, and a movable self-view |
| Quality | Live bitrate, resolution and fps, packet loss, jitter, RTT, codec, ICE path and DTLS cipher, plus a quality indicator |
| Presence | SUBSCRIBE/NOTIFY (`presence`, PIDF) against the dialplan hints: available, ringing, on a call or offline |
| Settings | Microphone, camera and speaker selection with a live mic meter and camera preview, video quality (360p–1080p), echo cancellation, noise suppression and AGC, ringtone volume |
| Resilience | Automatic reconnect and re-registration with backoff; presence is re-subscribed after reconnecting; ICE gathering is capped, so calls start fast |

The client is written in TypeScript and bundled with Vite. Its source is in `web/src/client`:

```
sip/phone.ts       registration, call creation, presence     (JsSIP UA)
sip/call.ts        one call: media, hold, mute, camera, screen share, DTMF, transfer
sip/presence.ts    SUBSCRIBE presence + PIDF parsing
media/*.ts         devices & constraints, WebAudio tones, RTCStats sampler
ui/*.ts            views (login, contacts, recents, dial pad, call view, settings)
```

The server (`web/src/server/server.ts`) has no runtime dependencies. It provides HTTPS with
security headers (CSP, Permissions-Policy and others), SPA hosting, `GET /api/config`,
`GET /healthz` and a raw WebSocket proxy from `/ws` to Asterisk.

### Developing the client

```bash
make up                 # Asterisk + web server must be running
cd web && npm install
npm run dev             # http://localhost:5173 (proxies /ws and /api to the stack)
```

## Configuration (`.env`)

| Variable | Default | Purpose |
|----------|---------|---------|
| `EXTERNAL_IP` | detected | The address clients use to reach this host. It is advertised in ICE candidates and SDP. **It must be right for media to flow.** |
| `HTTPS_PORT` / `HTTP_PORT` | 8443 / 8080 | Web phone port; the HTTP port redirects to HTTPS |
| `RTP_PORT_START` / `RTP_PORT_END` | 10000 / 10099 | RTP range, published 1:1. Each call leg uses one port (BUNDLE + rtcp-mux). |
| `STUN_SERVER`, `TURN_*` | empty | STUN or TURN for Asterisk itself (only when `EXTERNAL_IP` alone does not describe the NAT) |
| `CLIENT_ICE_SERVERS` | `[]` | ICE servers handed to browsers, as a JSON array. Set it for remote users, e.g. `[{"urls":"stun:stun.l.google.com:19302"}]`. Add a TURN server for restrictive networks. |

After changing `.env`, run `docker compose up -d`.

### How media gets through Docker

Asterisk runs on a normal bridge network, which also works on Docker Desktop for Windows and macOS
where host networking is not available. The RTP range is published 1:1. At start-up,
`asterisk-gen-config` writes:

- `rtp.conf [ice_host_candidates]`: `<container-ip> => EXTERNAL_IP,include_local_address`. ICE
  candidates then advertise the host address, and peers on the Docker network can still use the
  container address directly.
- `external_media_address` and `external_signaling_address` on the UDP, TCP and TLS transports, for
  classic SIP phones.

### Exposing it on the Internet

1. Set `EXTERNAL_IP` to the public IP and forward TCP 8443, UDP 10000-10099 and, optionally,
   5060/5061.
2. Use a real certificate: put `server.crt` (full chain) and `server.key` in `certs/`, then run
   `make restart`.
3. Provide a TURN server (for example coturn) in `CLIENT_ICE_SERVERS` for users behind symmetric NAT.
4. Use strong passwords, and consider fail2ban on `security.log` (in the `asterisk-logs` volume).

## Trusting the certificate

`certs/ca.crt` is the local CA that signed `certs/server.crt`. The SAN list covers `localhost`, the
host name, `EXTERNAL_IP`, `127.0.0.1`, `web` and `asterisk`.

- **Windows**: `certutil -addstore -user Root ca.crt`, or double-click it → *Install* →
  *Current User* → *Trusted Root Certification Authorities*.
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain certs/ca.crt`.
- **Linux (Chrome)**: *Settings → Privacy and security → Security → Manage certificates →
  Authorities → Import*.
- **Firefox**: *Settings → Certificates → View Certificates → Authorities → Import*.
- **Android / iOS**: copy `ca.crt` to the device and install it as a CA certificate. On iOS, also
  enable it under *Settings → General → About → Certificate Trust Settings*.

If `EXTERNAL_IP` changes, run `make certs` to re-issue the server certificate.

## Testing

`make test` builds a Playwright container on the compose network. Chromium, with a fake camera and
microphone, signs in as two users and checks:

- registration and presence;
- a video call in both directions (asserts RTP audio **and** decoded video frames on both sides,
  Opus plus VP8/H.264, and camera off/on);
- an audio call with hold (music on hold), resume and mute;
- the echo test (600), and DTMF to the IVR (603);
- decline → busy, offline user → unavailable, unknown number → not found;
- blind transfer through REFER;
- call history.

To drive a desktop browser instead, start Chrome with
`--remote-debugging-port=9222 --use-fake-device-for-media-stream --use-fake-ui-for-media-stream`
and run `cd web && CDP_URL=http://127.0.0.1:9222 npx playwright test`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Sign-in hangs, then shows “Could not reach the server” | The page or WSS certificate is not trusted, or the stack is down. Check `make status`, and open `https://host:8443/healthz`. |
| “Wrong extension or password” | Check `users.json`. Run `make reload-users` after editing it. |
| Call connects but there is **no audio or video** | `EXTERNAL_IP` is wrong or UDP `RTP_PORT_START-RTP_PORT_END` is blocked (firewall). The in-call stats show the ICE path. Run `make cli`, then `pjsip set logger on` and `rtp set debug on`. |
| “The media connection failed (ICE)” | Same as above. For remote clients, configure `CLIENT_ICE_SERVERS` with TURN. |
| Camera or microphone blocked | Allow them in the browser's site settings. This needs HTTPS, or `localhost`. |
| Phone or tablet will not open the camera | Trust `certs/ca.crt` on the device (see above). |

Inspect the generated configuration with
`docker compose exec asterisk ls /var/lib/asterisk/generated`. The live SIP trace is available from
`make cli`, then `pjsip set logger on`.

## Project layout

```
asterisk/
  Dockerfile                 multi-stage source build of Asterisk 22.11.0 (+ codec_opus)
  docker-entrypoint.sh       TLS cert install, config generation, drop to the asterisk user
  bin/asterisk-gen-config    users.json + env → PJSIP endpoints, hints, NAT, ICE mapping
  bin/asterisk-reload-users  regenerate + reload live
  config/                    pjsip.conf, extensions.conf, rtp.conf, http.conf, confbridge.conf, …
web/
  src/client/                browser phone (TypeScript, JsSIP)
  src/server/server.ts       HTTPS + WSS proxy + config API
  tests/                     Playwright end-to-end tests (+ container)
scripts/setup.sh             first-run setup (.env, users.json, certs)
scripts/gen-certs.sh         local CA + server certificate
docker-compose.yml, Makefile, users.example.json, .env.example
```
