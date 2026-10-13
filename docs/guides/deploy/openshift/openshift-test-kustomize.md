# Deploy the OpenShift test manifests with Kustomize

Review the checked-in test overlay
and render the complete resource inventory:

**Render the complete example inventory.**

```bash
oc kustomize deploy/examples/openshift-test/overlays/test
```

Follow the [OpenShift test procedures](README.md) to select the cluster, prepare
private inputs, and install Helm releases. Deploy the stages below individually;
operators and CRDs must become ready before their dependent resources.

## Inspect the bases and overlays

```text
deploy/examples/openshift-test/
├── base/
│   ├── kustomization.yaml
│   └── <stage>/                 Resource YAML and kustomization.yaml
├── overlays/test/
│   ├── kustomization.yaml       Complete example inventory
│   └── <stage>/kustomization.yaml
└── prepare-kustomize            Add private overrides to a copy of the overlay
```

Each stage's checked-in overlay references its base. Render one stage directly:

**Render a single stage.**

```bash
oc kustomize deploy/examples/openshift-test/overlays/test/operators
```

The complete example includes documentation-only network addresses, hostnames,
and `${VARIABLE}` values for the per-Agent OAuth resources. Prepare the private
inputs before applying those stages. Review the storage class and public image
and Operator pins against the target cluster too.

## Prepare and apply a stage

The helper needs `oc`, `yq`, and `python3`. Use the existing private input directory:

**Prepare, review, and apply a stage.**

```bash
: "${OCC_INPUT_DIRECTORY:?Set the existing private input directory}"

deploy/examples/openshift-test/prepare-kustomize operators

oc kustomize "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"

oc apply --dry-run=server \
  -k "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"

oc apply -k "$OCC_INPUT_DIRECTORY/kustomize/overlays/test/operators"
```

The helper copies the selected checked-in base and overlay. For `control-plane`,
`control-ui`, and `control-ui-access`, it converts the prepared private resource
inputs into explicit JSON patches beside the copied Kustomization. Each patch
replaces one complete resource, preserving the reviewed inputs rather than
merging their arrays with example defaults. Inspect those patches and
`rendered.yaml` before the server dry run and application.

The helper does not query or change the cluster, fetch Kubernetes Secrets, or
change the active context. Kustomize's normal file-loading restrictions remain
enabled. Regenerate a private overlay after changing its source or inputs.

## Choose a stage

| Stage               | Resources                                                                                 | Prerequisite                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `operators`         | PostgreSQL and cert-manager Namespaces, OperatorGroups, Subscriptions                     | Verify the pinned catalog entries.                                               |
| `database`          | PostgreSQL cluster                                                                        | Wait for the PostgreSQL Operator and CRD.                                        |
| `admission`         | Control-plane Namespace, fixed-UID SCC, and exact grants                                  | Review the SCC and its exact ServiceAccount grants.                              |
| `openshell`         | OpenShell Namespace, RuntimeClass, workspace role, ingress and controller egress policies | Apply admission first; verify node labels and OpenShell pins.                    |
| `control-plane`     | Bootstrap PVC, PostgreSQL/API egress, Console Route                                       | Run `prepare-inputs`; prepare `console-route.yaml` with this cluster's hostname. |
| `routing`           | Envoy Namespace, exact controller SCC grants, GatewayClass                                | Verify Gateway API compatibility and select the Helm chart version.              |
| `control-ui`        | Protected OAuth-proxy configuration                                                       | Complete the Control UI guide's private hostname and credential inputs.          |
| `control-ui-access` | Exact Gateway Service read role and user binding                                          | Render the Control UI guide's grant for an existing OpenShift username.          |

Replace `operators` in the command block with the selected stage. Wait between
dependent stages using the owning guide's commands. Wait for PostgreSQL and
OpenShell before OCC initialization. The routing stage supplies the controller
SCC grants before Envoy's Helm hooks; its GatewayClass becomes accepted after
Envoy starts. Apply OpenShell gateway ingress restrictions before its Helm release.

Builds, Helm releases, SQL initialization, and endpoint discovery remain in the
owning procedures. Kustomize groups the supporting manifests; it does not replace
those operations or their readiness checks.

## Keep temporary grants separate

The bootstrap volume-preparation SCC and RoleBinding are outside these
persistent stages. Apply them immediately before `prepare-bootstrap-volume`
and remove them after successful preparation, as described in the
[installation guide](openshift-test-install.md#prepare-cluster-specific-inputs-and-policy).
Bootstrap password retrieval remains a separate temporary Pod operation.

Private stage directories use mode `0700`; their files use `0600`. Do not commit
private patches or rendered credentials, or include them in logs or attachments.
The helper does not generate or rotate credentials or provide a cleanup command.
Follow the existing procedures for release teardown and retained data.
