# Prepare an OpenShift test cluster

Prepare an OpenShift cluster for an OpenClaw Enterprise (OCE) control-plane
installation and a later dedicated Codex and OpenShell trial. This is a test
procedure, not a supported production OpenShell deployment. Run commands from
the repository root with the private kubeconfig selected below. Use the
[OpenShift OCC installation guide](openshift-test-install.md) for the tested
in-cluster image build, PostgreSQL, bootstrap, and Helm steps after this cluster
preparation. Then [enable private Agent routing](openshift-test-routing.md)
and [prepare the first Agent](openshift-test-agent.md) before deploying a
dedicated Codex Agent. To open its native UI through OpenShift login, follow
the [Control UI Route procedure](openshift-test-control-ui.md).

## Inspect the target before applying manifests

Set `CONTEXT` to the reviewed test-cluster context. Copy its current credentials
to a private directory outside the checkout, then select that copy for this shell.
All following `oc` and Helm commands use `KUBECONFIG`. Check the active context
again whenever you open a new shell. Record the output with the deployment inputs:

```bash
umask 077
export OCC_INPUT_DIRECTORY=/secure/occ
export CONTEXT='<reviewed oc context>'
: "${CONTEXT:?Select the reviewed OpenShift context}"
install -d -m 700 "$OCC_INPUT_DIRECTORY"
test "$(oc config current-context)" = "$CONTEXT"
oc config view --raw --minify --flatten > "$OCC_INPUT_DIRECTORY/kubeconfig.new"
mv "$OCC_INPUT_DIRECTORY/kubeconfig.new" "$OCC_INPUT_DIRECTORY/kubeconfig"
export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"
test "$(oc config current-context)" = "$CONTEXT"
oc version
oc get --raw /version
oc get nodes -L oce-role
oc get storageclasses
oc -n openshift-dns get pods --show-labels
oc -n openshift-ingress get pods --show-labels
oc get gatewayclasses
```

Assign distinct ready `amd64` workers to the control plane and Agent pool.
Replace the two placeholders with node names from `oc get nodes`; these labels
are used by the bootstrap preparation Pod, OCC, and dedicated Agent workloads:

```bash
export CONTROL_NODE='<ready amd64 control node>'
export AGENT_NODE='<different ready amd64 Agent node>'
test "$CONTROL_NODE" != "$AGENT_NODE"
oc label node "$CONTROL_NODE" oce-role=control --overwrite
oc label node "$AGENT_NODE" oce-role=agent --overwrite
oc get nodes -L oce-role
```

The [Kubernetes Compute requirement](../../../reference/drivers/kubernetes-compute.md#requirements)
is Kubernetes 1.35 or later. A lower server version produces a startup warning
and is outside the supported boundary. Check the reported Kubernetes version,
not the local `oc` version. Verify that the selected CNI enforces
NetworkPolicies, the storage classes satisfy the
[Gateway and Harness claims](../../../reference/drivers/kubernetes-compute/storage-and-credentials.md#gateway-storage),
and the cluster can run the selected digest-pinned images. Record the actual
DNS Pod labels, API and PostgreSQL endpoints, router Pod labels, and proxy
source addresses for the shared Helm and Installation inputs. The existing
production examples use `kube-system` DNS labels and are not OpenShift defaults.
Inspect the current DNS endpoints and their port rather than assuming port 53.

Private dedicated Gateway routing requires an Envoy GatewayClass and
cert-manager. The initial [OCC installation](openshift-test-install.md) disables
Gateway routing while verifying the control plane. Then follow the
[private routing procedure](openshift-test-routing.md) for this cluster's
Gateway API version and OpenShift admission. Do not substitute the OpenShift
built-in GatewayClass: the OCE chart creates Envoy `SecurityPolicy` resources.
OpenShift 4.19 and later manages Gateway API CRDs through its Ingress Operator;
follow the [OpenShift compatibility guidance](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/configuring-gateway-api#configuring-gateway-api)
before installing another controller.

For this OpenShift 4.22 test cluster, use the Red Hat cert-manager Operator
from the `redhat-operators` catalog. Confirm that no cert-manager Subscription
or certificate CRD already exists, and that the catalog offers the pinned
`stable-v1.20` channel and `cert-manager-operator.v1.20.1` CSV. The
[operator manifest](../../../../deploy/examples/openshift-test/cert-manager-operator.yaml)
creates its namespace, cluster-wide OperatorGroup, and Subscription. Install
it once, then wait for the operator and certificate API before rendering OCE:

```bash
oc get subscriptions -A | rg 'cert-manager' || true
oc get crd certificates.cert-manager.io 2>&1 || true
oc -n openshift-marketplace get packagemanifest \
  openshift-cert-manager-operator \
  -o jsonpath='{.status.catalogSource}{" "}{range .status.channels[*]}{.name}{" "}{.currentCSV}{"\n"}{end}'
oc apply -f \
  deploy/examples/openshift-test/cert-manager-operator.yaml
oc -n cert-manager-operator get csv,subscriptions
oc -n cert-manager-operator wait \
  --for=jsonpath='{.status.installedCSV}'=cert-manager-operator.v1.20.1 \
  subscription/openshift-cert-manager-operator --timeout=5m
oc -n cert-manager-operator wait --for=jsonpath='{.status.phase}'=Succeeded \
  csv/cert-manager-operator.v1.20.1 --timeout=5m
oc wait --for=condition=Established \
  crd/certificates.cert-manager.io --timeout=5m
```

The Operator installation follows the
[Red Hat OpenShift 4.22 CLI procedure](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/security_and_compliance/cert-manager-operator-for-red-hat-openshift#install-cert-manager-operator-for-red-hat-openshift-by-using-the-cli_cert-manager-operator-for-red-hat-openshift).

## Prepare fixed-UID admission

OCE's Helm Pods and ordinary Kubernetes Compute workloads explicitly run as UID
and GID 1000. OpenShift's default restricted SCC admits only a namespace-allocated UID
range, which may not contain 1000. The candidate
[SCC](../../../../deploy/examples/openshift-test/fixed-uid-scc.yaml) allows UID and
filesystem group 1000, drops all capabilities, and permits the volume
types used by OCE. Its
[control-plane RoleBinding](../../../../deploy/examples/openshift-test/control-plane-scc-rbac.yaml)
grants use to the three Helm ServiceAccounts in `openclaw-system`. Review both
with the cluster administrator and apply them before the Helm pre-install Job:

```bash
oc apply -f deploy/examples/openshift-test/fixed-uid-scc.yaml
oc apply -f deploy/examples/openshift-test/control-plane-scc-rbac.yaml
```

Grant the same SCC only to the exact Gateway and Harness ServiceAccounts after
Compute creates each runtime namespace. Use a namespaced Role and RoleBinding
for each discovered ServiceAccount; do not grant all ServiceAccounts in a tenant
namespace. Check admission through Pod events and the
`openshift.io/scc` Pod annotation. OpenShell's init and supervisor Pods require
separate admission review. This SCC does **not** admit their privileged shape.
Red Hat's [SCC guidance](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/authentication_and_authorization/managing-pod-security-policies#role-based-access-to-security-context-constraints_managing-pod-security-policies)
describes namespaced RBAC grants and why a fixed UID needs an explicit SCC.

## Prepare the control-plane Route

Copy the [Route candidate](../../../../deploy/examples/openshift-test/console-route.yaml)
to the protected input directory, replace `spec.host` with the approved console
hostname, and review its TLS policy. Apply it after Helm creates the API Service.
The Route terminates HTTPS and forwards to
the chart's `openclaw-enterprise-api` Service. Set Helm `auth.baseUrl` to that
exact HTTPS origin. Add the observed `openshift-ingress` router Pod selector to
Helm `api.clients`, then configure `api.trustedProxy` with the actual connecting
router CIDRs and forwarded client-address header. The chart's API ingress
NetworkPolicy otherwise denies the Route. Verify both an allowed console request
and a denied request from an unrelated Pod; a healthy Route alone does not prove
the policy boundary.

```bash
: "${OCC_INPUT_DIRECTORY:?Set the protected deployment input directory}"
test -e "$OCC_INPUT_DIRECTORY/console-route.yaml" || \
  install -m 600 deploy/examples/openshift-test/console-route.yaml \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"
# Edit spec.host and the certificate policy in the protected copy before applying.
oc apply -f "$OCC_INPUT_DIRECTORY/console-route.yaml"
oc -n openclaw-system get route openclaw-enterprise-console
```

## Stage OpenShell separately

The [OpenShell values candidate](../../../../deploy/examples/openshift-test/openshell-gateway-values.yaml)
uses the pinned v0.1.3-pre.1 gateway images and the
[upstream OpenShift admission settings](https://github.com/NVIDIA/OpenShell/blob/v0.1.3-pre.1/docs/kubernetes/openshift.mdx).
Render it
against the exact v0.1.3-pre.1 chart source pinned by
[`internal/occdev/openshell.go`](../../../../internal/occdev/openshell.go), then
review its ServiceAccounts, network policies, SCC admission, and image
references against this cluster. The values allow unauthenticated OCE calls to
the gateway over the isolated cluster network for this trial and disable OpenShell resource
admission as the k3d compatibility proof does. Admit only the OCE controller as
a gateway client. Do not expose this gateway publicly. OpenShell's separately
installed Agent Sandbox controller and workspace resources also need a
cluster-specific render. The chart's OpenShift UID and filesystem-group
overrides let `restricted-v2` assign the gateway identity; do not grant it a
custom or privileged SCC. Inspect the rendered gateway claim and use a
block-backed RWO class with reliable SQLite locking. If the chart cannot
select that class, pre-provision only its exact claim after reviewing the
rendered name and size.

The [gateway ingress policy](../../../../deploy/examples/openshift-test/openshell-gateway-network-policy.yaml)
admits OCE API and worker Pods, Agent Gateway Pods, and supervisor Pods in labeled
workspace namespaces on port 8080. Compare its selectors with the rendered
Gateway and supervisor Pod labels before applying it. Apply the policy before
starting the gateway so unauthenticated requests have no wider ingress window.
After OCE creates `openclaw-system`, apply the matching
[controller egress policy](../../../../deploy/examples/openshift-test/control-plane-openshell-egress.yaml);
the OCE chart defaults to denied egress.

```bash
oc apply -f \
  deploy/examples/openshift-test/control-plane-openshell-egress.yaml
```

Install the pinned Agent Sandbox v0.5.2 controller manifest first. Its SHA-256
comes from the existing k3d proof in
[`internal/occdev/openshell.go`](../../../../internal/occdev/openshell.go):

```bash
: "${OCC_INPUT_DIRECTORY:?Set the protected deployment input directory}"
curl -fL \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.2/sandbox.yaml \
  -o "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml"
printf '%s  %s\n' \
  230ee446d6035f631577e1c6b857f6973a8f09a0a853675d3cc34ebfe47abd6b \
  "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml" | shasum -a 256 -c
oc apply -f "$OCC_INPUT_DIRECTORY/agent-sandbox-v0.5.2.yaml"
oc -n agent-sandbox-system rollout status \
  deployment/agent-sandbox-controller --timeout=5m
```

The source archive pin for this candidate is
`b140c4b6ee108ed968ac69f277ba937637ed660bdb1d536129ae5c3fcab48c4b`.
Render without applying it:

```bash
: "${OCC_INPUT_DIRECTORY:?Set the protected deployment input directory}"
curl -fL https://github.com/NVIDIA/OpenShell/archive/refs/tags/v0.1.3-pre.1.tar.gz \
  -o "$OCC_INPUT_DIRECTORY/openshell-v0.1.3-pre.1.tar.gz"
python3 - "$OCC_INPUT_DIRECTORY/openshell-v0.1.3-pre.1.tar.gz" <<'PY'
import hashlib
import pathlib
import sys

actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
expected = "b140c4b6ee108ed968ac69f277ba937637ed660bdb1d536129ae5c3fcab48c4b"
if actual != expected:
    raise SystemExit("OpenShell source archive digest mismatch")
PY
install -d -m 700 "$OCC_INPUT_DIRECTORY/openshell-source"
tar -xzf "$OCC_INPUT_DIRECTORY/openshell-v0.1.3-pre.1.tar.gz" \
  -C "$OCC_INPUT_DIRECTORY/openshell-source"
helm template openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-source/OpenShell-0.1.3-pre.1/deploy/helm/openshell" \
  --namespace openshell-system \
  --set agentSandbox.preflight.enabled=false \
  -f deploy/examples/openshift-test/openshell-gateway-values.yaml \
  > "$OCC_INPUT_DIRECTORY/openshell-rendered.yaml"
```

After checking the rendered Pod labels against the policy selector, install
the gateway with its ingress policy already active:

```bash
oc create namespace openshell-system \
  --dry-run=client -o yaml | oc apply -f -
oc apply -f \
  deploy/examples/openshift-test/openshell-gateway-network-policy.yaml
helm upgrade --install openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-source/OpenShell-0.1.3-pre.1/deploy/helm/openshell" \
  --namespace openshell-system \
  -f deploy/examples/openshift-test/openshell-gateway-values.yaml \
  --wait --timeout 7m
oc -n openshell-system rollout status \
  statefulset/openshell-gateway --timeout=5m
oc -n openshell-system get pods,pvc,networkpolicy
oc -n openshell-system get pod openshell-gateway-0 \
  -o jsonpath='{.metadata.annotations.openshift\.io/scc}{"\n"}'
```

The gateway Pod must be ready under `restricted-v2`; its 1 GiB SQLite claim
must be bound to the selected block-backed RWO storage class.

The chart's default PKI initialization Job creates its JWT Secret. Install the
pinned Agent Sandbox controller and CRDs before the live Helm install; the
chart preflight verifies that prerequisite. Configure the OCE OpenShell Backend
with `insecureTransport: network-policy` and restrict gateway ingress to the
OCE controller. The gateway's plaintext setting is the documented
[trusted local development mode](https://github.com/NVIDIA/OpenShell/blob/v0.1.3-pre.1/docs/kubernetes/access-control.mdx#reverse-proxy-auth-termination)
used by the existing k3d proof, not a public OpenShift exposure.

The OpenShell Driver now has an explicit, temporary dedicated Codex
[test-cluster bridge](../../../reference/drivers/openshell-sandbox.md#configuration).
It stages the Agent-owned credentials and workload token in revision-owned PVC
paths through a Job and selects bearer passthrough for the protected app-server
route. Build and roll out a controller image containing the bridge before
trying an Agent. The bridge needs
tenant-local Job RBAC, a narrow SCC grant, and the first Agent's ServiceAccount
configured in both OCC and the OpenShell gateway. See the
[current upstream preconditions](../../../reference/drivers/openshell-sandbox.md#current-upstream-preconditions).

For a three-hour identity-token request, set
`drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds`
to `10800` in the protected Installation input before updating its startup
Secret. On ROSA, the [issued token lasts one year regardless of that request](https://docs.redhat.com/en/documentation/red_hat_openshift_service_on_aws/4/html/authentication_and_authorization/bound-service-account-tokens).
The bridge's copied token does not rotate, so inspect its actual `exp` claim
without printing the token and clean up the revision and its bootstrap Job
when the trial ends.

## Verify the first rollout

After the manifests and site inputs are reviewed, follow
[production installation](../production-installation.md), then require a ready API,
worker, private Gateway route, and authenticated `occ installation get` before
trying an Agent. Check the selected SCC annotation on each Pod and allowed and
denied network traffic. After the bridge and authenticated Codex transport exist,
follow the
[OpenShell real Sandbox proof](../../../testing/openshell.md#openshell-sandbox) for
credential attachment, a genuine Codex model turn, Pod replacement, and
cleanup. Record the Git revision, image digests, OpenShift/Kubernetes versions,
StorageClasses, SCC grants, GatewayClass, selectors, and outcome so the trial can
be reproduced.
