# Run the OpenShift OCE and OpenShell test

Use these guides to reproduce the OpenClaw Enterprise (OCE) and OpenClaw Control
Plane (OCC) test with a dedicated Codex Agent running through OpenShell on an
OpenShift cluster. This is a test procedure, not a supported production
OpenShell deployment. Verify cluster-specific assumptions before applying the
examples; they were written for OpenShift 4.22 and a particular worker,
storage, Operator, and networking setup.

## Follow the guides in order

Run repository commands from the checkout root. Keep the kubeconfig,
passwords, API keys, generated values, and cluster-specific hostnames in a
private directory outside the checkout. Use placeholders in committed files.

1. [Prepare and inspect the OpenShift cluster](openshift-test.md). Verify the
   active `oc` context, server version, node architecture and kernel, storage
   classes, Operator catalogs, and enforcing NetworkPolicy behavior. Do not
   assume the example cluster's workers or `gp3-csi` StorageClass are present.
2. [Install OCC](openshift-test-install.md). Build the controller and runtime
   images in the cluster from the documented source archive; do not build or
   push to GHCR.
3. [Enable private Agent routing](openshift-test-routing.md) after OCC is
   installed and before creating the Agent. Review the discovered routes,
   ServiceAccounts, and network policy peers for this cluster.
4. [Prepare a dedicated Codex Agent](openshift-test-agent.md). Register the
   model credential locally, create the Agent, and stage its runtime identity.
5. [Open the Agent Control UI](openshift-test-control-ui.md) after the Agent is
   ready. The Control UI setup updates the Agent Configuration and requires a
   new revision. Finish by sending a real request and waiting for a Codex
   response.

## Agent task brief

When assigning this procedure to an agent, provide this page and ask it to:

- Explain each command block and its expected result so an operator can follow
  along. Verify the current cluster instead of assuming the guide's example
  values. Do not switch nodes to RHCOS 10 or enable `TechPreviewNoUpgrade`.
- Keep credentials, generated inputs, kubeconfig, and cluster hostnames outside
  the checkout. Build images in the cluster from the source archive. Do not
  read, request in chat, or print the model API key, its temporary request file,
  or the resulting Kubernetes Secret. Stop at **Register the model credential**
  and let the operator run that entire block locally; continue only after they
  report the credential source ID and ready status.
- Stop before each `bin/occ agent deploy` command, including the Control UI
  redeploy. Show the exact command for the operator to run, then continue after
  they report the revision ID.
- Verify that the reported revision is active and succeeded, that Codex
  app-server WebSocket initialization is healthy, and that one real model turn
  returns an assistant response. If a step fails, identify the first failing
  hop from workload status, redacted logs, OpenShell service routing and bearer
  handling, and NetworkPolicies. Treat WebSocket initialization alone as
  insufficient proof that the relay works.

The [dedicated Agent guide](openshift-test-agent.md) and
[Control UI guide](openshift-test-control-ui.md) contain the credential and
deployment steps. Do not record troubleshooting history as part of the
reproducible procedure; document only steps and results that completed
successfully.
