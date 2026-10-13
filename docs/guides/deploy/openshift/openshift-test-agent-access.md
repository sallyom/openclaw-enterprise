# Let a non-admin owner manage an existing Agent

An administrator creates the Agent, Configuration, model credential, and source,
then prepares its image-pull, SCC, routing, and tenant grants. An owner can edit,
deploy, stop, and inspect that existing Agent through OCC without cluster-admin.
OCC's exact resource permissions still apply. Owners cannot create Agents,
Configurations, Secrets, or credential sources through this Namespace policy.

Use this after the [first Agent recipe](openshift-test-agent.md) or
[additional Agent recipe](openshift-test-agents.md) has prepared the draft and
operator prerequisites. This owner policy applies to dedicated Codex through OpenShell.

For cluster-admin teammates, complete the OCC account and exact resource grants
below, then skip step 3's Kubernetes Service grant. OpenShift cluster-admin does
not grant OCC access. If a teammate already has OCC Installation administrator
access, the owner Role cannot restrict that independent grant. Use their own
OCC account; never share the bootstrap administrator credentials.

## Access boundaries

| Surface    | Added access                                                                                                                                    | Excluded from this grant                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| OpenShift  | `get` on this Agent's exact Gateway Service, through a namespace-local RoleBinding                                                              | Pod creation/deletion, Pod logs/exec/port-forwarding, Secrets, Deployments, PVCs, and RBAC changes |
| OCC        | Read, edit, deploy, stop, and inspect the assigned Agent; edit its Configuration and workspace files; manage its existing credential references | New Agents or Namespaces, Agent deletion, Installation/IAM administration, and other Agents        |
| Control UI | Native Gateway `operator.admin` on this Agent                                                                                                   | Kubernetes privileges and direct model-key values                                                  |

The OCC Role permits reads of model Secret metadata and operations on that exact
Secret/source, including credential rotation. It does not reveal stored Secret
values. Runtime Configuration and tool restrictions still apply: the Codex
example uses `read-only` tools, and controller-managed Gateway configuration
cannot be rewritten through the native UI.

These grants add to existing access. A user may already administer their own
OpenShift projects and request new projects through the cluster's
`self-provisioner` grant. Those rights do not come from the Claw RoleBinding.
Inspect inherited group and Operator grants separately; a custom-resource grant
can let an Operator create workloads even when direct Pod creation is denied.
The Gateway/worker ServiceAccounts receive workload-specific SCC, image-pull,
and reconciliation grants; the human owner does not inherit those identities.

## 1. Provision the owner's OCC account

An Installation administrator follows [Add a person](../../topics/iam.md#add-a-person)
to provision the account and obtain its `principalId`. Return here for the
Agent-specific grants. Keep account passwords and session cookies in the
owner's private directory, separate from shared installation settings.

OCC sign-in is separate from OpenShift sign-in. The Agent Control UI's OpenShift
OAuth proxy can use the cluster's GitHub login, but it does not provision an OCC
account or grant OCC permissions. Use OCC's email/password sign-in unless its
external identity provider has also been configured and the account enrolled.

## 2. Grant exact OCC resource access

Run as an OCC Installation administrator, with `OCC_NAMESPACE`, `OCC_URL`, and
your protected `OCC_SERVICE_KEY_FILE` set. Retain `AGENT_ID`, `CONFIGURATION_ID`,
and `SOURCE_ID` from Agent creation. `MODEL_SECRET_ID` is the OCC Secret ID, not
the Kubernetes Secret name. Set `OCC_INPUT_DIRECTORY` to the Agent's private
directory for these generated requests.

```bash
# REQUIRED: use principalId from the account-provisioning response.
export OWNER_PRINCIPAL_ID='<owner OCC principal ID>'

# REQUIRED: use the registered model Secret's OCC ID.
export MODEL_SECRET_ID='<model Secret ID>'

export OWNER_ROLE_ID="$(bin/occ iam role create \
  --file deploy/examples/openshift-test/agent-deployer-role.json \
  -o json | jq -r .id)"

for target in \
  "namespace:$OCC_NAMESPACE" \
  "agent:$AGENT_ID" \
  "configuration:$CONFIGURATION_ID" \
  "secret:$MODEL_SECRET_ID" \
  "credential_source:$SOURCE_ID"; do
  jq -n --arg principal "$OWNER_PRINCIPAL_ID" --arg role "$OWNER_ROLE_ID" \
    --arg kind "${target%%:*}" --arg id "${target#*:}" \
    '{subjectKind:"identity", subjectId:$principal, roleId:$role,
      resourceKind:$kind, resourceId:$id}' \
    > "$OCC_INPUT_DIRECTORY/owner-binding.json"

  bin/occ iam access-binding create \
    --file "$OCC_INPUT_DIRECTORY/owner-binding.json"
done
```

The `oce-dedicated-agent-deployer` Role grants Agent read, update, deploy, operate,
and log access; Configuration read/update; and credential metadata read/operate.
It omits deletion, account/IAM administration, and resource creation. Secret
reads return metadata, not values. Bind the same Role to each exact Preset if
the Configuration uses one; its Preset permission alone grants no access.

Each new revision needs its own read binding before the owner can inspect
deployment status. Run this as the administrator after each owner deployment:

```bash
# REQUIRED: revision ID returned by the owner's deployment.
export DEPLOYMENT_ID='<new revision ID>'

jq -n --arg principal "$OWNER_PRINCIPAL_ID" --arg role "$OWNER_ROLE_ID" \
  --arg revision "$DEPLOYMENT_ID" \
  '{subjectKind:"identity", subjectId:$principal, roleId:$role,
    resourceKind:"agent_revision", resourceId:$revision}' \
  > "$OCC_INPUT_DIRECTORY/owner-revision-binding.json"

bin/occ iam access-binding create \
  --file "$OCC_INPUT_DIRECTORY/owner-revision-binding.json"
```

## 3. Grant OpenShift Control UI access

Complete [Grant access to a non-admin OpenShift user](openshift-test-control-ui.md#grant-access-to-a-non-admin-openshift-user)
with the owner's OpenShift username. That Kubernetes Role grants only `get` on
the exact Agent Gateway Service. It gives no Secret reads, Pod creation, or OCC
deployment permission. The proxy maps approved users to native `operator.admin`
on this one Agent; OCC IAM does not restrict those native UI operations.

## 4. Verify as the owner

Sign in to OCC with the owner's provisioned account. Edit the Agent's existing
Configuration, deploy it, add the revision read binding as administrator, and
inspect the resulting status. Confirm the owner cannot create a new Agent,
change Installation settings, or read another Agent without an independent grant.

Separately, sign in to the Agent Control UI through OpenShift OAuth and complete
a model turn. Keep an administrator kubeconfig and the owner's kubeconfig in
separate private files; do not rely on the shell's current context for operator
steps. Kubernetes RoleBindings do not replace OCC authorization, and existing
independent grants can give the owner broader access than this example.
