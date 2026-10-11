# Log Streams aren't only Kubernetes containers

A Log Stream was defined as one container's log in one pod, and `LogSource` was built around that: `LogStreamInfo` carries a pod, a container and a restart count. To add Docker Logs, CloudWatch Logs and the systemd journal as Log Source Types, a Log Stream is now the log output of any one thing that logs, under whatever groups its Source Type has. Previous Log, restarts, Pod Status and Ready Count become things a Log Source Type may offer, not things every one must have. We chose this over a separate concept per backend so that the log viewer, Follow and the contract suite stay shared, as the File Source engines are.

## Consequences

`LogSource` and `LogStreamInfo` have to change: their Kubernetes-specific fields become optional capabilities, and the contract suite checks only what a Source Type says it offers. Kubernetes Logs keeps its own vocabulary in the glossary.
