# Connection health (macOS and Windows)

The Overview is evidence-based, not a process monitor. Green means the local MCP
discovery/tools list and tunnel health/readiness were confirmed recently. Browser
green also requires a successful browser operation within five minutes with no
subsequent known transport/extension failure. No browser tool is called by the
periodic monitor. Expired evidence is UNKNOWN, not proof of disconnection.
The monitor cannot prove that any particular ChatGPT chat has loaded a connector;
use a harmless real tool call in that chat. The last successful MCP invocation
does not identify the caller.

## Safety and recovery

- Health evidence expires after 30 seconds. Process replacement invalidates the
  evidence immediately. Browser failures override older successful calls.
- Only owned tunnel processes are automatically restarted, after repeated hard
  health failures and when local backend activity can be verified as idle.
  Live 503 /readyz failures are diagnosed and escalated, not blindly killed.
  401/403 and 429 do not trigger restart storms. A subsequent positive probe
  clears authorization / attention status.
- An explicit browser verification may ask Chrome to reconnect. It does not
  recreate tunnels or retry unknown browser mutations. Normal idle monitoring
  does not open pages or steal browser focus.
- A manual tunnel-only reconnect may interrupt a transport request; it never
  restarts the local Terminal, browser, jobs or AutoSend.
- State transitions are stored locally in connection-health-history.json
  under the application data folder (last 200 events, no request payloads or keys).
- Test offline, wake/resume, 401/403/429/503, Chrome extension disconnect,
  stale dashboard response and PID change on both real OS installations.
