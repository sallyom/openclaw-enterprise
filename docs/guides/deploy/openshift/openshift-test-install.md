# Install OCC on an OpenShift test cluster

Install the OpenClaw Control Plane (OCC) after preparing the OpenShift cluster. This procedure was exercised on OpenShift 4.22 with two `linux/amd64` workers, `gp3-csi`, the Red Hat cert-manager Operator, and the certified Crunchy Data PostgreSQL Operator. Run it from the matching source checkout. Keep the private kubeconfig and all passwords outside the repository. The NetworkPolicy examples use documentation-only IP addresses; replace them with values discovered on each cluster.

Use the private kubeconfig and Route prepared during cluster preparation. Read the console hostname from that Route and set the initial administrator email; the email is persisted during first bootstrap.

**Set installation inputs.**

```bash
umask 077

export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-$HOME/.local/state/openclaw-enterprise/openshift-test}"

export KUBECONFIG_FILE="$OCC_INPUT_DIRECTORY/kubeconfig"

test -s "$OCC_INPUT_DIRECTORY/console-route.yaml"

export OCC_CONSOLE_HOST="$(yq -r '.spec.host' "$OCC_INPUT_DIRECTORY/console-route.yaml")"

test -n "$OCC_CONSOLE_HOST" && test "$OCC_CONSOLE_HOST" != null

export OCC_ADMIN_EMAIL="${OCC_ADMIN_EMAIL:-occ-admin@example.test}"

test -s "$KUBECONFIG_FILE"

export KUBECONFIG="$KUBECONFIG_FILE"

oc version
```

## Build the two images inside OpenShift

This path builds the unmodified OCE `origin/main` source in the OpenShift internal
registry. The runtime uses that revision's reviewed OpenClaw source pin and Codex
dependency patch; no native-worker trial patch or local OpenClaw checkout is used.
Fetch main first, then record its exact revision and runtime source pin. The
OpenShift files in this branch only prepare deployment inputs.

**Select the main source revision and its standard runtime pin.**

```bash
git fetch origin main

export OCC_REV="$(git rev-parse origin/main)"

export OPENCLAW_COMMIT="$(git show "$OCC_REV:deploy/runtime/Dockerfile" |
  sed -n 's/^ARG OPENCLAW_COMMIT=//p')"

export OPENCLAW_SOURCE_SHA256="$(git show "$OCC_REV:deploy/runtime/Dockerfile" |
  awk '/openclaw-source.tar.gz.*sha256sum/ {gsub(/\047/, "", $2); print $2}')"

[[ "$OPENCLAW_COMMIT" =~ ^[a-f0-9]{40}$ ]]

[[ "$OPENCLAW_SOURCE_SHA256" =~ ^[a-f0-9]{64}$ ]]

export OCC_RUNTIME_TAG="$OCC_REV-$OPENCLAW_COMMIT"

jq -n --arg oce "$OCC_REV" --arg openclaw "$OPENCLAW_COMMIT" \
  --arg archive "$OPENCLAW_SOURCE_SHA256" \
  '{oceCommit:$oce, openclawCommit:$openclaw, sourceArchiveSha256:$archive}' \
  > "$OCC_INPUT_DIRECTORY/runtime-source.json"
```

Prepare the BuildConfigs and source archives.

**Prepare cluster build inputs.**

```bash
oc get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture

oc create namespace openclaw-system --dry-run=client -o yaml |
  oc apply -f -

oc process -f deploy/examples/openshift-test/image-builds-template.yaml \
  -p "REV=$OCC_REV" -p "RUNTIME_TAG=$OCC_RUNTIME_TAG" |
  oc -n openclaw-system apply -f -

git archive --format=tar -o "$OCC_INPUT_DIRECTORY/source.tar" "$OCC_REV"
```

Start the controller build, then the runtime build. Wait for both to finish.

**Build both images.**

```bash
oc -n openclaw-system start-build oce-controller \
  --from-archive="$OCC_INPUT_DIRECTORY/source.tar" --follow --wait

oc -n openclaw-system start-build oce-runtime \
  --from-archive="$OCC_INPUT_DIRECTORY/source.tar" --follow --wait
```

Build output can leave ImageStreamTag metadata incomplete. The helper fetches complete registry metadata with `ImageStreamImport.spec.import: false`, leaving tags unchanged. It requires `amd64` and saves immutable references in `build-images.json` and `images.env`; use them for Helm and Installation inputs.

**Verify image architecture and digests.**

```bash
deploy/examples/openshift-test/verify-images

source "$OCC_INPUT_DIRECTORY/images.env"
```

The runtime tag records both source revisions. Retain `runtime-source.json`,
`source.tar`, and `build-images.json` to reproduce the build. A completed image
build still requires enrollment, workspace, and model verification after deployment.

## Install and initialize PostgreSQL

Confirm that the `certified-operators` catalog offers `postgresoperator.v5.8.9`. The Operator subscription and cluster select PostgreSQL 18 and `gp3-csi`. Review the storage sizes for the test cluster, then install:

**Install the PostgreSQL Operator.**

```bash
oc -n openshift-marketplace get packagemanifest crunchy-postgres-operator

oc apply -f deploy/examples/openshift-test/base/operators/postgres-operator.yaml

oc -n openclaw-postgres get csv,subscription

oc -n openclaw-postgres wait \
  --for=jsonpath='{.status.installedCSV}'=postgresoperator.v5.8.9 \
  subscription/crunchy-postgres-operator --timeout=5m

oc -n openclaw-postgres wait --for=jsonpath='{.status.phase}'=Succeeded \
  csv/postgresoperator.v5.8.9 --timeout=5m

oc wait --for=condition=Established \
  crd/postgresclusters.postgres-operator.crunchydata.com --timeout=5m
```

Create the PostgreSQL cluster after its CRD is established.

**Create the PostgreSQL cluster.**

```bash
oc apply -f deploy/examples/openshift-test/base/database/postgres-cluster.yaml

oc -n openclaw-postgres get postgrescluster,pods,pvc
```

Wait for the primary Pod and both claims to become ready and bound. Run this block once for a fresh database; the SQL creates a schema owner and a limited application role. It runs through the operator Pod's local PostgreSQL socket. Select the actual primary Pod by its operator labels before setting `POSTGRES_POD`.

**Create database roles and passwords.**

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

**Prepare database URLs, CA, and signing key.**

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
    authority = role + ':' + password + '@oce-postgres-primary.openclaw-postgres.svc:5432'
    url = 'postgresql://' + authority + '/openclaw_enterprise?sslmode=verify-full&sslrootcert=/etc/openclaw/database-ca/ca.pem'
    (root / output_file).write_text(url)
PY

(
  set -eC
  openssl rand -hex 32 > "$OCC_INPUT_DIRECTORY/occ-auth-secret"
)
```

## Prepare cluster-specific inputs and policy

For the IPv4, two-worker profile used here, run the
preparation helper.
**You do not need to copy or fill in the production YAML examples manually.**
The helper creates private copies and fills in the cluster-specific fields.

Use the current kubeconfig context. The workers must already have the
`oce-role=control` and `oce-role=agent` labels assigned during cluster preparation.
Wait for both image builds to complete, then set the inputs and generate the files.
Use your existing private directory and chosen admin email if they differ below.
The block reads the saved Route hostname and resolves the image digests from the
builds. On a repeat build, replace `oce-controller-1` and `oce-runtime-1` with the
completed build names shown by `oc -n openclaw-system get builds`.

**Set inputs and prepare private YAML.**

```bash
export OCC_INPUT_DIRECTORY="${OCC_INPUT_DIRECTORY:-$HOME/.local/state/openclaw-enterprise/openshift-test}"

export OCC_CONSOLE_HOST="$(yq -r '.spec.host' \
  "$OCC_INPUT_DIRECTORY/console-route.yaml")"

export OCC_ADMIN_EMAIL="${OCC_ADMIN_EMAIL:-occ-admin@example.test}"

export CONTROLLER_IMAGE="$(oc -n openclaw-system get imagestreamtag \
  "$(oc -n openclaw-system get build oce-controller-1 \
    -o jsonpath='{.spec.output.to.name}')" \
  -o jsonpath='{.image.dockerImageReference}')"

export RUNTIME_IMAGE="$(oc -n openclaw-system get imagestreamtag \
  "$(oc -n openclaw-system get build oce-runtime-1 \
    -o jsonpath='{.spec.output.to.name}')" \
  -o jsonpath='{.image.dockerImageReference}')"

deploy/examples/openshift-test/prepare-inputs
```

Expect “Prepared private Helm, Installation, bootstrap PVC, and egress policy
inputs.” The helper writes `values.yaml`, `installation.yaml`,
`bootstrap-pvc.yaml`, `control-plane-postgres-egress.yaml`, and
`control-plane-kube-api-egress.yaml` under `OCC_INPUT_DIRECTORY`. It updates its
owned fields in existing copies, leaves other fields intact, and does not apply
resources or read credentials or Secrets.

The helper requires `oc`, `jq`, and `yq` v4. It discovers the exact PostgreSQL
primary, all Kubernetes API EndpointSlice addresses and TCP ports, and default
router Pod addresses. It keeps Gateway routing disabled for the initial OCC
trial, assigns control and Agent placement, and uses `gp3-csi`. Its selectors
expect the default OpenShift DNS and ingress deployments; verify them before
applying. The `null` DNS label removes the chart's `k8s-app=kube-dns` default
when merging Helm values.

No additional YAML values need filling in for this profile. If your cluster uses
a different storage class, update `bootstrap-pvc.yaml` at
`spec.storageClassName` and `installation.yaml` at
`drivers.compute.configuration.runtime.gatewayStorageClassName` after running
the helper. Different DNS, ingress, or placement labels require matching edits
in the generated values and Installation; use the
[manual examples](../production-installation.md#advanced-copy-manual-yaml-examples)
for clusters outside this profile.

Review the prepared inputs locally. Expect actual IPv4 `/32` endpoints and the
API's translated TCP port, often `6443`. The Helm chart permits DNS on ports
`53` and `5353`. Router CIDRs describe current Pods; refresh the inputs if they
change. Apply the reviewed policies:

**Apply control-plane egress policies.**

```bash
oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-postgres-egress.yaml"

oc apply -f "$OCC_INPUT_DIRECTORY/control-plane-kube-api-egress.yaml"
```

Apply the fixed UID SCC and its exact control-plane grant. Create the bootstrap claim. The preparation helper needs a temporary narrow SCC to set the fresh volume root to UID/GID 1000 and mode 0700; delete that grant immediately after the helper succeeds.

**Prepare the bootstrap PVC and remove temporary grants.**

```bash
oc apply -f deploy/examples/openshift-test/base/admission/fixed-uid-scc.yaml

oc apply -f deploy/examples/openshift-test/base/admission/control-plane-scc-rbac.yaml

oc -n openclaw-system apply -f "$OCC_INPUT_DIRECTORY/bootstrap-pvc.yaml"

oc apply -f deploy/examples/openshift-test/bootstrap-prep-scc.yaml

scripts/prepare-bootstrap-volume --kubeconfig "$KUBECONFIG_FILE" \
  --namespace openclaw-system \
  --claim occ-bootstrap-admin-password --image "$CONTROLLER_IMAGE" \
  --node-selector oce-role=control

oc -n openclaw-system delete rolebinding oce-bootstrap-volume-prep

oc -n openclaw-system delete role oce-bootstrap-volume-prep

oc delete scc oce-bootstrap-volume-prep
```

## Add the OpenShell workspace configuration

After installing the OpenShell gateway, render its pinned workspace chart. Its four resources become namespace-agnostic Installation input; OCC creates them in each OpenShell workspace. The values file sets the gateway Pod selector and its ServiceAccount explicitly.

**Prepare Codex workspace configuration only.**

```bash
export OPEN_SHELL_CHART="$OCC_INPUT_DIRECTORY/openshell-charts/openshell-workspace-0.1.3.tgz"

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

export OPENSHELL_SERVICE_IP="$(oc -n openshell-system get service openshell-gateway \
  -o jsonpath='{.spec.clusterIP}')"

yq -i '.drivers.compute.configuration.network.providerHarness.address = strenv(OPENSHELL_SERVICE_IP) |
  .drivers.sandbox.configuration.gateway.operatorWorkspaceResources = load(strenv(OPEN_SHELL_WORKSPACE_RESOURCES))' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"

yq -e '.drivers.sandbox.configuration.gateway.operatorWorkspaceResources | length == 4' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
```

Check the Agent nodes and apply the shared resources:

**Apply the shared resources.**

```bash
for node in $(oc get nodes -l oce-role=agent -o name); do
  oc debug "$node" -- chroot /host crun --version
done

oc apply -f deploy/examples/openshift-test/base/openshell/openshell-runtimeclass.yaml

oc apply -f deploy/examples/openshift-test/base/openshell/openshell-workspace-writer-clusterrole.yaml

node --input-type=module -e '
  import { loadInstallationConfiguration } from "./apps/controller/src/composition/installation-config.ts";
  await loadInstallationConfiguration({ mode: "production", environment: { OCC_CONFIG_PATH: process.argv[1] } });
  console.log("Installation configuration valid");
' "$OCC_INPUT_DIRECTORY/installation.yaml"
```

The loader check uses this checkout's installed workspace dependencies. The ClusterRole is bound to the worker only in the discovered tenant namespace below. This step does not start an Agent.

The default OpenShell filesystem policy allows the installed runtime and
approved workspace mounts. Keep the default baseline rather than replacing it
with the old `/app`-only policy.

## Create system Secrets and install OCC

Create these four system Secrets from the private files prepared above. Run this
once before the first OCC install; these operator-owned Secrets are not updated
automatically by Helm.

**Create system Secrets.**

```bash
oc -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml"

oc -n openclaw-system create secret generic occ-database \
  --from-file=application-url="$OCC_INPUT_DIRECTORY/occ-application-url" \
  --from-file=migration-url="$OCC_INPUT_DIRECTORY/occ-migration-url"

oc -n openclaw-system create secret generic occ-database-ca \
  --from-file=ca.pem="$OCC_INPUT_DIRECTORY/occ-database-ca.pem"

oc -n openclaw-system create secret generic occ-auth \
  --from-file=secret="$OCC_INPUT_DIRECTORY/occ-auth-secret"
```

Render the chart and use a server-side dry run before installing:

**Render and install OCC.**

```bash
yq -i '.worker.maxAttempts = 30 | .worker.leaseDurationMs = 30000' \
  "$OCC_INPUT_DIRECTORY/values.yaml"

helm template oce deploy/helm/openclaw-enterprise --namespace openclaw-system \
  -f "$OCC_INPUT_DIRECTORY/values.yaml" > "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"

oc -n openclaw-system apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/oce-rendered.yaml"

helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 7m

export OCC_NAMESPACE="$(oc get namespaces -l openclaw.dev/namespace -o json |
  jq -er '.items | if length == 1 then .[0].metadata.labels["openclaw.dev/namespace"]
    else error("Select the intended bootstrap Namespace ID explicitly") end')"

deploy/examples/openshift-test/grant-tenant-access

oc -n openclaw-system get jobs,deployments,pods
```

The test-cluster worker settings allow the Gateway to become ready during the
first Agent reconciliation and keep the claim alive during OpenShell Sandbox
preparation.

## Verify tenant permissions

Run the install block through `grant-tenant-access` without pausing. Bootstrap
queues Namespace provisioning immediately; waiting longer than its 15-minute
convergence deadline marks it `failed`. The helper waits for the exact backing
namespace, verifies its ownership markers, and applies the five tenant-local
worker/API grants, including the named OpenShell workspace Role's `bind` and
`escalate` permissions. No grants apply to other tenant namespaces.

Expect the initialization Job to complete, both Deployments to reach `1/1`, and
the worker to report `NAMESPACE_RECONCILED`. If the Namespace has already failed,
inspect worker logs before recovery. There is no Namespace retry endpoint;
delete an empty failed Namespace and create a new name with its grants applied
immediately. Deleted names remain reserved.

## Install the Console Route

Use the private Route prepared during cluster setup. Confirm its hostname still matches `$OCC_CONSOLE_HOST`, then apply it. Verify that its `Admitted` condition is `True`, that `https://$OCC_CONSOLE_HOST/healthz` returns 200 with valid TLS, and that `/console/login` returns HTML. Retrieve the initial admin password or service key only through your approved protected-storage procedure before testing authenticated operations. API health and the login page do not prove authentication or Agent execution.

**Apply and verify the Console Route.**

```bash
test -s "$OCC_INPUT_DIRECTORY/console-route.yaml"

yq -e '.spec.host == strenv(OCC_CONSOLE_HOST)' \
  "$OCC_INPUT_DIRECTORY/console-route.yaml" >/dev/null

oc apply -f "$OCC_INPUT_DIRECTORY/console-route.yaml"

oc -n openclaw-system get route openclaw-enterprise-console

curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/healthz" >/dev/null

curl --fail --silent --show-error "https://$OCC_CONSOLE_HOST/console/login" >/dev/null
```

Retrieve the bootstrap key and password from the protected claim through a short-lived, read-only Pod. Keep both files private. The image must match the installed controller digest. Delete the Pod as soon as the files are copied:

**Retrieve bootstrap credentials and authenticate.**

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

Expect the Installation ID to match `meta.installationId` in the protected service-key response and the default Namespace to report `ready`. Open `https://$OCC_CONSOLE_HOST/console/login` in a browser and sign in with the configured `bootstrap.adminEmail` and the password in `initial-admin-password`.

## Configure routing and create the Agent

After OCC is installed and the default Namespace is `ready`:

1. [Enable private Agent routing](openshift-test-routing.md).
2. [Prepare the dedicated Codex Agent](openshift-test-agent.md) using
   `codex-luna-configuration.json`. Follow credential registration,
   Agent creation, credential grant, image-pull, and Gateway SCC steps. Register
   the API key through the credential procedure, not in the Configuration JSON.
3. [Enable the Control UI Route](openshift-test-control-ui.md) and test a model turn.
