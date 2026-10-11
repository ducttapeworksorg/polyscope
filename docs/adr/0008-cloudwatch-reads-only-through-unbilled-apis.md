# CloudWatch Logs reads only through unbilled APIs

Browsing, reading and Following a CloudWatch Logs Source must add nothing to the user's AWS bill, so Polyscope calls only the Describe, `GetLogEvents` and `FilterLogEvents` APIs, and Follow polls them. It doesn't use Live Tail (`StartLiveTail`), which pushes new events but is billed per session-minute, so a tab left Following overnight would cost money. It doesn't use Logs Insights either, which is billed per GB scanned. Polling uses a low per-account, per-region quota that other tools share, so each Source runs one poll schedule for all its Followed tabs and backs off when throttled instead of failing.

## Consequences

Following is a few seconds behind, where Live Tail would be nearly instant. Live Tail may later be offered as an opt-in toggle if users ask for it. It would stay off by default, and the user would be told it may incur charges before it's turned on.
