# Install OCC on an OpenShift test cluster

Install the OpenClaw Control Plane (OCC) after [preparing the OpenShift cluster](openshift-test.md). This procedure was exercised on OpenShift 4.22 with two `linux/amd64` workers, `gp3-csi`, the Red Hat cert-manager Operator, and the certified Crunchy Data PostgreSQL Operator. Run it from the matching source checkout. Keep the private kubeconfig and all passwords outside the repository. The NetworkPolicy examples use documentation-only IP addresses; replace them with values discovered on each cluster.

Select the private kubeconfig created during [cluster preparation](openshift-test.md#inspect-the-target-before-applying-manifests), then set the console hostname and initial administrator email. The latter is persisted during first bootstrap.

```bash
umask 077
export OCC_INPUT_DIRECTORY=/secure/occ
export CONTEXT='<reviewed oc context>'
export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"
export OCC_CONSOLE_HOST='<approved Route hostname>'
export OCC_ADMIN_EMAIL='<initial administrator email>'
test -s "$KUBECONFIG_FILE"
export KUBECONFIG="$KUBECONFIG_FILE"
test "$(oc config current-context)" = "$CONTEXT"
oc version
```

## Build the two images inside OpenShift

This path sends a source archive to the cluster builder and stores both images in the OpenShift internal registry. It does not push to GHCR. Confirm that the selected nodes are `amd64` and that the internal registry is available. Build from the source revision that will supply the Helm chart:

```bash
export OCC_REV="$(git rev-parse HEAD)"
oc get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
oc create namespace openclaw-system --dry-run=client -o yaml |
  oc apply -f -
oc process -f deploy/examples/openshift-test/image-builds-template.yaml \
  -p "REV=$OCC_REV" |
  oc -n openclaw-system apply -f -
git archive --format=tar -o "$OCC_INPUT_DIRECTORY/source.tar" HEAD
oc -n openclaw-system start-build oce-controller \
  --from-archive="$OCC_INPUT_DIRECTORY/source.tar" --follow --wait
oc -n openclaw-system start-build oce-runtime \
  --from-archive="$OCC_INPUT_DIRECTORY/source.tar" --follow --wait
```

Inspect each ImageStreamTag's architecture and digest. The references below must end in `@sha256:<digest>` and report `amd64`; use the same values in the Helm and Installation inputs.

```bash
oc -n openclaw-system get imagestreamtag "oce-controller:$OCC_REV" \
  -o jsonpath='{.image.dockerImageMetadata.Architecture}{"\n"}'
oc -n openclaw-system get imagestreamtag "oce-runtime:$OCC_REV" \
  -o jsonpath='{.image.dockerImageMetadata.Architecture}{"\n"}'
export CONTROLLER_IMAGE="$(oc -n openclaw-system \
  get imagestreamtag "oce-controller:$OCC_REV" -o jsonpath='{.image.dockerImageReference}')"
export RUNTIME_IMAGE="$(oc -n openclaw-system \
  get imagestreamtag "oce-runtime:$OCC_REV" -o jsonpath='{.image.dockerImageReference}')"
[[ "$CONTROLLER_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]
[[ "$RUNTIME_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]]
```

## Install and initialize PostgreSQL

Confirm that the `certified-operators` catalog offers `postgresoperator.v5.8.9`. The [Operator subscription](../../../../deploy/examples/openshift-test/postgres-operator.yaml) and [cluster](../../../../deploy/examples/openshift-test/postgres-cluster.yaml) select PostgreSQL 18 and `gp3-csi`. Review the storage sizes for the test cluster, then install:

```bash
oc -n openshift-marketplace get packagemanifest crunchy-postgres-operator
oc apply -f deploy/examples/openshift-test/postgres-operator.yaml
oc -n openclaw-postgres get csv,subscription
oc -n openclaw-postgres wait \
  --for=jsonpath='{.status.installedCSV}'=postgresoperator.v5.8.9 \
  subscription/crunchy-postgres-operator --timeout=5m
oc -n openclaw-postgres wait --for=jsonpath='{.status.phase}'=Succeeded \
  csv/postgresoperator.v5.8.9 --timeout=5m
oc wait --for=condition=Established \
  crd/postgresclusters.postgres-operator.crunchydata.com --timeout=5m
oc apply -f deploy/examples/openshift-test/postgres-cluster.yaml
oc -n openclaw-postgres get postgrescluster,pods,pvc
```

Wait for the primary Pod and both claims to become ready and bound. Run this block once for a fresh database; the SQL creates a schema owner and a limited application role. It runs through the operator Pod's local PostgreSQL socket. Select the actual primary Pod by its operator labels before setting `POSTGRES_POD`.

```bash
(
  set -eC
  openssl rand -hex 24 > "$OCC_INPUT_DIRECTORY/occ-migrator-password"
  openssl rand -hex 24 > "$OCC_INPUT_DIRECTORY/occ-application-password"
)
export POSTGRES_POD="$(oc -n openclaw-postgres get pods \
  -l postgres-operator.crunchydata.com/cluster=oce-postgres,postgres-operator.crunchydata.com/role=master \
  -o jsonpath='{.items[0].metadata.name}')"
(
  printf "\\set migrator_password '%s'\n" "$(cat "$OCC_INPUT_DIRECTORY/occ-migrator-password")"
  printf "\\set application_password '%s'\n" "$(cat "$OCC_INPUT_DIRECTORY/occ-application-password")"
  cat deploy/examples/openshift-test/postgres-bootstrap.sql
) | oc -n openclaw-postgres exec -i "$POSTGRES_POD" \
  -c database -- psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f -
```

Read the CA from `oce-postgres-cluster-cert` without displaying it. Build both URL files for the primary Service with their respective passwords and full TLS verification. Retain these files and the signing secret across Helm upgrades. Never place passwords in Helm values or the Installation YAML.

```bash
oc -n openclaw-postgres get secret oce-postgres-cluster-cert \
  -o jsonpath='{.data.ca\.crt}' | base64 --decode > "$OCC_INPUT_DIRECTORY/occ-database-ca.pem"
python3 - "$OCC_INPUT_DIRECTORY" <<'PY'
from pathlib import Path
from urllib.parse import quote
import sys

root = Path(sys.argv[1])
for role, password_file, output_file in (
    ('occ_migrator', 'occ-migrator-password', 'occ-migration-url'),
    ('occ_app', 'occ-application-password', 'occ-application-url'),
):
    password = quote((root / password_file).read_text().strip(), safe='')
    url = f'postgresql://{role}:{password}@oce-postgres-primary.openclaw-postgres.svc:5432/openclaw_enterprise?sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem'
    (root / output_file).write_text(url)
PY
(
  set -eC
  openssl rand -hex 32 > "$OCC_INPUT_DIRECTORY/occ-auth-secret"
)
```

## Prepare cluster-specific inputs and policy

Copy the [production manual examples](../production-installation.md#advanced-copy-manual-yaml-examples) into the protected directory. Set the Helm controller image, `auth.baseUrl` to `https://$OCC_CONSOLE_HOST`, `bootstrap.adminEmail`, database CA Secret, database primary Pod CIDR, actual OpenShift DNS labels, router Pod selector and trusted proxy CIDRs, API Service and translated endpoint CIDRs, and control-plane node selector. Set `agentNativeAdmin.enabled: false` and `gatewayRouting.enabled: false` for this initial OCC trial. The latter is a temporary limit until a compatible Envoy GatewayClass and authenticated workspace route are installed.

In `installation.yaml`, set the OpenShift cluster name, both immutable runtime image references, OpenShift DNS labels, `gp3-csi` Gateway storage, disjoint control and Agent node selectors, and `network.gatewayClients` to the OCC API Pod labels. Remove `compute.configuration.gatewayRouting` while Helm routing is disabled. `network.gatewayTrustedProxyCidrs` must be present; `127.0.0.1/32` is a loopback-only test value until an actual authenticated proxy is configured. Set the bootstrap PVC storage class to `gp3-csi`.

For the two-worker test cluster, this block fills those fields from observed
resources. Check that the selected PostgreSQL primary and Kubernetes API
EndpointSlice each have one address; review every generated CIDR before applying
the policies. Retain the files outside the checkout:

```bash
install -m 600 deploy/examples/production/values.yaml "$OCC_INPUT_DIRECTORY/values.yaml"
install -m 600 deploy/examples/production/installation.yaml "$OCC_INPUT_DIRECTORY/installation.yaml"
install -m 600 deploy/examples/production/bootstrap-pvc.yaml "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
export PG_POD_CIDR="$(oc -n openclaw-postgres get pod \
  -l postgres-operator.crunchydata.com/role=master \
  -o jsonpath='{.items[0].status.podIP}')/32"
export API_SERVICE_CIDR="$(oc -n default get service kubernetes \
  -o jsonpath='{.spec.clusterIP}')/32"
export API_ENDPOINT_CIDR="$(oc -n default get endpointslices \
  -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[0].endpoints[0].addresses[0]}')/32"
oc -n openshift-ingress get pods -o json |
  jq '[.items[].status.podIP + "/32"]' > "$OCC_INPUT_DIRECTORY/router-cidrs.json"
export OCC_CLUSTER_NAME="$(oc get infrastructure.config.openshift.io cluster \
  -o jsonpath='{.status.infrastructureName}')"
yq -i '.images.controller = strenv(CONTROLLER_IMAGE) |
  .auth.baseUrl = "https://" + strenv(OCC_CONSOLE_HOST) |
  .bootstrap.adminEmail = strenv(OCC_ADMIN_EMAIL) |
  .agentNativeAdmin.enabled = false |
  .agentNativeAdmin.domain = "" | .agentNativeAdmin.sharedCookieDomain = "" |
  .database.caSecretName = "occ-database-ca" |
  .database.cidrs = [strenv(PG_POD_CIDR)] |
  .api.clients = [{"namespace":"openshift-ingress","podLabels":{
    "ingresscontroller.operator.openshift.io/deployment-ingresscontroller":"default"}}] |
  .api.trustedProxy = {"preset":"generic",
    "cidrs":load(strenv(OCC_INPUT_DIRECTORY) + "/router-cidrs.json"),
    "clientAddressHeader":"x-forwarded-for"} |
  .cluster.cidrs = [strenv(API_SERVICE_CIDR), strenv(API_ENDPOINT_CIDR)] |
  .gatewayRouting.enabled = false |
  .dns = {"namespace":"openshift-dns","podLabels":{
    "dns.operator.openshift.io/daemonset-dns":"default","k8s-app":null}}' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
yq -i '.occ.cluster = strenv(OCC_CLUSTER_NAME) |
  .drivers.compute.configuration.images.gateway = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.images.agent = strenv(RUNTIME_IMAGE) |
  .drivers.compute.configuration.network.dns = {"namespace":"openshift-dns",
    "podLabels":{"dns.operator.openshift.io/daemonset-dns":"default"}} |
  .drivers.compute.configuration.network.gatewayTrustedProxyCidrs = ["127.0.0.1/32"] |
  del(.drivers.compute.configuration.gatewayRouting) |
  .drivers.compute.configuration.runtime.gatewayStorageClassName = "gp3-csi" |
  .drivers.compute.configuration.runtime.nodeSelector = {"oce-role":"agent"} |
  .drivers.compute.configuration.runtime.gatewayNodeSelector = {"oce-role":"control"} |
  .drivers.compute.configuration.servicePrincipalCredentials.expirationSeconds = 10800' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
yq -i '.spec.storageClassName = "gp3-csi"' "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
```

The `null` DNS label removes the Helm chart's `k8s-app=kube-dns` default during
values merging. Confirm that the rendered DNS policy selects only the observed
OpenShift DNS Pods before installation.

For the `oce` Helm release, set the required Gateway client peer explicitly:

```bash
yq -i '.drivers.compute.configuration.network.gatewayClients = [{"namespace":"openclaw-system","podLabels":{"app.kubernetes.io/name":"openclaw-enterprise","app.kubernetes.io/instance":"oce","app.kubernetes.io/component":"api"}}]' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Verify the configured DNS Pod labels, PostgreSQL primary Service and Pod, and Kubernetes API EndpointSlice against the cluster. The Helm chart grants DNS egress to the configured Pods on UDP/TCP ports `53` and `5353`. The [Kubernetes API](../../../../deploy/examples/openshift-test/control-plane-kube-api-egress.yaml) policy contains `192.0.2.0/24` documentation addresses; replace them in the protected copy before applying. The [PostgreSQL policy](../../../../deploy/examples/openshift-test/control-plane-postgres-egress.yaml) selects the operator's primary Pod by label. This trial's OpenShift DNS used Pod port `5353`, and OVN translated the API Service's port `443` to endpoint port `6443`; verify both ports on a new cluster.

```bash
for name in control-plane-postgres-egress control-plane-kube-api-egress; do
  install -m 600 "deploy/examples/openshift-test/$name.yaml" "$OCC_INPUT_DIRECTORY/$name.yaml"
done
yq -i '.spec.egress[0].to[0].ipBlock.cidr = strenv(API_ENDPOINT_CIDR)' \
  "$OCC_INPUT_DIRECTORY/control-plane-kube-api-egress.yaml"
oc -n openshift-dns get service dns-default -o wide
oc -n openshift-dns get pods -o wide --show-labels
oc -n openclaw-postgres get service oce-postgres-primary -o wide
oc -n openclaw-postgres get pods -o wide --show-labels
oc -n default get service kubernetes -o wide
oc -n default get endpointslices -l kubernetes.io/service-name=kubernetes
oc -n openshift-ingress get pods -o wide --show-labels
oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-postgres-egress.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-kube-api-egress.yaml"
```

Apply the [fixed UID SCC](../../../../deploy/examples/openshift-test/fixed-uid-scc.yaml) and its [exact control-plane grant](../../../../deploy/examples/openshift-test/control-plane-scc-rbac.yaml). Create the bootstrap claim. The preparation helper needs a temporary narrow SCC to set the fresh volume root to UID/GID 1000 and mode 0700; delete that grant immediately after the helper succeeds. This helper requires an explicit `--context` argument even with `KUBECONFIG` set.

```bash
oc apply -f deploy/examples/openshift-test/fixed-uid-scc.yaml
oc apply -f deploy/examples/openshift-test/control-plane-scc-rbac.yaml
oc -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"
oc apply -f deploy/examples/openshift-test/bootstrap-prep-scc.yaml
scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" \
  --context "$CONTEXT" --namespace openclaw-system \
  --claim occ-bootstrap-admin-password --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control
oc -n openclaw-system delete rolebinding oce-bootstrap-volume-prep
oc -n openclaw-system delete role oce-bootstrap-volume-prep
oc delete scc oce-bootstrap-volume-prep
```

## Add the OpenShell workspace configuration

After installing the [OpenShell gateway](openshift-test.md#stage-openshell-separately), render its pinned workspace chart. Its four resources become namespace-agnostic Installation input; OCC creates them in each OpenShell workspace. The values file sets the gateway Pod selector and its ServiceAccount explicitly.

```bash
export OPEN_SHELL_CHART="$OCC_INPUT_DIRECTORY/openshell-source/OpenShell-0.1.3-pre.1/deploy/helm/openshell-workspace"
helm template openshell-workspace "$OPEN_SHELL_CHART" \
  --namespace openclaw-workspace-template \
  -f deploy/examples/openshift-test/openshell-workspace-values.yaml \
  > "$OCC_INPUT_DIRECTORY/openshell-workspace-rendered.yaml"
yq eval-all -o=json -I=0 '[.] | del(.[].metadata.namespace)' \
  "$OCC_INPUT_DIRECTORY/openshell-workspace-rendered.yaml" \
  > "$OCC_INPUT_DIRECTORY/openshell-workspace-resources.json"
export OPEN_SHELL_FRAGMENT=deploy/examples/openshift-test/openshell-installation-fragment.yaml
export OPEN_SHELL_WORKSPACE_RESOURCES="$OCC_INPUT_DIRECTORY/openshell-workspace-resources.json"
yq -i '. *= load(strenv(OPEN_SHELL_FRAGMENT))' "$OCC_INPUT_DIRECTORY/installation.yaml"
yq -i '.drivers.sandbox.configuration.gateway.operatorWorkspaceResources = load(strenv(OPEN_SHELL_WORKSPACE_RESOURCES))' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
yq -e '.drivers.sandbox.configuration.gateway.operatorWorkspaceResources | length == 4' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
for node in $(oc get nodes -l oce-role=agent -o name); do
  oc debug "$node" -- chroot /host crun --version
done
oc apply -f deploy/examples/openshift-test/openshell-runtimeclass.yaml
oc apply -f deploy/examples/openshift-test/openshell-workspace-writer-clusterrole.yaml
node --input-type=module -e '
  import { loadInstallationConfiguration } from "./apps/controller/src/composition/installation-config.ts";
  await loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: process.argv[1] } });
  console.log("Installation configuration valid");
' "$OCC_INPUT_DIRECTORY/installation.yaml"
```

The loader check uses this checkout's installed workspace dependencies. The ClusterRole is bound to the worker only in the discovered tenant namespace below. The [OpenShell preparation guide](openshift-test.md#stage-openshell-separately) describes the separate test-cluster Agent prerequisites; this installation step does not start an Agent.

The OpenShell policy grants read-only access to `/app` so the dedicated Agent can
load its installed runtime and copy bundled skills into its workspace mount.

Create the `occ-database`, `occ-database-ca`, `occ-auth`, and `occ-installation-startup` Secrets from protected files using [the production commands](../production-installation.md#provision-system-secrets-and-install). Render the chart and use a server-side dry run before installing:

```bash
yq -i '.worker.maxAttempts = 30 | .worker.leaseDurationMs = 30000' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
helm template oce deploy/helm/openclaw-enterprise --namespace openclaw-system \
  -f "$OCC_INPUT_DIRECTORY/values.yaml" > "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"
oc apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 7m
oc -n openclaw-system get jobs,deployments,pods
```

The test-cluster worker settings allow the Gateway to become ready during the
first Agent reconciliation and keep the claim alive during OpenShell Sandbox
preparation.

Expect the initialization Job to complete and both API and worker Deployments to reach `1/1`. Bootstrap creates a platform Namespace named `default`; the worker creates its data-plane and Gateway runtime Kubernetes namespaces. Discover their names from the platform Namespace ID, then grant the documented [tenant RoleBindings](../production-agents.md#grant-tenant-rolebindings). The worker cannot finish reconciliation until these exact tenant-local grants exist.

```bash
export NAMESPACE_ID='<server-assigned default Namespace ID>'
export TENANT_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/namespace=$NAMESPACE_ID" -o jsonpath='{.items[0].metadata.name}')"
oc -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker \
  --serviceaccount=openclaw-system:openclaw-enterprise-worker
oc -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-api-observer \
  --clusterrole=oce-openclaw-gateway-observer \
  --serviceaccount=openclaw-system:openclaw-enterprise-api
oc -n "$TENANT_NAMESPACE" create rolebinding openclaw-enterprise-worker-openshell \
  --clusterrole=oce-openshell-workspace-writer \
  --serviceaccount=openclaw-system:openclaw-enterprise-worker
export GATEWAY_RUNTIME_NAMESPACE="$(oc get namespaces \
  -l "openclaw.dev/gateway-namespace=$NAMESPACE_ID" \
  -o jsonpath='{.items[0].metadata.name}')"
oc -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-worker \
  --clusterrole=oce-openclaw-tenant-worker \
  --serviceaccount=openclaw-system:openclaw-enterprise-worker
oc -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-api-secrets \
  --clusterrole=oce-openclaw-tenant-api \
  --serviceaccount=openclaw-system:openclaw-enterprise-api
oc -n "$GATEWAY_RUNTIME_NAMESPACE" create rolebinding openclaw-enterprise-api-configuration \
  --clusterrole=oce-openclaw-tenant-configuration \
  --serviceaccount=openclaw-system:openclaw-enterprise-api
```

Read the server-assigned ID from `occ namespace list` after protected service-key authentication, or from the `openclaw.dev/namespace` label on the single newly created data-plane namespace during first bootstrap. Expect the worker log to report `NAMESPACE_RECONCILED`.

Copy the [Route candidate](../../../../deploy/examples/openshift-test/console-route.yaml) into the protected directory, replace `spec.host` with `$OCC_CONSOLE_HOST`, and apply it. Verify that its `Admitted` condition is `True`, that `https://$OCC_CONSOLE_HOST/healthz` returns 200 with valid TLS, and that `/console/login` returns HTML. Retrieve the initial admin password or service key only through your approved protected-storage procedure before testing authenticated operations. API health and the login page do not prove authentication or Agent execution.

```bash
install -m 600 deploy/examples/openshift-test/console-route.yaml \
  "$OCC_INPUT_DIRECTORY/console-route.yaml"
yq -i '.spec.host = strenv(OCC_CONSOLE_HOST)' "$OCC_INPUT_DIRECTORY/console-route.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/console-route.yaml"
oc -n openclaw-system get route openclaw-enterprise-console
curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/healthz" >/dev/null
curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/console/login" >/dev/null
```

Retrieve the bootstrap key and password from the protected claim through a short-lived, read-only Pod. Keep both files private. The image must match the installed controller digest. Delete the Pod as soon as the files are copied:

```bash
install -m 600 deploy/examples/openshift-test/bootstrap-read-pod.yaml \
  "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
yq -i '.spec.containers[0].image = strenv(CONTROLLER_IMAGE)' \
  "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/bootstrap-read-pod.yaml"
oc -n openclaw-system wait --for=condition=Ready \
  pod/occ-bootstrap-read --timeout=90s
oc -n openclaw-system exec pod/occ-bootstrap-read -- \
  cat /bootstrap/initial-admin-service-key.json \
  > "$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
oc -n openclaw-system exec pod/occ-bootstrap-read -- \
  cat /bootstrap/initial-admin-password \
  > "$OCC_INPUT_DIRECTORY/initial-admin-password"
chmod 600 "$OCC_INPUT_DIRECTORY/initial-admin-service-key.json" \
  "$OCC_INPUT_DIRECTORY/initial-admin-password"
oc -n openclaw-system delete pod occ-bootstrap-read --wait=true
export OCC_URL="https://$OCC_CONSOLE_HOST"
export OCC_SERVICE_KEY_FILE="$OCC_INPUT_DIRECTORY/initial-admin-service-key.json"
go build -trimpath -o bin/occ ./cmd/occ
bin/occ installation get
bin/occ namespace list
```

Expect the Installation ID to match `meta.installationId` in the protected service-key response and the default Namespace to report `ready`. Open `https://$OCC_CONSOLE_HOST/console/login` in a browser and sign in with the configured `bootstrap.adminEmail` and the password in `initial-admin-password`. Before deploying a dedicated Codex Agent, [enable private routing](openshift-test-routing.md) and [prepare the Agent](openshift-test-agent.md) with the test-cluster bridge.
