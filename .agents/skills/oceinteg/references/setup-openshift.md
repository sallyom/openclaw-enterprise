# Set up the OpenShift dedicated Codex test

Use the [OpenShift operator recipe](../../../../docs/guides/deploy/openshift/README.md)
for an explicitly selected cluster and dedicated Codex through OpenShell.
The recipe owns commands, prerequisites, protected inputs, and readiness checks.
This procedure does not qualify production OpenShell support.

1. Confirm the intended cluster, administrator access, retention choice, server
   version, storage, architecture, Operators, and NetworkPolicy enforcement.
2. Explain each command block and its expected result before running it. Follow
   the preparation, main-source image build, OCC installation, routing, and Agent
   pages in order. Use the standard runtime pin; do not apply native-harness fixes.
3. Keep generated inputs outside the checkout. Do not print credentials or read
   the operator's API-key request into chat. Let the operator register the model
   credential locally and report only the ready credential-source ID.
4. Show each `bin/occ agent deploy` command and wait for the operator's handoff.
   Verify the admitted revision succeeds, the provider endpoint is authenticated,
   and Codex completes a real model turn.
5. Follow the Control UI procedure, including the exact Service grant when
   testing an existing non-admin OpenShift identity. Impersonation is not proof
   of browser OAuth login. Do not modify cluster OAuth to invent test identities.
6. Create the initial Agent documents through OCC Workspace files after successful
   deployment. Verify file access and operational logs, record results privately,
   and preserve running resources unless disposal was requested.

If the Codex listener fails, retain redacted evidence and diagnose the runtime,
kernel, and routing. Do not add a Unix-socket relay or count another harness as
Codex proof. Main acceptance remains owned by [main](./main.md); CLI deployment
here does not satisfy its Console-only provisioning requirements.
