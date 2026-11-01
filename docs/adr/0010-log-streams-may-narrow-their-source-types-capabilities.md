# A Log Stream may narrow its Source Type's capabilities

ADR 0007 made Previous Log, restarts, per-node status and Since capabilities of a Log Source Type, true of all its Log Streams. Kubernetes Events break that: they're Log Streams of a Kubernetes Logs Source, which has Previous Logs and restarts, yet an Event Log Stream has neither. We let a single Log Stream say it lacks its Source Type's Previous Log and restarts, rather than splitting capabilities by kind of Log Stream within a Source Type or making Events a Source Type of their own, so that a Source keeps one set of capabilities and only the odd Log Stream out has to say so.

## Consequences

The log view and Follow look at the Log Stream, not only its Source Type, before offering a Previous Log or waiting for a restart, and the contract suite checks a Log Stream that narrows them doesn't then offer them.
