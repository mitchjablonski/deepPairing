# Maintainer agent execution policy

For Mitch's workstation agents, route resource-intensive installs, generation,
full builds, full test suites, E2E runs, and benchmarks through the configured
remote execution environment. Local WSL is local execution. Local work may
include editing, lightweight Git operations, static inspection, and browser
review.

Use the private operations handoff for connection details, only through the
necessary private operational transport. Never read or echo private key
contents, or publish or commit private connection details or credential
material. Before submitting a remote job, verify the actual host, runtime,
commit, and tool versions, including the repository's package manager pin.
Use an isolated checkout and isolated HOME, TEMP, caches, and logs. Bound job
time, clean up only processes owned by the job after they drain, and capture
its true exit status.

Follow the current shared-server admission rules from the trusted handoff.
Ordinary jobs must own ACTIVE status with their start time and maximum runtime,
have no exclusive job active, and defer if a reboot is announced. Jobs needing
more than 4 cores or 16 GB of memory require the heavy LOCK. Exclusive work
must use the handoff's timing and drain procedure. Never remove another
operator's markers. Do not assume a general runner configuration from
project-specific examples.

Use existing required CI gates and completed evidence for the exact commit
when applicable; avoid redundant heavy reruns solely to change where they ran.
Do not describe prior local WSL work as server evidence. If remote execution is
unavailable or unqualified, stop the heavy operation and report that state;
never silently fall back to local execution or change global security settings.

These rules govern Mitch's workstation agents. External contributors may use
the local development instructions in CONTRIBUTING.md.
