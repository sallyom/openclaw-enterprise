# OpenShell test-cluster credential bridge

Use this temporary option only for a short-lived, isolated cluster running
OpenShell v0.1.3-pre.1. It lets the bundled OpenShell SandboxDriver provision a
dedicated Codex Agent while upstream cannot receive the Agent's Kubernetes
Secret and projected-token shapes. It does not support native OpenClaw or
multiple Agent ServiceAccounts behind one OpenShell gateway.

## Configure the first Agent

Create the Agent draft before deploying a revision. Compute names its
ServiceAccount `agent-<first 12 SHA-256 hex characters of the Agent ID>`.
Set that exact name as `sandboxServiceAccount.name` in the pinned OpenShell
gateway chart. Set the same name in the trusted OCC Installation:

```yaml
drivers:
  sandbox:
    configuration:
      kubernetes:
        sandboxDataMount:
          subPath: workspace/openshell-home
          mountPath: /sandbox/enterprise
          readOnly: false
        serviceAuthorizationMode: bearerPassthrough
        compatibilityBridge:
          sandboxServiceAccountName: agent-<agent-hash>
          runAsUser: 10001
```

Keep the other required Driver fields from the [OpenShell SandboxDriver](openshell-sandbox.md#configuration).
The Driver checks that `sandboxServiceAccountName` equals the exact Agent
ServiceAccount in Compute's Harness requirements. The OpenShell gateway fixes
this ServiceAccount for every Sandbox it creates, so deploy only that Agent with
this gateway configuration. The test-cluster bridge remains off by default;
without it, Secret-backed Harness environment entries fail closed.

Grant the OCC worker namespaced `get`, `create`, `patch`, and `delete` on Jobs in
the Agent's data namespace. Admit the Agent's ServiceAccount to run the
bootstrap Job with its exact UID/GID, projected token, ConfigMap, Secret, and
PVC mounts. On OpenShift, bind the needed SCC only to that ServiceAccount and
review the Job Pod's `openshift.io/scc` annotation.

## Credential lifetime and cleanup

The Driver starts a Job with the Agent's ServiceAccount. It reads only the
Agent-owned app-server and node-setup Secrets, the immutable plugin-runtime
ConfigMap, and a token projected for the Agent's approved audience. It copies
them to revision-scoped subpaths of the Agent workspace PVC. OpenShell mounts
the copies read-only. The model key stays in the OpenShell Credential Gateway;
the Job does not receive it.

The copied ServiceAccount token does not refresh. Its actual expiry is the
issued token's `exp` claim, which the cluster can set beyond the requested
`expirationSeconds`. [ROSA issues projected tokens for one year](https://docs.redhat.com/en/documentation/red_hat_openshift_service_on_aws/4/html/authentication_and_authorization/bound-service-account-tokens).
Check the claim without printing the token and retire the revision before
expiry. The token is bound to the bootstrap Job Pod, so keep that Pod until
revision cleanup. Revision cleanup deletes the Sandbox,
runs a cleanup Job to remove copied credentials, and deletes both Jobs. A
bootstrap or Sandbox creation failure also starts cleanup. If cleanup fails,
inspect the namespaced `openshell-cred-*` Jobs and their Pod events before
deleting the Agent PVC; copied credentials may remain there.

The Driver selects OpenShell's `BEARER_PASSTHROUGH` mode for the protected Codex
app-server route. The Agent's Gateway remains responsible for authenticating
its users. Verify a successful authenticated WebSocket upgrade and a real Codex
model turn before treating the test Agent as usable.
