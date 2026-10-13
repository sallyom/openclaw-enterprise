# OpenShift test deployment

Start with the [deployment guide](../../../docs/guides/deploy/openshift/README.md).
Use dedicated Codex through OpenShell and verify the target
cluster's storage, runtime, Operators, and networking.

The supporting Kubernetes resources use checked-in Kustomize files:

```text
base/                         Resource manifests grouped by deployment stage
base/kustomization.yaml        All base resources for inspection
  operators/, database/, admission/, openshell/, control-plane/, routing/
  control-ui/, control-ui-access/
overlays/test/                 Test profile, with a Kustomization for each stage
prepare-kustomize              Prepare private overlays with deployment overrides
verify-images                 Verify built image architectures and save digest references
grant-tenant-access           Wait for a tenant and apply its exact worker/API grants
```

Render the complete example to inspect its resources:

```bash
oc kustomize deploy/examples/openshift-test/overlays/test
```

Deploy individual stages in the [Kustomize guide](../../../docs/guides/deploy/openshift/openshift-test-kustomize.md)
order, with readiness checks between dependencies. Example hostnames, network
addresses, and `${VARIABLE}` values need private deployment overrides before
application. Credentials and generated overlays stay outside this checkout.

Helm values, Installation fragments, and image-build templates remain alongside
these directories. Helm still manages OCC, OpenShell, and Envoy; the owning
guides cover builds, database initialization, credentials, and readiness waits.
