import { sha256Hex } from "@openclaw-enterprise/utils";
import { KubernetesObjectApi, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import { setTimeout as delay } from "node:timers/promises";
import type {
  HarnessWorkloadRequirements,
  SandboxEnvironmentVariable,
  SandboxHarnessContext,
  SandboxNamespaceContext,
} from "@openclaw-enterprise/contracts";
import { RUNTIME_WRAPPER_COMMAND } from "../compute/kubernetes/runtime-entrypoints.ts";
import { nodeProgramArguments } from "../compute/node-program.ts";

// TODO(OpenShell native workload projections): remove this test-cluster bridge when OpenShell
// accepts SecretKeyRefs, projected ServiceAccount tokens, and plugin-runtime ConfigMaps.
const credentialMountPath = "/run/enterprise-credentials";
const pluginRuntimeMountPath = "/etc/openclaw/plugin-runtime";
const workspaceMountPath = "/home/node/workspace";
const nodeStateMountPath = "/home/node/.openclaw-node";
const bridgedNodeStateMountPath = "/openclaw-node-state";
const bridgedWorkspaceSubPath = "workspace/openshell-home";
const portableArgumentBytes = 30 * 1024;

function fail(message: string): never {
  throw new Error(`OpenShell test credential bridge: ${message}`);
}

function jobName(revisionId: string): string {
  return `openshell-cred-${sha256Hex(revisionId, 12)}`;
}

function credentialSubPath(revisionId: string): string {
  return `.openclaw/openshell-bootstrap/${sha256Hex(revisionId, 32)}`;
}

function nodeStateParent(agentId: string): string {
  return `.openclaw/openshell-bootstrap/nodes/${sha256Hex(agentId, 32)}`;
}

function secretEnvironment(
  requirements: HarnessWorkloadRequirements,
  name: string,
): Extract<SandboxEnvironmentVariable, { readonly valueFrom: unknown }> | undefined {
  const entry = requirements.environment.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    return undefined;
  }
  if (!("valueFrom" in entry) || entry.valueFrom.secretKeyRef === undefined) {
    fail(`${name} must have one exact SecretKeyRef.`);
  }
  return entry as Extract<SandboxEnvironmentVariable, { readonly valueFrom: unknown }>;
}

function literalEnvironment(requirements: HarnessWorkloadRequirements, name: string): string {
  const entry = requirements.environment.find((candidate) => candidate.name === name);
  if (entry === undefined || !("value" in entry)) {
    fail(`${name} must have a literal value.`);
  }
  return (entry as { value: string }).value;
}

function claimName(requirements: HarnessWorkloadRequirements): string {
  const claims = new Set(requirements.workspaceMounts.map((mount) => mount.claimName));
  if (claims.size !== 1) {
    fail("the Harness must use exactly one workspace PVC.");
  }
  return [...claims][0]!;
}

function pluginRuntimeConfigMapName(context: SandboxHarnessContext): string {
  return `plugin-runtime-${sha256Hex(context.revision.agentId, 12)}-rev-${sha256Hex(context.revision.id, 12)}`;
}

function bootstrapJob(context: SandboxHarnessContext, runAsUser: number): KubernetesObject {
  const requirements = context.requirements;
  const token = requirements.serviceAccountToken;
  if (token.path !== "token" || token.readOnly !== true) {
    fail("the approved ServicePrincipal token projection changed.");
  }
  const appServerToken = secretEnvironment(requirements, "APP_SERVER_TOKEN");
  const nodeSetupCode = secretEnvironment(requirements, "OPENCLAW_NODE_SETUP_CODE");
  if (appServerToken === undefined || nodeSetupCode === undefined) {
    fail("the app server and node setup Secrets are required.");
  }
  const nodeCa = literalEnvironment(requirements, "OPENCLAW_NODE_CA_PEM");
  const subPath = credentialSubPath(context.revision.id);
  const script = [
    "umask 077",
    "mkdir -p /bootstrap/plugin-runtime /bootstrap/runtime-assets /bootstrap/openclaw-home",
    "mkdir -p /bootstrap/service-principal /workspace-home/openshell-home/.codex",
    "mkdir -p /agent-node-state/node-state",
    "chmod 0700 /bootstrap/plugin-runtime /bootstrap/service-principal /agent-node-state/node-state",
    'printf "%s" "$APP_SERVER_TOKEN" > /bootstrap/app-server-token',
    'printf "%s" "$OPENCLAW_NODE_SETUP_CODE" > /bootstrap/openclaw-node-setup-code',
    'printf "%s" "$OPENCLAW_NODE_CA_PEM" > /bootstrap/openclaw-node-ca.pem',
    "cp /source-plugin-runtime/runtime.json /bootstrap/plugin-runtime/runtime.json",
    "cp /source-plugin-runtime/config.toml /bootstrap/plugin-runtime/config.toml",
    `cp /source-service-principal/${token.path} /bootstrap/service-principal/${token.path}`,
    "chmod 0444 /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem",
    "chmod 0444 /bootstrap/plugin-runtime/runtime.json /bootstrap/plugin-runtime/config.toml",
    `chmod 0444 /bootstrap/service-principal/${token.path}`,
    "chmod 0555 /bootstrap/plugin-runtime /bootstrap/service-principal",
    "chmod 0700 /bootstrap/runtime-assets /bootstrap/openclaw-home",
    "chmod 0700 /workspace-home/openshell-home /workspace-home/openshell-home/.codex",
  ].join("\n");
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName(context.revision.id),
      namespace: context.namespace.name,
      labels: {
        ...requirements.labels,
        "openclaw.dev/workload-role": "sandbox-bootstrap-bridge",
      },
      annotations: {
        "openclaw.dev/namespace-id": context.revision.namespaceId,
        "openclaw.dev/agent-id": context.revision.agentId,
        "openclaw.dev/revision-id": context.revision.id,
      },
    },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            ...requirements.labels,
            "openclaw.dev/workload-role": "sandbox-bootstrap-bridge",
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: requirements.serviceAccountName,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser,
            runAsGroup: runAsUser,
            fsGroup: runAsUser,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "write-openshell-bootstrap",
              image: requirements.image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-ceu", script],
              env: [appServerToken, nodeSetupCode, { name: "OPENCLAW_NODE_CA_PEM", value: nodeCa }],
              volumeMounts: [
                { name: "bootstrap", mountPath: "/bootstrap", subPath },
                { name: "bootstrap", mountPath: "/workspace-home", subPath: "workspace" },
                {
                  name: "node-state-bootstrap",
                  mountPath: "/agent-node-state",
                  subPath: nodeStateParent(context.revision.agentId),
                },
                { name: "plugin-runtime", mountPath: "/source-plugin-runtime", readOnly: true },
                {
                  name: "service-principal",
                  mountPath: "/source-service-principal",
                  readOnly: true,
                },
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
          volumes: [
            { name: "bootstrap", persistentVolumeClaim: { claimName: claimName(requirements) } },
            {
              name: "node-state-bootstrap",
              persistentVolumeClaim: { claimName: claimName(requirements) },
            },
            {
              name: "plugin-runtime",
              configMap: {
                name: pluginRuntimeConfigMapName(context),
                items: [
                  { key: "runtime.json", path: "runtime.json" },
                  { key: "config.toml", path: "config.toml" },
                ],
                optional: false,
              },
            },
            {
              name: "service-principal",
              projected: {
                sources: [
                  {
                    serviceAccountToken: {
                      audience: token.audience,
                      expirationSeconds: token.expirationSeconds,
                      path: token.path,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  } as KubernetesObject;
}

async function waitForJob(
  kubernetes: KubernetesObjectApi,
  context: SandboxNamespaceContext,
  name: string,
): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    context.signal.throwIfAborted();
    const job = await kubernetes.read({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, namespace: context.namespace.name },
    });
    const status = (job as { status?: { conditions?: { type: string; status: string }[] } })
      ?.status;
    if (
      status?.conditions?.some(
        (condition) => condition.type === "Complete" && condition.status === "True",
      )
    ) {
      return;
    }
    if (
      status?.conditions?.some(
        (condition) => condition.type === "Failed" && condition.status === "True",
      )
    ) {
      fail(`bootstrap Job ${name} failed; inspect its Pod events.`);
    }
    await delay(750, undefined, { signal: context.signal });
  }
  fail(`bootstrap Job ${name} timed out; inspect its Pod events.`);
}

function portablePieces(program: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const character of program) {
    if (Buffer.byteLength(piece + character) > portableArgumentBytes && piece.length > 0) {
      pieces.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece.length > 0) {
    pieces.push(piece);
  }
  return pieces;
}

function bridgeCommand(command: readonly string[]): string[] {
  if (
    command.slice(0, RUNTIME_WRAPPER_COMMAND.length).join("\0") !==
    RUNTIME_WRAPPER_COMMAND.join("\0")
  ) {
    fail("the Compute runtime wrapper command changed.");
  }
  const index = RUNTIME_WRAPPER_COMMAND.length;
  const bootstrap = [
    `process.env.APP_SERVER_TOKEN = require("node:fs").readFileSync("${credentialMountPath}/app-server-token", "utf8");`,
    `process.env.OPENCLAW_NODE_SETUP_CODE = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-setup-code", "utf8");`,
    `process.env.OPENCLAW_NODE_CA_PEM = require("node:fs").readFileSync("${credentialMountPath}/openclaw-node-ca.pem", "utf8");`,
  ].join("\n");
  const loader = nodeProgramArguments("")[0]!;
  const runtime = command.slice(index);
  if (runtime[0]?.endsWith(loader)) {
    return [
      ...command.slice(0, index),
      `${bootstrap}\n${runtime[0]}`,
      ...portablePieces(runtime.slice(1).join("")),
    ];
  }
  if (runtime.length !== 1) {
    fail("the Compute runtime command changed.");
  }
  return [
    ...command.slice(0, index),
    'eval(process.argv.slice(1).join(""))',
    ...portablePieces(`${bootstrap}\n${runtime[0]}`),
  ];
}

function bridgeRequirements(context: SandboxHarnessContext): HarnessWorkloadRequirements {
  const requirements = context.requirements;
  const claim = claimName(requirements);
  const subPath = credentialSubPath(context.revision.id);
  if (
    requirements.environment.some((entry) => entry.name === "OPENAI_API_KEY") ||
    requirements.credentialAttachments.length !== 1
  ) {
    fail("the model key must be delivered only by the OpenShell Credential Gateway.");
  }
  const environment = requirements.environment
    .filter(
      (entry) =>
        !["APP_SERVER_TOKEN", "OPENCLAW_NODE_SETUP_CODE", "OPENCLAW_NODE_CA_PEM"].includes(
          entry.name,
        ),
    )
    .map((entry) => {
      if (entry.name === "HOME") {
        return { name: "HOME", value: workspaceMountPath };
      }
      if (entry.name === "CODEX_HOME") {
        return { name: "CODEX_HOME", value: `${workspaceMountPath}/.codex` };
      }
      if (entry.name === "OPENCLAW_NODE_STATE_DIR") {
        return { name: entry.name, value: bridgedNodeStateMountPath };
      }
      if (entry.name === "NODE_COMPILE_CACHE") {
        return { name: entry.name, value: `${bridgedNodeStateMountPath}/.cache/node-compile` };
      }
      return entry;
    });
  return {
    ...requirements,
    command: bridgeCommand(requirements.command),
    environment,
    workspaceMounts: [
      ...requirements.workspaceMounts.filter(
        (mount) => mount.mountPath !== workspaceMountPath && mount.mountPath !== nodeStateMountPath,
      ),
      {
        claimName: claim,
        subPath: bridgedWorkspaceSubPath,
        mountPath: workspaceMountPath,
        readOnly: false,
      },
      {
        claimName: claim,
        subPath: `${nodeStateParent(context.revision.agentId)}/node-state`,
        mountPath: bridgedNodeStateMountPath,
        readOnly: false,
      },
      { claimName: claim, subPath, mountPath: credentialMountPath, readOnly: true },
      {
        claimName: claim,
        subPath: `${subPath}/plugin-runtime`,
        mountPath: pluginRuntimeMountPath,
        readOnly: true,
      },
      {
        claimName: claim,
        subPath: `${subPath}/service-principal`,
        mountPath: requirements.serviceAccountToken.mountPath,
        readOnly: true,
      },
      {
        claimName: claim,
        subPath: `${subPath}/runtime-assets`,
        mountPath: "/home/node/openclaw-runtime-assets",
        readOnly: false,
      },
      {
        claimName: claim,
        subPath: `${subPath}/openclaw-home`,
        mountPath: "/home/node/.openclaw",
        readOnly: false,
      },
      {
        claimName: claim,
        subPath: `${bridgedWorkspaceSubPath}/.codex`,
        mountPath: "/home/node/.codex",
        readOnly: false,
      },
    ],
  };
}

export async function prepareOpenShellCompatibility(
  context: SandboxHarnessContext,
  kubernetes: KubernetesObjectApi,
  sandboxServiceAccountName: string,
  runAsUser: number,
): Promise<HarnessWorkloadRequirements> {
  if (context.revision.harness.id !== "codex") {
    fail("this test-cluster bridge supports only dedicated Codex.");
  }
  if (context.requirements.serviceAccountName !== sandboxServiceAccountName) {
    fail("the configured OpenShell sandbox ServiceAccount differs from the Agent ServiceAccount.");
  }
  const job = bootstrapJob(context, runAsUser);
  await kubernetes.patch(
    job,
    undefined,
    undefined,
    "openclaw-enterprise-sandbox",
    false,
    PatchStrategy.ServerSideApply,
  );
  try {
    await waitForJob(kubernetes, context, jobName(context.revision.id));
  } catch (error) {
    await cleanupOpenShellCompatibility(context, kubernetes);
    throw error;
  }
  return bridgeRequirements(context);
}

export async function cleanupOpenShellCompatibility(
  context: SandboxNamespaceContext & { readonly revision: { readonly id: string } },
  kubernetes: KubernetesObjectApi,
): Promise<void> {
  const name = jobName(context.revision.id);
  let job: KubernetesObject;
  try {
    job = await kubernetes.read({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { namespace: context.namespace.name, name },
    });
  } catch (error) {
    const status = error as { code?: number; statusCode?: number };
    if (status.code === 404 || status.statusCode === 404) {
      return;
    }
    throw error;
  }
  const source = job as KubernetesObject & {
    spec: {
      template: {
        metadata?: { labels?: Record<string, string> };
        spec: {
          containers: {
            name: string;
            env: unknown[];
            command: string[];
            volumeMounts: { name: string }[];
          }[];
          volumes: { name: string }[];
        };
      };
    };
  };
  const template = structuredClone(source.spec.template);
  for (const label of [
    "batch.kubernetes.io/controller-uid",
    "batch.kubernetes.io/job-name",
    "controller-uid",
    "job-name",
  ]) {
    delete template.metadata?.labels?.[label];
  }
  const pod = template.spec;
  const container = pod.containers[0]!;
  container.name = "delete-openshell-bootstrap";
  container.env = [];
  container.command = [
    "sh",
    "-ceu",
    [
      "chmod -R u+w /bootstrap/plugin-runtime /bootstrap/service-principal",
      "rm -f /bootstrap/app-server-token /bootstrap/openclaw-node-setup-code /bootstrap/openclaw-node-ca.pem",
      "rm -rf /bootstrap/plugin-runtime /bootstrap/service-principal /bootstrap/runtime-assets /bootstrap/openclaw-home",
    ].join("\n"),
  ];
  container.volumeMounts = container.volumeMounts.filter((mount) => mount.name === "bootstrap");
  pod.volumes = pod.volumes.filter((volume) => volume.name === "bootstrap");
  const cleaner: KubernetesObject = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: `${name}-cleanup`,
      namespace: context.namespace.name,
      labels: source.metadata?.labels,
    },
    spec: { backoffLimit: 0, template },
  } as KubernetesObject;
  await kubernetes.patch(
    cleaner,
    undefined,
    undefined,
    "openclaw-enterprise-sandbox",
    false,
    PatchStrategy.ServerSideApply,
  );
  await waitForJob(kubernetes, context, `${name}-cleanup`);
  await kubernetes.delete({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { namespace: context.namespace.name, name: `${name}-cleanup` },
  });
  await kubernetes.delete({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { namespace: context.namespace.name, name },
  });
}
