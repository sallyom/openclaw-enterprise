# Prepare the first OpenShell Agent on OpenShift

Use this after the [OCC installation](openshift-test-install.md) and
[private Agent routing](openshift-test-routing.md). It prepares one dedicated
Codex Agent for the temporary [OpenShell credential bridge](../../../reference/drivers/openshell-sandbox-test-bridge.md).
Run the commands from the repository root with the reviewed test-cluster
`KUBECONFIG`. Keep the input directory outside the checkout. This bridge and
gateway configuration serve one Agent ServiceAccount at a time.

## Select the tenant

Use the protected files and Route hostname established during installation.
The OCC Namespace ID and Kubernetes tenant namespace are different values:

```bash
export OCC_INPUT_DIRECTORY=/secure/occ
export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"
export OCC_URL="https://$OCC_CONSOLE_HOST"
export OCC_SERVICE_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
export OCC_NAMESPACE="$(bin/occ namespace list -o json |
  jq -r '.[] | select(.name == "default") | .id')"
export TENANT_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/namespace=$OCC_NAMESPACE" -o json |
  jq -er '.items | if length == 1 then .[0].metadata.name else error("expected one tenant namespace") end')"
export GATEWAY_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/gateway-namespace=$OCC_NAMESPACE" -o json |
  jq -er '.items | if length == 1 then .[0].metadata.name else error("expected one Gateway namespace") end')"
bin/occ namespace get "$OCC_NAMESPACE"
```

Expect the Namespace to be `ready`. Confirm the active `oc` context before
using the cluster-admin commands below.

Attach the owned tenant namespace to the private Gateway. Its Envoy
NetworkPolicy admits OpenShell supervisor Pods only from attached namespaces;
the workspace node cannot pair without this label:

```bash
oc get namespace "$TENANT_NAMESPACE" -o json |
  jq -e --arg id "$OCC_NAMESPACE" '
    .metadata.labels["openclaw.dev/namespace"] == $id and
    .metadata.annotations["openclaw.dev/namespace-id"] == $id'
export ROUTING_LABEL="$(oc -n openclaw-system get gateway oce-agent-gateways -o json |
  jq -er '.spec.listeners[] | select(.name == "https") |
    .allowedRoutes.namespaces.selector.matchLabels["openclaw-enterprise.io/gateway"]')"
oc label namespace "$TENANT_NAMESPACE" \
  "openclaw-enterprise.io/gateway=$ROUTING_LABEL" --overwrite
```

## Register the model credential

Use an OpenAI API key authorized for the
[selected `gpt-6-luna` model](https://developers.openai.com/api/docs/models).
OCC stores the value in its managed Kubernetes Secret in the tenant namespace;
the Credential Gateway also stores a copy in OpenShell. The key stays out of
shell history, command arguments, and repository files. The temporary request
file contains the key until it is removed:

```bash
umask 077
set -o pipefail
read -r -s -p 'OpenAI API key: ' OPENAI_API_KEY
printf '\n'
printf '%s' "$OPENAI_API_KEY" |
  jq -Rs '{name: "openai-model-key", value: .}' \
  > "$OCC_INPUT_DIRECTORY/model-secret.json"
unset OPENAI_API_KEY
export SECRET_REF="$(bin/occ secret create \
  --file "$OCC_INPUT_DIRECTORY/model-secret.json" -o json | jq -c .ref)"
rm -f "$OCC_INPUT_DIRECTORY/model-secret.json"
test -n "$SECRET_REF" && test "$SECRET_REF" != null

jq -n --argjson ref "$SECRET_REF" \
  '{name: "openai", type: "openai", secrets: {api_key: $ref}}' \
  > "$OCC_INPUT_DIRECTORY/credential-source.json"
export SOURCE_ID="$(bin/occ credential-source create \
  --file "$OCC_INPUT_DIRECTORY/credential-source.json" -o json | jq -r .id)"
bin/occ credential-source get "$SOURCE_ID"
```

Expect `STATE` and `GATEWAY STATUS` to be `ready`. If Secret creation fails,
remove `model-secret.json` before retrying. OCC does not automatically update
OpenShell when the underlying Secret changes; follow
[credential-source rotation](../../../reference/credential-sources.md#update-a-source).

## Create the Agent draft and exact credential grant

The [example Configuration](../../../../deploy/examples/openshift-test/codex-luna-configuration.json)
registers only `codex/gpt-6-luna`. It keeps the Codex provider base URL at a
fail-closed loopback address; the authenticated Codex process calls OpenAI
through OpenShell. The key never goes into this Configuration or the Agent Pod.

```bash
export CONFIGURATION_ID="$(bin/occ configuration create \
  --file deploy/examples/openshift-test/codex-luna-configuration.json \
  -o json | jq -r .id)"
jq -n --arg configuration "$CONFIGURATION_ID" --arg source "$SOURCE_ID" \
  '{name: "openshell-codex-luna", configurationId: $configuration,
    executionMode: "dedicated",
    harnessAuth: {method: "credential_source", sourceId: $source}}' \
  > "$OCC_INPUT_DIRECTORY/agent.json"
bin/occ agent create --file "$OCC_INPUT_DIRECTORY/agent.json" -o json \
  > "$OCC_INPUT_DIRECTORY/agent-response.json"
export AGENT_ID="$(jq -r .id "$OCC_INPUT_DIRECTORY/agent-response.json")"
export AGENT_PRINCIPAL="$(jq -r .servicePrincipalId \
  "$OCC_INPUT_DIRECTORY/agent-response.json")"
export AGENT_SA="agent-$(printf '%s' "$AGENT_ID" | openssl dgst -sha256 |
  awk '{print substr($NF, 1, 12)}')"
export GATEWAY_SA="gateway-${AGENT_SA#agent-}"
printf 'Agent ID: %s\nAgent ServiceAccount: %s\nGateway ServiceAccount: %s\n' \
  "$AGENT_ID" "$AGENT_SA" "$GATEWAY_SA"
```

Deployment requires the Agent service principal to `operate` on the exact
credential source. Create a Role containing that action and bind it only to
this Agent and source; do not bind it to the whole Namespace:

```bash
jq -n '{name: "Use an OpenShell credential source",
  permissions: [{action: "operate", resourceKind: "credential_source"}]}' \
  > "$OCC_INPUT_DIRECTORY/credential-source-role.json"
export ROLE_ID="$(bin/occ iam role create \
  --file "$OCC_INPUT_DIRECTORY/credential-source-role.json" -o json | jq -r .id)"
jq -n --arg principal "$AGENT_PRINCIPAL" --arg role "$ROLE_ID" \
  --arg source "$SOURCE_ID" \
  '{subjectKind: "identity", subjectId: $principal, roleId: $role,
    resourceKind: "credential_source", resourceId: $source}' \
  > "$OCC_INPUT_DIRECTORY/credential-source-binding.json"
bin/occ iam access-binding create \
  --file "$OCC_INPUT_DIRECTORY/credential-source-binding.json"
```

The runtime image built during OCC installation lives in the
`openclaw-system` internal registry namespace. Allow only this Agent's two
ServiceAccounts to pull it from that namespace:

```bash
oc -n openclaw-system create rolebinding oce-runtime-agent-image-pull \
  --clusterrole=system:image-puller \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --serviceaccount="$TENANT_NAMESPACE:$AGENT_SA" \
  --dry-run=client -o yaml | oc apply -f -
```

The Compute Driver's `allow-dns` policy grants the Agent Gateway Pod DNS
egress to the configured OpenShift DNS Pods on UDP/TCP ports `53` and `5353`.

## Admit the bootstrap Job

The worker needs tenant-local Job access. The bridge Job uses the tenant
namespace's assigned UID/GID, matching the OpenShell Sandbox Pod under
`restricted-v2`. Read the namespace allocation before configuring OCC:

```bash
export SANDBOX_UID="$(oc get namespace "$TENANT_NAMESPACE" -o json |
  jq -er '.metadata.annotations["openshift.io/sa.scc.uid-range"] |
    split("/")[0] | tonumber')"
oc apply -f deploy/examples/openshift-test/openshell-bootstrap-job-clusterrole.yaml
oc -n "$TENANT_NAMESPACE" create rolebinding oce-openshell-bootstrap-jobs \
  --clusterrole=oce-openshell-bootstrap-jobs \
  --serviceaccount=openclaw-system:openclaw-enterprise-worker \
  --dry-run=client -o yaml | oc apply -f -
oc auth can-i create jobs.batch -n "$TENANT_NAMESPACE" \
  --as=system:serviceaccount:openclaw-system:openclaw-enterprise-worker
```

The Job permission check should return `yes`.

The Agent Gateway runs as UID/GID 1000 in the separate Gateway runtime
namespace. Grant its exact ServiceAccount use of the existing
[`oce-fixed-uid-1000` SCC](../../../../deploy/examples/openshift-test/fixed-uid-scc.yaml)
before requesting a revision. Without this grant, OpenShift rejects the
Gateway Pod and its `WaitForFirstConsumer` PVC remains pending:

```bash
oc -n "$GATEWAY_NAMESPACE" create role oce-fixed-uid-1000-agent-gateway \
  --verb=use --resource=securitycontextconstraints.security.openshift.io \
  --resource-name=oce-fixed-uid-1000 \
  --dry-run=client -o yaml | oc apply -f -
oc -n "$GATEWAY_NAMESPACE" create rolebinding oce-fixed-uid-1000-agent-gateway \
  --role=oce-fixed-uid-1000-agent-gateway \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --dry-run=client -o yaml | oc apply -f -
oc auth can-i use scc/oce-fixed-uid-1000 -n "$GATEWAY_NAMESPACE" \
  --as="system:serviceaccount:$GATEWAY_NAMESPACE:$GATEWAY_SA"
```

Expect `yes` for the Gateway SCC check too.

## Pin OpenShell and OCC to the Agent ServiceAccount

Update the pinned OpenShell chart's protected values copy, then roll out the
gateway. Its `workspaceResources.enabled: false` setting leaves workspace
resources under OCC operator control:

```bash
install -m 600 deploy/examples/openshift-test/openshell-gateway-values.yaml \
  "$OCC_INPUT_DIRECTORY/openshell-gateway-agent-values.yaml"
yq -i '.sandboxServiceAccount.name = strenv(AGENT_SA)' \
  "$OCC_INPUT_DIRECTORY/openshell-gateway-agent-values.yaml"
helm upgrade openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-source/OpenShell-0.1.3-pre.1/deploy/helm/openshell" \
  -n openshell-system \
  -f "$OCC_INPUT_DIRECTORY/openshell-gateway-agent-values.yaml" \
  --wait --timeout 7m
oc -n openshell-system rollout status statefulset/openshell-gateway --timeout=5m
```

Update the protected `installation.yaml` produced by the OCC installation.
The ServiceAccount in `operatorWorkspaceResources` and the bridge must match
`AGENT_SA`. Set the bridge Job and OpenShell process to the tenant namespace's
assigned UID/GID. OpenClaw changes the mode of its state directory during
startup, so the bridge Job must own that directory as the runtime UID. Allow
the Node executable to reach only the private Envoy Gateway Service VIP:

```bash
export PRIVATE_GATEWAY_HOST="$(yq -r '.drivers.compute.configuration.gatewayRouting.hostname' \
  "$OCC_INPUT_DIRECTORY/installation.yaml")"
test -n "$PRIVATE_GATEWAY_HOST" && test "$PRIVATE_GATEWAY_HOST" != null
export PRIVATE_GATEWAY_CIDR="$(oc -n envoy-gateway-system get service \
  "${PRIVATE_GATEWAY_HOST%%.*}" -o jsonpath='{.spec.clusterIP}')/32"
yq -e '[.drivers.sandbox.configuration.gateway.operatorWorkspaceResources[] |
  select(.kind == "ServiceAccount")] | length == 1' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
yq -i '(.drivers.sandbox.configuration.gateway.operatorWorkspaceResources[] |
  select(.kind == "ServiceAccount") | .metadata.name) = strenv(AGENT_SA) |
  .drivers.sandbox.configuration.kubernetes.sandboxDataMount.subPath = "workspace/openshell-home" |
  .drivers.sandbox.configuration.kubernetes.compatibilityBridge.sandboxServiceAccountName = strenv(AGENT_SA) |
  .drivers.sandbox.configuration.kubernetes.compatibilityBridge.runAsUser = env(SANDBOX_UID) |
  .drivers.sandbox.configuration.policy.process.runAsUser = strenv(SANDBOX_UID) |
  .drivers.sandbox.configuration.policy.process.runAsGroup = strenv(SANDBOX_UID) |
  .drivers.sandbox.configuration.policy.networkPolicies |=
    (map(select(.name != "workspace-node")) + [{
      "name": "workspace-node",
      "endpoints": [{"host": strenv(PRIVATE_GATEWAY_HOST), "ports": [443],
        "protocol": "tcp", "tls": "skip", "allowedIps": [strenv(PRIVATE_GATEWAY_CIDR)]}],
      "binaries": [{"path": "/usr/local/bin/node"}]
    }])' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
node --input-type=module -e '
  import { loadInstallationConfiguration } from "./apps/controller/src/composition/installation-config.ts";
  await loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: process.argv[1] } });
  console.log("Installation configuration valid");
' "$OCC_INPUT_DIRECTORY/installation.yaml"
oc -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml" \
  --dry-run=client -o yaml | oc apply -f -
oc -n openclaw-system rollout restart \
  deployment/openclaw-enterprise-api deployment/openclaw-enterprise-worker
oc -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=4m
oc -n openclaw-system rollout status deployment/openclaw-enterprise-worker --timeout=4m
bin/occ credential-source get "$SOURCE_ID"
```

Expect both OCC deployments and the OpenShell gateway to be ready and the
source's gateway status to remain `ready`. Keep `AGENT_ID`, `SOURCE_ID`, and
the protected input directory for deployment and cleanup.

## Deploy and verify the Agent

Run the deployment from the reviewed checkout after the Agent prerequisites
above are ready. Record the returned revision ID:

```bash
bin/occ agent deploy "$AGENT_ID"
export DEPLOYMENT_ID='<revision ID returned by deploy>'
bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"
oc -n "$TENANT_NAMESPACE" get endpointslice \
  -l "kubernetes.io/service-name=$AGENT_SA" -o json |
  jq -e '[.items[].endpoints[]? | select(.conditions.ready == true)] | length > 0'
oc -n "$TENANT_NAMESPACE" get secrets -o json |
  jq -e --arg prefix "workspace-node-${AGENT_SA#agent-}-" \
    '[.items[] | select(.metadata.name | startswith($prefix)) |
      select(.data.deviceId != null)] | length == 1'
```

Wait for `succeeded`; both `jq` checks should return `true`. They inspect only
endpoint readiness and Secret key presence, without printing the setup code.
These results verify deployment and pairing, not a model turn. Follow the
[OAuth Route procedure](openshift-test-control-ui.md) to use the Agent's Control
UI and exercise the model.
