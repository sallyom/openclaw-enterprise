# Prepare the first OpenShell Agent on OpenShift

Use this after the OCC installation and
private Agent routing. It prepares one dedicated
Codex Agent using the OpenShell runtime provider.
Run the commands from the repository root with the reviewed test-cluster
`KUBECONFIG`. Keep the input directory outside the checkout. ServicePrincipal
credentials remain disabled because OpenShell cannot project the Agent identity.

## Select the tenant

Use the protected files and Route hostname established during installation.
The OCC Namespace ID and Kubernetes tenant namespace are different values:

**Select the OCC tenant.**

```bash
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-$HOME/.local/state/openclaw-enterprise/openshift-test}"

export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"

export OCC_URL="https://$OCC_CONSOLE_HOST"

export OCC_SERVICE_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"

export OCC_NAMESPACE="$(bin/occ namespace list -o json |
  jq -r '.[] | select(.name == "default") | .id')"

export TENANT_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/namespace=$OCC_NAMESPACE" -o json |
  jq -er '.items | if length == 1 then .[0].metadata.name else error("expected one tenant namespace") end')"

export GATEWAY_NAMESPACE="$TENANT_NAMESPACE"

bin/occ namespace get "$OCC_NAMESPACE"
```

Expect the Namespace to be `ready`. Confirm the active `oc` context before
using the cluster-admin commands below.

Attach the owned tenant namespace to the private Gateway. Its Envoy
NetworkPolicy admits OpenShell supervisor Pods only from attached namespaces;
the workspace node cannot pair without this label:

**Attach the tenant for supervisor egress.**

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
selected `gpt-6-luna` model.
OCC stores the value in its managed Kubernetes Secret in the tenant namespace;
the Credential Gateway also stores a copy in OpenShell. The key stays out of
shell history, command arguments, and repository files. The temporary request
file contains the key until it is removed:

**Register the model credential.**

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

Use the dedicated Codex Configuration. It selects `codex/gpt-6-luna` with a
fail-closed provider base URL; the authenticated Codex process calls OpenAI through
OpenShell. Do not put an API key in the Configuration.

```bash
export CONFIGURATION_FILE=deploy/examples/openshift-test/codex-luna-configuration.json
```

**Create the Configuration and Agent.**

```bash
export CONFIGURATION_ID="$(bin/occ configuration create \
  --file "$CONFIGURATION_FILE" \
  -o json | jq -r .id)"

jq -n --arg configuration "$CONFIGURATION_ID" --arg source "$SOURCE_ID" \
  '{name: "openshell-luna", configurationId: $configuration,
    executionMode: "dedicated",
    harnessAuth: {method: "credential_source", sourceId: $source},
    credentialSources: [{sourceId: $source}]}' \
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

**Grant access to the exact credential source.**

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

**Grant runtime-image pull access.**

```bash
oc -n openclaw-system create rolebinding "oce-runtime-pull-${AGENT_SA#agent-}" \
  --clusterrole=system:image-puller \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --serviceaccount="$TENANT_NAMESPACE:openshell-sandbox" \
  --dry-run=client -o yaml | oc apply -f -
```

The Compute Driver's `allow-dns` policy grants the Agent Gateway Pod DNS
egress to the configured OpenShift DNS Pods on UDP/TCP ports `53` and `5353`.

## Admit the Agent Gateway

The Agent Gateway runs as UID/GID 1000 in the tenant
namespace. Grant its exact ServiceAccount use of the existing
`oce-fixed-uid-1000` SCC
before requesting a revision. Without this grant, OpenShift rejects the
Gateway Pod and its `WaitForFirstConsumer` PVC remains pending:

**Grant Gateway SCC access.**

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

The provider Harness uses the workspace chart's `openshell-sandbox`
ServiceAccount under `restricted-v2`. Keep that chart-managed identity; do not
replace it with the Agent ServiceAccount. OCC supplies revision-owned Codex
configuration and workspace-node setup through the runtime provider. It sends
only the app-server token hash to the Sandbox. Compute owns enrollment egress
and the private Gateway route; no credential-copy Job or manual node policy is
needed.

## Deploy and verify the Agent

Run the deployment from the reviewed checkout after the Agent prerequisites
above are ready. Record the returned revision ID:

**Deploy and verify the Agent.**

```bash
bin/occ agent deploy "$AGENT_ID"

# REQUIRED: replace the placeholder with the value described above.
export DEPLOYMENT_ID='<revision ID returned by deploy>'

bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"

oc -n "$TENANT_NAMESPACE" get secrets -o json |
  jq -e --arg prefix "workspace-node-${AGENT_SA#agent-}-" \
    '[.items[] | select(.metadata.name | startswith($prefix)) |
      select(.data.deviceId != null)] | length == 1'
```

Wait for `succeeded`; the `jq` check should return `true`. It inspects only
Secret key presence, without printing the setup code.
These results verify deployment and pairing, not a model turn. Continue to the
[required Control UI Route step](openshift-test-control-ui.md) for this Codex Agent.
Create the OAuth-protected Route, enable the exact origin, and test a model turn
to complete the OpenShift recipe. To create another Agent in its own Namespace,
use the [additional Agent recipe](openshift-test-agents.md).

## Add initial Agent files

After deployment succeeds, open this Agent's **Workspace files** tab in OCC.
Bootstrap may already provide `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.
Create only missing files; edit existing instructions deliberately. Verify the
Agent can read them from `/sandbox/enterprise` during a model turn.
