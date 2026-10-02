# Open the test Agent Control UI through OpenShift OAuth

Use this after [preparing the OpenShell Agent](openshift-test-agent.md). The
OpenShift OAuth proxy protects a public Route to this one Agent Gateway. After
OAuth checks permission to read the exact Gateway Service, a loopback Envoy
proxy strips browser credentials and supplies the Gateway's trusted identity.
That identity has native `operator.admin` access. Restrict the Service permission
to the intended operators; a generic authenticated OpenShift user must be denied.
OpenShift login does not grant OCE Agent permissions.

Run from the repository root with the test cluster's `KUBECONFIG`, `OCC_URL`,
`OCC_SERVICE_KEY_FILE`, `OCC_NAMESPACE`, `OCC_INPUT_DIRECTORY`, `AGENT_ID`,
`AGENT_SA`, `CONFIGURATION_ID`, and `GATEWAY_NAMESPACE` from the Agent guide.
Confirm the active `oc` context before applying resources. This setup serves
one Agent per proxy Deployment.

## Create the OAuth Route

Use the cluster's OpenShift OAuth proxy ImageStream. This test cluster supplied
`oauth-proxy:v4.4`; check the available tag on a new cluster. The Route needs a
short explicit host because the generated hostname can exceed OpenShift's DNS
label limit when the Gateway namespace is long.

```bash
oc -n openshift get imagestream oauth-proxy
export GATEWAY_SERVICE="gateway-${AGENT_SA#agent-}"
export OAUTH_PROXY_IMAGE="$(oc -n openshift get imagestreamtag oauth-proxy:v4.4 \
  -o jsonpath='{.image.dockerImageReference}')"
export CONTROL_UI_ENVOY_IMAGE="$(oc -n envoy-gateway-system get deployments \
  -o json | jq -er '[.items[].spec.template.spec.containers[] |
    select(.name == "envoy") | .image] |
    if length == 1 then .[0] else error("expected one Envoy data plane image") end')"
export CONTROL_UI_HOST="oc-ui-${AGENT_SA#agent-}.$(oc get \
  ingresses.config.openshift.io cluster -o jsonpath='{.spec.domain}')"
export OAUTH_SAR="$(jq -nc --arg namespace "$GATEWAY_NAMESPACE" \
  --arg service "$GATEWAY_SERVICE" \
  '{namespace:$namespace,resource:"services",resourceName:$service,verb:"get"}')"
test -n "$OAUTH_PROXY_IMAGE" && test -n "$CONTROL_UI_ENVOY_IMAGE" &&
  test -n "$CONTROL_UI_HOST"
oc auth can-i get "service/$GATEWAY_SERVICE" -n "$GATEWAY_NAMESPACE"
```

The permission check must return `yes` for each person who opens the Route.
Grant access to that exact Service through OpenShift RBAC when needed. The proxy
does not grant access to every OpenShift user.

Keep the OAuth cookie secret outside the checkout. Preserve it across proxy
rollouts so existing sessions remain valid:

```bash
test -e "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" ||
  (umask 077; openssl rand -hex 16 > "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie")
oc -n "$GATEWAY_NAMESPACE" create secret generic \
  oce-agent-control-ui-oauth-cookie \
  --from-file=session_secret="$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" \
  --dry-run=client -o yaml | oc apply -f -
export DNS_CIDR_0="$(oc -n openshift-dns get svc dns-default \
  -o jsonpath='{.spec.clusterIP}')/32"
DNS_PODS="$(oc -n openshift-dns get pods \
  -l dns.operator.openshift.io/daemonset-dns=default \
  -o json)"
test "$(printf '%s' "$DNS_PODS" | jq '.items | length')" -eq 2
export DNS_CIDR_1="$(printf '%s' "$DNS_PODS" | jq -r '.items[0].status.podIP')/32"
export DNS_CIDR_2="$(printf '%s' "$DNS_PODS" | jq -r '.items[1].status.podIP')/32"
envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_SERVICE} ${OAUTH_PROXY_IMAGE} ${CONTROL_UI_ENVOY_IMAGE} ${OAUTH_SAR} ${CONTROL_UI_HOST} ${DNS_CIDR_0} ${DNS_CIDR_1} ${DNS_CIDR_2}' \
  < deploy/examples/openshift-test/control-ui-oauth-proxy.yaml \
  > "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
oc apply --dry-run=server -f "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
oc apply -f "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
oc -n "$GATEWAY_NAMESPACE" rollout status \
  deployment/oce-agent-control-ui-oauth --timeout=3m
oc -n "$GATEWAY_NAMESPACE" get route oce-agent-control-ui-oauth \
  -o jsonpath='{.spec.host}{"\n"}{.status.ingress[0].conditions[?(@.type=="Admitted")].status}{"\n"}'
```

Expect the selected host and `True`. The proxy's egress policy allows its
OpenShift OAuth and API connections on TCP 443 and 6443; its Gateway connection
is limited to this Agent Service on TCP 8080. DNS uses the discovered Service
and Pod addresses; refresh them when DNS Pods change. The Gateway ingress rule
allows only the proxy Pod to reach that port in addition to OCC's private Envoy
route. The [manifest](../../../../deploy/examples/openshift-test/control-ui-oauth-proxy.yaml)
uses OpenShift's ServiceAccount redirect annotation and an edge TLS Route. Its
identity proxy listens only on Pod loopback, between OAuth and the Gateway.

## Allow the Route origin and deploy

Add the exact HTTPS origin returned by the Route and trusted-proxy device
approval to the existing Configuration. Keep its model and Harness settings.
Updating the Configuration does not change a running revision; deploy a new
immutable revision afterward.

```bash
export CONTROL_UI_ORIGIN="https://$(oc -n "$GATEWAY_NAMESPACE" get route \
  oce-agent-control-ui-oauth -o jsonpath='{.spec.host}')"
bin/occ configuration get "$CONFIGURATION_ID" -o json |
  jq --arg origin "$CONTROL_UI_ORIGIN" \
    '{values:(.values | .gateway.controlUi.enabled = true |
      .gateway.controlUi.allowedOrigins =
        ((.gateway.controlUi.allowedOrigins // []) + [$origin] | unique) |
      .gateway.auth.trustedProxy.deviceAutoApprove =
        {enabled:true,scopes:["operator.admin"]})}' \
    > "$OCC_INPUT_DIRECTORY/control-ui-configuration.json"
bin/occ configuration update "$CONFIGURATION_ID" \
  --file "$OCC_INPUT_DIRECTORY/control-ui-configuration.json"
bin/occ agent deploy "$AGENT_ID"
```

Record the new revision ID from `deploy` as `DEPLOYMENT_ID`. Check
`bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"` until it reports
`succeeded`; confirm the Agent's `activeRevisionId` matches before using the
Route. A Ready OAuth proxy or Gateway Pod alone does not prove an Agent revision
has deployed.

## Sign in to OpenClaw

Open `"$CONTROL_UI_ORIGIN"` in a browser and complete OpenShift OAuth login.
The Control UI should connect through the trusted proxy without a Gateway
password. Stop if the browser cannot authenticate or the Agent revision is not
active; inspect deployment status and proxy logs before changing Gateway
authentication.

## Verify a real Codex model turn

Send a short request in the Agent Control UI and wait for its answer. Require a
completed assistant response: an authenticated browser session or initialized
WebSocket alone does not prove that Codex reached the model through the
OpenShell route and authenticated Unix-socket relay.
