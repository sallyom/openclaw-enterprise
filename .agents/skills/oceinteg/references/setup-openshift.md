# Set up the OpenShift OCE and OpenShell test

Use this reference for an explicitly selected OpenShift test cluster with OCC
and a dedicated Codex Agent running through OpenShell. Start with the
[OpenShift guide overview](../../../../docs/guides/deploy/openshift/README.md),
including its **Agent task brief**. The guides own the commands and configuration.
This procedure is test-only; it does not establish production OpenShell support.
Complete setup through a configured, credential-bound Agent and a real model
response, not just a healthy OCC installation. The operator supplies the API key
and runs deployment commands at the handoffs below.

## Resolve the target

Confirm the authorized cluster, active `oc` context, administrator access,
cluster expiration, and retention choice before changing resources. Inspect
the server version, worker architecture and kernel, storage classes, Operator
catalogs, and NetworkPolicy enforcement using the preparation guide. Resolve
differences from its example cluster before applying dependent steps.

Use a private state directory outside the checkout for kubeconfig, credentials,
generated values, and cluster hostnames. Record the source revision and deployed
image digests without committing cluster-identifiable data. Build images through
the documented in-cluster procedure; do not build or push to GHCR. Do not switch
nodes to RHCOS 10 or enable `TechPreviewNoUpgrade` as part of this setup.

## Follow the guides in order

Explain each command block and its expected result before running it.

1. [Prepare the cluster](../../../../docs/guides/deploy/openshift/openshift-test.md).
   Verify prerequisites, prepare admission and the control-plane Route, and
   install the OpenShell gateway. Check workload and storage readiness.
2. [Install OCC](../../../../docs/guides/deploy/openshift/openshift-test-install.md).
   Build the images in the cluster, install PostgreSQL and OCC, and verify
   Console access using protected administrator credentials.
3. [Enable private Agent routing](../../../../docs/guides/deploy/openshift/openshift-test-routing.md).
   Complete routing before creating the Agent. Use discovered cluster values
   for routes, ServiceAccounts, and NetworkPolicy peers.
4. [Prepare the dedicated Codex Agent](../../../../docs/guides/deploy/openshift/openshift-test-agent.md).
   Stop at **Register the model credential**. Let the operator run that entire
   block locally; continue only after they report the credential source ID and
   ready status. Do not read, request in chat, or print the API key, temporary
   request file, or resulting Kubernetes Secret. After that handoff, complete
   the guide's Agent Configuration and dedicated Agent draft, exact credential
   source grant, image-pull permissions, bootstrap Job and Gateway SCC admission,
   and OpenShell/OCC ServiceAccount and runtime identity wiring. Verify the
   credential source and workloads remain ready before requesting deployment.
5. Stop before every `bin/occ agent deploy`. Show the exact command and wait for
   the operator to report its revision ID before checking that revision. Run the
   Agent guide's deployment-status, endpoint readiness, and pairing checks.
6. [Open the Agent Control UI](../../../../docs/guides/deploy/openshift/openshift-test-control-ui.md).
   Follow the same manual deployment handoff for its configuration update.
   Send a real request and wait for an assistant response.

## Record the result and hand off

Verify the reported revision is active and succeeded, Codex app-server WebSocket
initialization is healthy, and a real model turn returns an assistant response.
WebSocket initialization alone does not prove the relay or model execution.
Record the exact revision, image digests, cluster versions, and observed results
in private run evidence. If blocked, identify the first failing hop using
workload status, redacted logs, service routing, bearer handling, and
NetworkPolicies. Keep only successful reproducible steps in the operator guides.

This dedicated Codex/OpenShell result does not complete
[main acceptance](./main.md). Main still requires Console-only Agent provisioning,
both runtime presets, and its remaining permission, integration, lifecycle, and
isolation checks. CLI provisioning from these test guides does not satisfy the
Console-only criterion. Report unexercised criteria explicitly.

Honor the selected retention decision. Preserve running Agents and dependencies
unless disposal was requested; remove only run-owned resources selected for
cleanup. For a main run, follow its
[completion requirements](./runtime-acceptance.md#completion).
