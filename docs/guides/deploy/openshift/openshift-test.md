# Prepare an OpenShift test cluster

Prepare the cluster before installing OpenClaw Enterprise (OCE) and its
OpenClaw Control Plane (OCC). Use dedicated Codex through
OpenShell. Run the command blocks in order from the repository root. This is a
test procedure, not a supported production OpenShell deployment.

## Inspect the target before applying manifests

These commands use the current context in your kubeconfig. Copy its credentials
to a private directory outside the checkout, then select that copy for this shell.
All following `oc` and Helm commands use `KUBECONFIG`. Record the output with the
deployment inputs:

**Select private inputs and inspect the cluster.**

```bash
umask 077

export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-$HOME/.local/state/openclaw-enterprise/openshift-test}"

install -d -m 700 "$OCC_INPUT_DIRECTORY"

oc config view --raw --minify --flatten > "$OCC_INPUT_DIRECTORY/kubeconfig.new"

mv "$OCC_INPUT_DIRECTORY/kubeconfig.new" "$OCC_INPUT_DIRECTORY/kubeconfig"

export KUBECONFIG="$OCC_INPUT_DIRECTORY/kubeconfig"

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

**Label the two workers.**

```bash
# REQUIRED: replace the placeholder with the value described above.
export CONTROL_NODE='<ready amd64 control node>'

# REQUIRED: replace the placeholder with the value described above.
export AGENT_NODE='<different ready amd64 Agent node>'

test "$CONTROL_NODE" != "$AGENT_NODE"

oc label node "$CONTROL_NODE" oce-role=control --overwrite

oc label node "$AGENT_NODE" oce-role=agent --overwrite

oc get nodes -L oce-role
```

The Kubernetes Compute requirement
is Kubernetes 1.35 or later. A lower server version produces a startup warning
and is outside the supported boundary. Check the reported Kubernetes version,
not the local `oc` version. Verify that the selected CNI enforces NetworkPolicies, storage supports the
requested RWO claims, and the cluster can run the digest-pinned images. Record the actual
DNS Pod labels, API and PostgreSQL endpoints, router Pod labels, and proxy
source addresses for the shared Helm and Installation inputs. The existing
production examples use `kube-system` DNS labels and are not OpenShift defaults.
Inspect the current DNS endpoints and their port rather than assuming port 53.

Private dedicated Gateway routing requires an Envoy GatewayClass and
cert-manager. The initial OCC installation disables
Gateway routing while verifying the control plane. Then follow the
private routing procedure for this cluster's
Gateway API version and OpenShift admission. Do not substitute the OpenShift
built-in GatewayClass: the OCE chart creates Envoy `SecurityPolicy` resources.
OpenShift 4.19 and later manages Gateway API CRDs through its Ingress Operator;
leave those CRDs under OpenShift management during the later routing procedure.

For this OpenShift 4.22 test cluster, use the Red Hat cert-manager Operator
from the `redhat-operators` catalog. Confirm that no cert-manager Subscription
or certificate CRD already exists, and that the catalog offers the pinned
`stable-v1.20` channel and `cert-manager-operator.v1.20.1` CSV. The
operator manifest
creates its namespace, cluster-wide OperatorGroup, and Subscription. Install
it once, then wait for the operator and certificate API before rendering OCE:

**Check and install cert-manager.**

```bash
oc get subscriptions -A | rg 'cert-manager' || true

oc get crd certificates.cert-manager.io 2>&1 || true

oc -n openshift-marketplace get packagemanifest \
  openshift-cert-manager-operator \
  -o jsonpath='{.status.catalogSource}{" "}{range .status.channels[*]}{.name}{" "}{.currentCSV}{"\n"}{end}'

oc apply -f \
  deploy/examples/openshift-test/base/operators/cert-manager-operator.yaml

oc -n cert-manager-operator get csv,subscriptions

oc -n cert-manager-operator wait \
  --for=jsonpath='{.status.installedCSV}'=cert-manager-operator.v1.20.1 \
  subscription/openshift-cert-manager-operator --timeout=5m

oc -n cert-manager-operator wait --for=jsonpath='{.status.phase}'=Succeeded \
  csv/cert-manager-operator.v1.20.1 --timeout=5m

oc wait --for=condition=Established \
  crd/certificates.cert-manager.io --timeout=5m
```

## Prepare fixed-UID admission

OCE's Helm Pods and ordinary Kubernetes Compute workloads explicitly run as UID
and GID 1000. OpenShift's default restricted SCC admits only a namespace-allocated UID
range, which may not contain 1000. The candidate
SCC allows UID and
filesystem group 1000, drops all capabilities, and permits the volume
types used by OCE. Its
control-plane RoleBinding
grants use to the three Helm ServiceAccounts in `openclaw-system`. Review both
with the cluster administrator. The admission stage creates `openclaw-system`
before its namespaced grants; apply it before the Helm pre-install Job:

**Apply fixed-UID admission.**

```bash
oc apply -k deploy/examples/openshift-test/overlays/test/admission
```

Grant the same SCC only to the exact Gateway and Harness ServiceAccounts after
Compute creates each runtime namespace. Use a namespaced Role and RoleBinding
for each discovered ServiceAccount; do not grant all ServiceAccounts in a tenant
namespace. Check admission through Pod events and the
`openshift.io/scc` Pod annotation. OpenShell's init and supervisor Pods require
separate admission review. This SCC does **not** admit their privileged shape.

## Prepare the control-plane Route

Choose an OCC hostname under the cluster's ingress domain. The command below
uses `occ.<ingress-domain>`; for example, `occ.apps.cluster.example.com`. It
reads the domain from the selected cluster and writes the hostname into the
private Route copy.

For this test, keep `termination: edge` and `insecureEdgeTerminationPolicy: Redirect`: the router serves HTTPS, redirects HTTP to HTTPS, and forwards HTTP
to OCC's API Service. Leave `certificate`, `key`, and `caCertificate` absent to
use the cluster's default ingress certificate. Confirm that it covers the chosen
hostname and that your browser trusts its issuer. A custom hostname outside this
domain needs approved DNS and a matching certificate; follow the cluster's
[certificate procedure](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ingress_and_load_balancing/routes).

**Prepare the Console Route file.**

```bash
: "${OCC_INPUT_DIRECTORY:?Set the private deployment input directory}"

export CLUSTER_APPS_DOMAIN="$(oc get \
  ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')"

test -n "$CLUSTER_APPS_DOMAIN"

export OCC_CONSOLE_HOST="occ.$CLUSTER_APPS_DOMAIN"

test -e "$OCC_INPUT_DIRECTORY/console-route.yaml" || \
  install -m 600 deploy/examples/openshift-test/base/control-plane/console-route.yaml \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"

yq -e '.spec.tls.certificate == null and .spec.tls.key == null and
  .spec.tls.caCertificate == null' "$OCC_INPUT_DIRECTORY/console-route.yaml" >/dev/null &&
  yq -i '.spec.host = strenv(OCC_CONSOLE_HOST) |
    .spec.tls.termination = "edge" |
    .spec.tls.insecureEdgeTerminationPolicy = "Redirect"' \
    "$OCC_INPUT_DIRECTORY/console-route.yaml"

yq '{"host": .spec.host, "tls": {"termination": .spec.tls.termination,
  "insecureEdgeTerminationPolicy": .spec.tls.insecureEdgeTerminationPolicy}}' \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"
```

Expect `host: occ.<your-ingress-domain>`, `termination: edge`, and
`insecureEdgeTerminationPolicy: Redirect`. The certificate check stops this
default-certificate path if an existing private copy contains custom certificate
fields; retain those fields and use the custom-certificate procedure instead.
This step prepares the file only; the installation guide applies it after Helm's
`openclaw-enterprise-api` Service and API Pod are ready.

The installation helper sets Helm `auth.baseUrl` to this exact HTTPS origin and
configures router access. Its API ingress NetworkPolicy needs the observed
`openshift-ingress` Pod selector, router CIDRs, and forwarded client-address
header. Verify both an allowed Console request and a denied request from an
unrelated Pod; a healthy Route alone does not prove the policy boundary.

## Stage OpenShell separately

The OpenShell values candidate
uses pinned v0.1.3 gateway images and OpenShift admission settings.
OpenShell v0.1.3 requires OpenShift 4.19 or later with Landlock available.
Use the published gateway and workspace Helm charts for the same `0.1.3`
release, then
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

The gateway ingress policy
admits OCE API and worker Pods, Agent Gateway Pods, and supervisor Pods in labeled
workspace namespaces on port 8080. Compare its selectors with the rendered
Gateway and supervisor Pod labels before applying it. Apply the policy before
starting the gateway so unauthenticated requests have no wider ingress window.
The controller egress policy belongs to `openclaw-system`. Ensure that namespace
exists before applying the matching
controller egress policy;
the OCE chart defaults to denied egress.

**Apply OpenShell egress prerequisites.**

```bash
oc apply -f \
  deploy/examples/openshift-test/base/admission/namespace.yaml

oc apply -f \
  deploy/examples/openshift-test/base/openshell/control-plane-openshell-egress.yaml
```

Install the pinned Agent Sandbox v0.5.2 controller manifest first. Its SHA-256
is verified by the checksum command below:

**Install Agent Sandbox.**

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

Pull the published charts from GitHub Container Registry into the private input
directory. The chart version is `0.1.3` (without the release tag's leading
`v`). Verify both package checksums, then render the gateway without applying it:

**Download and verify OpenShell charts.**

```bash
: "${OCC_INPUT_DIRECTORY:?Set the private deployment input directory}"

install -d -m 700 "$OCC_INPUT_DIRECTORY/openshell-charts"

helm pull oci://ghcr.io/nvidia/openshell/helm-chart \
  --version 0.1.3 --destination "$OCC_INPUT_DIRECTORY/openshell-charts"

helm pull oci://ghcr.io/nvidia/openshell/openshell-workspace \
  --version 0.1.3 --destination "$OCC_INPUT_DIRECTORY/openshell-charts"

printf '%s  %s\n' \
  5a82e27d6cf4089fa16d96c87d9fc0fe62f65fa05341465bc749ba5ab91abb33 \
  "$OCC_INPUT_DIRECTORY/openshell-charts/helm-chart-0.1.3.tgz" \
  8dd207ae894d68aa5fbf825df44951d8321df6611a7c68609ba9e389b49d39a7 \
  "$OCC_INPUT_DIRECTORY/openshell-charts/openshell-workspace-0.1.3.tgz" \
  | shasum -a 256 -c

helm template openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-charts/helm-chart-0.1.3.tgz" \
  --namespace openshell-system \
  --set agentSandbox.preflight.enabled=false \
  -f deploy/examples/openshift-test/openshell-gateway-values.yaml \
  > "$OCC_INPUT_DIRECTORY/openshell-rendered.yaml"
```

Keep both packages for installation and workspace rendering. This downloads
packaged charts; it does not build OpenShell or require its source tree. The
values file still selects digest-pinned gateway, sandbox, and supervisor images.

After checking the rendered Pod labels against the policy selector, install
the gateway with its ingress policy already active:

**Install and verify the OpenShell gateway.**

```bash
oc create namespace openshell-system \
  --dry-run=client -o yaml | oc apply -f -

oc apply -f \
  deploy/examples/openshift-test/base/openshell/openshell-gateway-network-policy.yaml

helm upgrade --install openshell-gateway \
  "$OCC_INPUT_DIRECTORY/openshell-charts/helm-chart-0.1.3.tgz" \
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
trusted local development mode
used by the existing k3d proof, not a public OpenShift exposure.

The current Driver uses a revision-owned runtime provider
for Codex configuration and workspace-node setup. ServicePrincipal credentials
must be disabled; OpenShell cannot preserve projected Agent identity. The
test Installation fragment
sets that limit and uses Compute's provider Harness route.

## Verify the first rollout

When cert-manager and OpenShell are ready and the private Route file is prepared,
continue to [Install OCC](openshift-test-install.md). Complete that page before
starting private routing or creating an Agent.
