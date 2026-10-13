# Open the test Agent Control UI through OpenShift OAuth

Complete this required recipe step after the Agent deployment succeeds, for
dedicated Codex. The
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

**Discover images, hostname, and Service access.**

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

**Create the OAuth cookie Secret.**

```bash
test -e "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" ||
  (umask 077; openssl rand -hex 16 > "$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie")

oc -n "$GATEWAY_NAMESPACE" create secret generic \
  oce-agent-control-ui-oauth-cookie \
  --from-file=session_secret="$OCC_INPUT_DIRECTORY/control-ui-oauth-cookie" \
  --dry-run=client -o yaml | oc apply -f -
```

Discover DNS addresses and render the proxy inputs.

**Render proxy inputs.**

```bash
export DNS_CIDR_0="$(oc -n openshift-dns get svc dns-default \
  -o jsonpath='{.spec.clusterIP}')/32"
oc -n openshift-dns get pods \
  -l dns.operator.openshift.io/daemonset-dns=default -o json | \
  jq -e '[.items[].status.podIP] | unique |
    if length > 0 and all(type == "string" and (contains(":") | not))
    then map({ipBlock:{cidr:(. + "/32")}})
    else error("expected IPv4 DNS Pod addresses") end' \
  > "$OCC_INPUT_DIRECTORY/dns-peers.json"

export DNS_PEERS_FILE="$OCC_INPUT_DIRECTORY/dns-peers.json"

envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_SERVICE} ${OAUTH_PROXY_IMAGE} ${CONTROL_UI_ENVOY_IMAGE} ${OAUTH_SAR} ${CONTROL_UI_HOST} ${DNS_CIDR_0}' \
  < deploy/examples/openshift-test/base/control-ui/control-ui-oauth-proxy.yaml \
  > "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"

yq -i '(select(.kind == "NetworkPolicy").spec.egress[] |
  select(.ports[].port == 53).to) += load(strenv(DNS_PEERS_FILE))' \
  "$OCC_INPUT_DIRECTORY/control-ui-oauth-proxy.yaml"
```

Apply the proxy inputs and wait for the Route.

**Apply and verify the OAuth Route.**

```bash
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
route. The manifest
uses OpenShift's ServiceAccount redirect annotation and an edge TLS Route. Its
identity proxy listens only on Pod loopback, between OAuth and the Gateway.

## Grant access to a non-admin OpenShift user

Skip this section for an admin-only trial; continue to **Allow the Route origin
and deploy**. To grant a non-admin user access, run the block below.

An administrator creates the Agent and proxy. Its user needs an existing
OpenShift login and `get` permission on this exact Gateway Service; they need
no cluster-admin role, Pod creation, or Secret access. This is separate from
OCE permissions. The proxy maps every authorized login to native
`operator.admin` authority on this one Agent.

Use the per-Agent access grant
with the intended person's OpenShift username, as reported by `oc whoami`.
The grant does not create an account or change cluster OAuth:

**Grant access to the selected non-admin user.**

```bash
# REQUIRED: replace the placeholder with the value described above.
export CONTROL_UI_USER='<existing OpenShift username>'

envsubst '${GATEWAY_NAMESPACE} ${GATEWAY_SERVICE} ${CONTROL_UI_USER}' \
  < deploy/examples/openshift-test/base/control-ui-access/control-ui-user-rbac.yaml \
  > "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"

oc apply --dry-run=server \
  -f "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"

oc apply -f "$OCC_INPUT_DIRECTORY/control-ui-access.yaml"

oc auth can-i get "service/$GATEWAY_SERVICE" \
  -n "$GATEWAY_NAMESPACE" --as="$CONTROL_UI_USER" \
  --as-group=system:authenticated --as-group=system:authenticated:oauth
```

Expect `yes`. Also check that this identity cannot read another Agent's Service,
read Secrets, or create Pods in the Gateway namespace. Existing independent
RoleBindings can give broader access; this grant does not remove them.
Administrators can use impersonation for these checks, but it does not prove
that the person can authenticate. Complete a separate browser login and model
turn as that person before claiming non-admin access works end to end.

To revoke this grant later, run:

```bash
oc -n "$GATEWAY_NAMESPACE" delete rolebinding "$GATEWAY_SERVICE-control-ui-user"
```

Keep the Role for a replacement user, or delete it when no grant needs it.

## Allow the Route origin and deploy

Add the exact HTTPS origin returned by the Route and trusted-proxy device
approval to the existing Configuration. Keep its model and Harness settings.
Updating the Configuration does not change a running revision; deploy a new
immutable revision afterward.

**Update the Configuration and deploy.**

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

Record the revision ID returned by `deploy`, then check its status:

**Verify the new revision.**

```bash
# REQUIRED: replace the placeholder with the value described above.
export DEPLOYMENT_ID='<revision ID returned by deploy>'

bin/occ agent deployment-status "$AGENT_ID" "$DEPLOYMENT_ID"

bin/occ agent get "$AGENT_ID"
```

Wait for `succeeded` and confirm `activeRevisionId` matches that revision before
using the Route. A Ready OAuth proxy or Gateway Pod alone does not prove an Agent revision
has deployed.

## Sign in to OpenClaw

Print the URL, open it in your browser, and complete OpenShift OAuth login:

**Print the browser URL.**

```bash
printf '%s\n' "$CONTROL_UI_ORIGIN"
```

Retrieve both URLs with:

```bash
oc -n openclaw-system get route openclaw-enterprise-console \
  -o jsonpath='https://{.spec.host}/console/login{"\n"}'

oc -n "$GATEWAY_NAMESPACE" get route oce-agent-control-ui-oauth \
  -o jsonpath='https://{.spec.host}{"\n"}'
```

Sign in to OCC with `OCC_ADMIN_EMAIL` and the password saved in
`$OCC_INPUT_DIRECTORY/initial-admin-password`. Read it in your own terminal when
needed; do not paste it into chat:

```bash
cat "$OCC_INPUT_DIRECTORY/initial-admin-password"
```

The OpenClaw Control UI uses your existing OpenShift OAuth login. It has no
separate application password to retrieve. The Control UI should connect
through the trusted proxy without a Gateway password. Stop if the browser cannot authenticate or the Agent revision is not
active; inspect deployment status and proxy logs before changing Gateway
authentication.

## Verify a real Codex model turn

Verify a completed Codex response through its authenticated app-server.

Send a short request in the Agent Control UI and wait for its answer. Require a
completed assistant response: an authenticated browser session or initialized
WebSocket alone does not prove the selected Harness reached the model through the
OpenShell route with the selected Harness.
