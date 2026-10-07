# Polyscope

A cross-platform desktop viewer for browsing and reading files and logs from many backends in one editor-like interface.

## Language

### Sources

**Source Type**:
A kind of backend Polyscope can read from (e.g. Local Filesystem, S3-compatible Storage, Kubernetes Files, Kubernetes Logs). New Source Types are added over time.
_Avoid_: provider, connector, backend

**Source**:
One configured, user-named instance of a **Source Type**, holding its settings (and references to its secrets).
_Avoid_: connection, mount, profile

**Disconnected / Connected / Error**:
The state of a **Source**. Every **Source** starts **Disconnected** when the app launches; no tabs or views are restored from a previous session, except the editor tabs an **Extension Copy**'s editor restores, which connect their **Source**. Expanding a **Disconnected** **Source** connects it; failing to connect puts it in **Error**. Disconnecting stops all **Follows** but leaves its tabs open.

**Environment**:
An optional, user-defined label (name + colour) attached to a **Source** to show what kind of system it points at (defaults: prod, staging, qa, dev). Shown on the **Source**, its tabs, and the status bar.
_Avoid_: tag, stage, tier

**Protected Environment**:
An **Environment** flagged as needing extra care (e.g. prod).

**File Source**:
A **Source** whose content is a browsable hierarchy of folders and files.

**Log Source**:
A **Source** whose content is a hierarchy of workloads producing **Log Streams**.

### Kubernetes

**Workload**:
A Kubernetes object with a pod template that owns pods (Deployment, StatefulSet, DaemonSet, Job, CronJob). Browsed within the single namespace fixed on the **Source**.

**Log Stream**:
The log output of one container in one pod, viewable as a snapshot or live-followed.

**Previous Log**:
The **Log Stream** of a container's prior (crashed or restarted) instance, available only when the container has restarted. Viewed by switching a container's log view to it, not as a node of its own in the tree; it can't be **Followed**.

**Pod Status**:
The health of a pod as shown in the tree: its phase or failure reason (Running, Pending, CrashLoopBackOff, OOMKilled…) plus its restart count when greater than zero.

**Ready Count**:
How many of a **Workload**'s pods are ready out of how many are desired (e.g. `2/3`). Deployments, StatefulSets and DaemonSets have one; Jobs and CronJobs run to completion, so have none.

### Viewing

**Follow**:
Continuously appending new content to an open view as it is produced (live **Log Streams**, or growing files on Local and Kubernetes Files **Sources**). Not applicable to S3 objects.
_Avoid_: tail, watch, stream (as a verb)

**Large File**:
A file above the size threshold (default 50 MB), opened in the **Large File Viewer** instead of the full editor.

**Large File Viewer**:
A read-only, end-first, paged viewer for **Large Files**, with backend-side search and minimal highlighting.

### Distribution

**Installed Copy**:
Polyscope set up from an installer or package (the Windows installer, `.deb`, `.rpm`, or the AppImage), and so able to update itself where the platform allows. Copies are told apart by how they update, not by how they arrive: the AppImage runs without installing but is an **Installed Copy**.

**Portable Copy**:
Polyscope run straight from a download on Windows (the portable `.exe` or the `.zip`), without installing it. It shares an **Installed Copy**'s **Sources** and settings, and is offered updates as a download.
_Avoid_: standalone (ADR 0001 uses it for "a desktop app rather than a VS Code extension")

**Extension Copy**:
Polyscope running inside VS Code (or a compatible editor) as an extension, and so updated by the editor's marketplace rather than by itself. It keeps its own **Sources** and settings, apart from those of Installed and Portable Copies.
_Avoid_: plugin

## Relationships

- A **Source** is an instance of exactly one **Source Type**
- A **Source** has zero or one **Environment**; an **Environment** is shared by many **Sources**
- Every **Source Type** is either a **File Source** type or a **Log Source** type
- A Kubernetes Files **Source** targets exactly one **Workload** and one path; it shows each of that **Workload**'s pods as a separate folder (per-pod volumes differ) only when there are several, with a container level only when the pod has several containers
- A Kubernetes Logs **Source** covers every **Workload** in its namespace
- In both Kubernetes **Source Types**, a Job, pod or container level with exactly one child folds into its parent: a **Workload** with one pod of one container opens its **Log Stream** directly. The folded level's details (e.g. **Pod Status**) move to the row that stands in for it; in Kubernetes Files a folded pod's details go only in its **Source**'s tooltip
- Kubernetes Files and Kubernetes Logs are separate **Source Types**, even though both point at a cluster
- A **Log Stream** belongs to one container of one pod of one **Workload**

## Flagged ambiguities

- "source" was used for both the kind of backend and a configured instance — resolved: **Source Type** vs **Source**.
