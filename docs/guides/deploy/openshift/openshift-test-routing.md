# Enable private Agent routing on the OpenShift test cluster

Run this after the [OCC test installation](openshift-test-install.md) and before
deploying a dedicated Agent. Use its protected input directory and selected
`KUBECONFIG`. Dedicated Codex storage requires private Envoy routing and node
enrollment; OCC rejects the revision while routing is disabled.

## Install Envoy Gateway

Check the OpenShift-managed Gateway API bundle before selecting Envoy Gateway:

```bash
oc get crd gateways.gateway.networking.k8s.io \
  -o go-template='{{ index .metadata.annotations "gateway.networking.k8s.io/bundle-version" }}{{ "\n" }}'
oc version -o json | jq -r '.serverVersion.gitVersion'
```

OpenShift 4.22 in this trial supplied Gateway API v1.4.1 on Kubernetes 1.35.
[Envoy Gateway's compatibility matrix](https://gateway.envoyproxy.io/news/releases/matrix/)
matches that bundle to v1.7, so use the pinned v1.7.5 chart here. It is an
older release; select a currently supported compatible pair for a longer-lived
cluster. Leave OpenShift's Gateway API CRDs under its own management. Install
only Envoy's CRDs and grant the exact controller identities the `nonroot-v2`
SCC before the Helm hooks run:

```bash
oc create namespace envoy-gateway-system --dry-run=client -o yaml | oc apply -f -
oc apply -f deploy/examples/openshift-test/envoy-controller-scc-rbac.yaml
helm template eg-crds oci://docker.io/envoyproxy/gateway-crds-helm \
  --version v1.7.5 --set crds.gatewayAPI.enabled=false \
  --set crds.envoyGateway.enabled=true \
  > "$OCC_INPUT_DIRECTORY/envoy-gateway-crds.yaml"
oc apply --server-side -f "$OCC_INPUT_DIRECTORY/envoy-gateway-crds.yaml"
helm upgrade --install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.7.5 -n envoy-gateway-system --skip-crds --wait --timeout 7m
oc apply -f deploy/examples/openshift-test/envoy-gateway-class.yaml
oc get gatewayclass eg
```

Expect the GatewayClass `Accepted` condition to be `True`.

## Enable OCC routing

Create a private service key with no trailing newline. Keep it separate from
the OCC signing key and model credential:

```bash
test -e "$OCC_INPUT_DIRECTORY/gateway-api-key" || \
  (umask 077; python3 -c 'import secrets; print(secrets.token_hex(32), end="")' \
    > "$OCC_INPUT_DIRECTORY/gateway-api-key")
oc -n openclaw-system create secret generic occ-private-gateway-key \
  --from-file=occ="$OCC_INPUT_DIRECTORY/gateway-api-key"
```

In the protected `values.yaml`, set `gatewayRouting.enabled: true`,
`gatewayClassName: eg`, and `apiKeySecretName: occ-private-gateway-key`.
Set `dns.namespace: openshift-dns` and
`dns.podLabels.dns.operator.openshift.io/daemonset-dns: default` as observed.
Keep `dns.podLabels.k8s-app: null` from the OCC installation so Helm removes
its default `k8s-app=kube-dns` selector.
The chart uses these selectors for Envoy DNS egress on UDP/TCP ports `53` and
`5353`.
Use the full cluster DNS name for the private Gateway. OpenShell's policy DNS
resolver queries names exactly and cannot resolve the short `.svc` name:

```bash
export CLUSTER_DNS_DOMAIN="$(oc -n openclaw-system exec deployment/openclaw-enterprise-api -- cat /etc/resolv.conf |
  awk '/^search / { for (i = 2; i <= NF; i++) if ($i ~ /^svc[.]/) { sub(/^svc[.]/, "", $i); print $i; exit } }')"
test -n "$CLUSTER_DNS_DOMAIN"
export ENVOY_SERVICE="occ-gateway-$(printf '%s' 'openclaw-system/oce-agent-gateways' |
  shasum -a 256 | cut -c1-12)"
export PRIVATE_GATEWAY_HOST="$ENVOY_SERVICE.envoy-gateway-system.svc.$CLUSTER_DNS_DOMAIN"
yq -i '.gatewayRouting.enabled = true |
  .gatewayRouting.gatewayClassName = "eg" |
  .gatewayRouting.apiKeySecretName = "occ-private-gateway-key" |
  .gatewayRouting.hostname = strenv(PRIVATE_GATEWAY_HOST)' \
  "$OCC_INPUT_DIRECTORY/values.yaml"
```

Apply the Helm upgrade, then grant `nonroot-v2` only to its generated Envoy
data-plane ServiceAccount:

```bash
helm upgrade --install oce deploy/helm/openclaw-enterprise \
  --namespace openclaw-system -f "$OCC_INPUT_DIRECTORY/values.yaml" \
  --wait --timeout 7m
export ENVOY_DEPLOY="$(oc -n envoy-gateway-system get deployments \
  -l gateway.envoyproxy.io/owning-gateway-namespace=openclaw-system,gateway.envoyproxy.io/owning-gateway-name=oce-agent-gateways \
  -o jsonpath='{.items[0].metadata.name}')"
test -n "$ENVOY_DEPLOY"
export ENVOY_SA="$(oc -n envoy-gateway-system get deployment "$ENVOY_DEPLOY" \
  -o jsonpath='{.spec.template.spec.serviceAccountName}')"
oc -n envoy-gateway-system create rolebinding eg-private-dataplane-nonroot \
  --role=eg-nonroot-v2 --serviceaccount="envoy-gateway-system:$ENVOY_SA"
oc -n envoy-gateway-system rollout status deployment/"$ENVOY_DEPLOY" --timeout=3m
oc -n envoy-gateway-system get service "$ENVOY_SERVICE"
oc -n openclaw-system get gateway oce-agent-gateways
```

Expect the data plane `Ready` and Gateway `Programmed=True`.

In the protected `installation.yaml`, add Compute `gatewayRouting` with
`gatewayName: oce-agent-gateways`, `gatewayNamespace: openclaw-system`, and
`envoyNamespace: envoy-gateway-system`. Set its `hostname` to
`$PRIVATE_GATEWAY_HOST`, matching Helm's Gateway certificate. Remove
`drivers.compute.configuration.network.gatewayClients`. Set
`gatewayTrustedProxyCidrs` to the observed OpenShift Pod network CIDR; the
NetworkPolicy also limits ingress to the exact Envoy Pods. Update the startup
Secret, validate the Installation, and restart the API and worker as in
[production routing setup](../workspace-routing.md#configure-private-routing).
For the cluster inspected at the start of this trial, use its recorded Pod CIDR:

```bash
export POD_NETWORK_CIDR="$(oc get network.config.openshift.io cluster \
  -o jsonpath='{.spec.clusterNetwork[0].cidr}')"
test -n "$POD_NETWORK_CIDR"
yq -i '.drivers.compute.configuration.gatewayRouting = {
  "gatewayName":"oce-agent-gateways","gatewayNamespace":"openclaw-system",
  "envoyNamespace":"envoy-gateway-system","hostname":strenv(PRIVATE_GATEWAY_HOST)} |
  del(.drivers.compute.configuration.network.gatewayClients) |
  .drivers.compute.configuration.network.gatewayTrustedProxyCidrs = [strenv(POD_NETWORK_CIDR)]' \
  "$OCC_INPUT_DIRECTORY/installation.yaml"
node --input-type=module -e '
  import { loadInstallationConfiguration } from "./apps/controller/src/composition/installation-config.ts";
  await loadInstallationConfiguration({ mode: "production", environment: {
    OCC_CONFIG_PATH: process.argv[1] } });
  console.log("Installation configuration valid");
' "$OCC_INPUT_DIRECTORY/installation.yaml"
oc -n openclaw-system create secret generic occ-installation-startup \
  --from-file=installation.yaml="$OCC_INPUT_DIRECTORY/installation.yaml" \
  --dry-run=client -o yaml | oc apply -f -
oc -n openclaw-system rollout restart \
  deployment/openclaw-enterprise-api deployment/openclaw-enterprise-worker
oc -n openclaw-system rollout status deployment/openclaw-enterprise-api --timeout=4m
oc -n openclaw-system rollout status deployment/openclaw-enterprise-worker --timeout=4m
```

For an already ready default Namespace, follow
[the existing-Namespace attachment](../workspace-routing.md#enable-routing-for-existing-namespaces-and-agents)
to replace its direct API ingress peer and add the Gateway attachment label.
Attach the Gateway runtime namespace here; the OpenShell Agent procedure also
attaches the tenant namespace for supervisor egress. Confirm the OCC API,
worker, and Gateway remain ready, then
[prepare the first OpenShell Agent](openshift-test-agent.md).
