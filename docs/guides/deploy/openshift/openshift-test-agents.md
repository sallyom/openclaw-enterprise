# Create more dedicated OpenShell Agents on OpenShift

Use this recipe after OCC, OpenShell v0.1.3, private Envoy routing, and the
Console Route are installed. Each run creates one OCC Namespace and one Agent.
Use dedicated Codex through OpenShell and the **runtime image already configured
in the Installation**. There are no image builds here.

An OCC Installation administrator who also has the required OpenShift operator
permissions runs this recipe. A teammate's project-admin role in their own
project does not grant access to the OCE-managed Namespace. Use the operator's
own protected OCC service key; do not give teammates the bootstrap administrator
key or an administrator kubeconfig.

Run from the repository root, with `bin/occ` built from the installed OCE source.
Run each block in order and stop on an error. Keep the existing OCC installation
and its Secrets. Each teammate receives their own Agent and Namespace; this is
not the shared-session Team Claw setup.

## 1. Choose a new Agent name

Change the marked values. Use a new DNS-style name for every run; it also names
the OCC Namespace and private input directory. Repeat this section onward with a different name for each Codex Agent.

```bash
umask 077

# REQUIRED: setup directory containing the installed Console's console-route.yaml.
export OCC_SETUP_DIRECTORY='<OCC setup directory>'

# REQUIRED: your authorized OCC service-key file.
export OCC_SERVICE_KEY_FILE='<private OCC service-key file>'

# REQUIRED: new DNS-style name for this Codex Agent.
export AGENT_NAME='codex-luna-alice'

oc whoami

oc whoami --show-server

test -s "$OCC_SERVICE_KEY_FILE"

export OCC_CONSOLE_HOST="$(yq -er '.spec.host' "$OCC_SETUP_DIRECTORY/console-route.yaml")"

export OCC_URL="https://$OCC_CONSOLE_HOST"

export AGENT_INPUT_DIRECTORY="$HOME/.local/state/openclaw-enterprise/agents/$AGENT_NAME"

install -d -m 700 "$AGENT_INPUT_DIRECTORY"

export OCC_INPUT_DIRECTORY="$AGENT_INPUT_DIRECTORY"

test ! -e "$AGENT_INPUT_DIRECTORY/agent-response.json"

export CONFIGURATION_FILE=deploy/examples/openshift-test/codex-luna-configuration.json
```

## 2. Create the Namespace and grant its operator permissions

The OpenShift operator runs this block without pausing between creation and
grants. Namespace provisioning has a 15-minute convergence deadline. The helper
waits for the owned backing namespace and applies all five tenant-local grants,
including the named OpenShell workspace Role's `bind`/`escalate` permissions.

```bash
bin/occ namespace create "$AGENT_NAME" -o json \
  > "$AGENT_INPUT_DIRECTORY/namespace-response.json"

export OCC_NAMESPACE="$(jq -er .id "$AGENT_INPUT_DIRECTORY/namespace-response.json")"

deploy/examples/openshift-test/grant-tenant-access

export TENANT_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/namespace=$OCC_NAMESPACE" -o jsonpath='{.items[0].metadata.name}')"

export GATEWAY_NAMESPACE="$TENANT_NAMESPACE"

bin/occ namespace get "$OCC_NAMESPACE"
```

Wait for OCC Namespace status `ready`. New Namespaces inherit the configured
private routing; do not run the existing-tenant policy replacement procedure.

## 3. Register this Agent's OpenAI credential

Enter an authorized key at the hidden prompt. The request file briefly contains
the key; remove it after Secret creation. If creation fails, remove that file
before retrying. Expect source state and Gateway status `ready`.

```bash
set -o pipefail

read -r -s -p 'OpenAI API key: ' OPENAI_API_KEY

printf '\n'

printf '%s' "$OPENAI_API_KEY" | jq -Rs --arg name "$AGENT_NAME-model-key" \
  '{name:$name, value:.}' > "$AGENT_INPUT_DIRECTORY/model-secret.json"

unset OPENAI_API_KEY

bin/occ secret create --file "$AGENT_INPUT_DIRECTORY/model-secret.json" -o json \
  > "$AGENT_INPUT_DIRECTORY/model-secret-response.json"

export MODEL_SECRET_ID="$(jq -er .id "$AGENT_INPUT_DIRECTORY/model-secret-response.json")"

export SECRET_REF="$(jq -ec .ref "$AGENT_INPUT_DIRECTORY/model-secret-response.json")"

rm -f "$AGENT_INPUT_DIRECTORY/model-secret.json"

test -n "$SECRET_REF" && test "$SECRET_REF" != null

jq -n --argjson ref "$SECRET_REF" --arg name "$AGENT_NAME-openai" \
  '{name:$name, type:"openai", secrets:{api_key:$ref}}' \
  > "$AGENT_INPUT_DIRECTORY/credential-source.json"

export SOURCE_ID="$(bin/occ credential-source create \
  --file "$AGENT_INPUT_DIRECTORY/credential-source.json" -o json | jq -r .id)"

bin/occ credential-source get "$SOURCE_ID"
```

## 4. Create the Configuration and Agent

The Codex example includes its required model metadata. No API key goes in
the Configuration. Add initial Agent files through OCC after deployment, as
described at the end of this recipe.

```bash
export CONFIGURATION_ID="$(bin/occ configuration create \
  --file "$CONFIGURATION_FILE" -o json | jq -r .id)"

jq -n --arg name "$AGENT_NAME" --arg configuration "$CONFIGURATION_ID" \
  --arg source "$SOURCE_ID" '{
    name:$name, configurationId:$configuration, executionMode:"dedicated",
    harnessAuth:{method:"credential_source", sourceId:$source},
    credentialSources:[{sourceId:$source}]
  }' > "$AGENT_INPUT_DIRECTORY/agent.json"

bin/occ agent create --file "$AGENT_INPUT_DIRECTORY/agent.json" -o json \
  > "$AGENT_INPUT_DIRECTORY/agent-response.json"

export AGENT_ID="$(jq -r .id "$AGENT_INPUT_DIRECTORY/agent-response.json")"

export AGENT_PRINCIPAL="$(jq -r .servicePrincipalId "$AGENT_INPUT_DIRECTORY/agent-response.json")"

export AGENT_SA="agent-$(printf '%s' "$AGENT_ID" | openssl dgst -sha256 | awk '{print substr($NF,1,12)}')"

export GATEWAY_SA="gateway-${AGENT_SA#agent-}"
```

## 5. Grant the exact credential source and runtime access

Bind the OCC permission to this Agent principal and this source only.

```bash
jq -n --arg name "$AGENT_NAME credential access" \
  '{name:$name, permissions:[{action:"operate", resourceKind:"credential_source"}]}' \
  > "$AGENT_INPUT_DIRECTORY/credential-source-role.json"

export ROLE_ID="$(bin/occ iam role create \
  --file "$AGENT_INPUT_DIRECTORY/credential-source-role.json" -o json | jq -r .id)"

jq -n --arg principal "$AGENT_PRINCIPAL" --arg role "$ROLE_ID" --arg source "$SOURCE_ID" \
  '{subjectKind:"identity", subjectId:$principal, roleId:$role,
    resourceKind:"credential_source", resourceId:$source}' \
  > "$AGENT_INPUT_DIRECTORY/credential-source-binding.json"

bin/occ iam access-binding create --file "$AGENT_INPUT_DIRECTORY/credential-source-binding.json"
```

The operator grants image pulls and Gateway admission. The image-pull binding
name includes the Agent identity so a second Agent cannot replace the first grant.

```bash
oc -n openclaw-system create rolebinding "oce-runtime-pull-${AGENT_SA#agent-}" \
  --clusterrole=system:image-puller \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --serviceaccount="$TENANT_NAMESPACE:openshell-sandbox" \
  --dry-run=client -o yaml | oc apply -f -

oc -n "$GATEWAY_NAMESPACE" create role oce-fixed-uid-1000-agent-gateway \
  --verb=use --resource=securitycontextconstraints.security.openshift.io \
  --resource-name=oce-fixed-uid-1000 --dry-run=client -o yaml | oc apply -f -

oc -n "$GATEWAY_NAMESPACE" create rolebinding oce-fixed-uid-1000-agent-gateway \
  --role=oce-fixed-uid-1000-agent-gateway \
  --serviceaccount="$GATEWAY_NAMESPACE:$GATEWAY_SA" \
  --dry-run=client -o yaml | oc apply -f -

oc auth can-i use scc/oce-fixed-uid-1000 -n "$GATEWAY_NAMESPACE" \
  --as="system:serviceaccount:$GATEWAY_NAMESPACE:$GATEWAY_SA"
```

Require `yes`. OpenShell's Sandbox continues to use `openshell-sandbox` under
`restricted-v2`; do not replace that identity with the Gateway ServiceAccount.

## 6. Deploy, verify files, and create the Control UI Route

```bash
bin/occ agent deploy "$AGENT_ID" -o json \
  > "$AGENT_INPUT_DIRECTORY/deployment-response.json"

export DEPLOYMENT_ID="$(jq -er .id "$AGENT_INPUT_DIRECTORY/deployment-response.json")"

bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"
```

Wait for `succeeded`, then complete the required
[Control UI Route recipe](openshift-test-control-ui.md). It enables the exact
origin and deploys another revision. Run it with the Agent variables above; keep
its generated files in this Agent's private directory:

```bash
export OCC_INPUT_DIRECTORY="$AGENT_INPUT_DIRECTORY"
```

`KUBECONFIG`, `OCC_URL`, and `OCC_SERVICE_KEY_FILE` keep their existing paths.
The OAuth proxy resources are namespace-local, so each Agent's separate Namespace
gets its own Route, cookie Secret, and exact Service access grant. Sign in with
OpenShift OAuth and require a completed model response through Codex.
Finish that procedure before starting the recipe again for the next Agent.

## 7. Grant the teammate access and hand off

Complete [Agent owner access](openshift-test-agent-access.md) as the administrator
to provision or select the teammate's OCC account, grant the exact Namespace,
Agent, Configuration, model Secret, source, and final revision permissions, and
grant their OpenShift username access to the Control UI Service. Use the final
revision returned by the Control UI procedure, not the earlier deployment.

Share the Console URL, Control UI URL, Namespace ID, and Agent ID. The owner uses
their own OCC account for the Console and their existing OpenShift login for the
Control UI. Keep the operator's service key, kubeconfig, and OAuth cookie Secret
private. Existing permissions in the owner's own projects remain unchanged.

<a id="add-initial-agent-files"></a>

## 8. Verify workspace files and a model turn

After deployment succeeds, open this Agent's **Workspace files** tab in OCC.
Bootstrap may already provide `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`.
Create only missing files; edit existing instructions deliberately. Ask the Agent
to read `/sandbox/enterprise/AGENTS.md` and complete a model response in its
Control UI. The example configures Codex tools as `read-only`; changing that
policy is a separate Configuration change subject to admission and sandbox policy.
