# Per-PR preview environments

Ephemeral, isolated deployments of a pull request's head commit, so reviewers
can exercise WS protocol changes, auth flows and the on-chain pipeline without
local setup. Implements issue #485.

Everything below describes the *shipped* behaviour of
[`.github/workflows/preview.yml`](../../.github/workflows/preview.yml) and
[`deploy/helm/vortex-preview/`](../../deploy/helm/vortex-preview/). Where a
step depends on repository or cluster configuration that lives outside this
repo, it says so explicitly under [Required configuration](#required-configuration).

## What a reviewer gets

| | |
|---|---|
| API | `https://pr-<number>.<domain>/` (or `http://` if `PREVIEW_SCHEME=http`) |
| Swagger UI | `…/docs` (spec at `…/docs-json`) |
| WebSocket | `wss://pr-<number>.<domain>/ws` |
| Seeded data | `…/api/v1/intents`, `…/api/v1/solvers` — served from the same seed builders `npm run seed` exercises |
| Namespace | `pr-<number>` — app + throwaway Postgres + throwaway Redis, one ResourceQuota |
| Lifetime | up to `PREVIEW_TTL_HOURS` (default 6 h), or until the PR closes / the label is removed |

The URL is posted as a **sticky PR comment** (one comment, updated in place,
recognisable by the `<!-- vortex-preview -->` marker) together with the smoke
test verdict.

## How to trigger it

1. Open a PR **from a branch in this repository** (not a fork — forks are
   explicitly out of scope for previews, see [Security](#security-boundaries)).
2. Add the **`preview`** label.
3. Wait for the `Preview` workflow: deploy → smoke test → comment.

Subsequent pushes redeploy automatically while the label is present. Reopening
a closed PR that still carries the label redeploys it.

| Event | Result |
|---|---|
| `labeled: preview` | deploy |
| `synchronize` / `reopened`, label present | redeploy |
| `unlabeled: preview` | tear down |
| `closed`, label present | tear down |
| `schedule` (`:07` and `:37` past each hour) | TTL sweep |
| anything on a **fork** PR | no-op (the `gate` job refuses) |

Teardown and the sweep are idempotent (`helm uninstall --ignore-not-found`,
`kubectl delete namespace --ignore-not-found`), so overlapping teardowns are
harmless.

## Lifecycle and cost controls

**TTL.** Every preview namespace carries the label `vortex.io/preview=true`.
The scheduled sweep deletes any such namespace whose **server-side
`creationTimestamp`** is older than `vars.PREVIEW_TTL_HOURS` (default 6).
`creationTimestamp` is used rather than an annotation because an annotation
would be set by the PR's own manifests and could be forged to exempt itself.

**Cost cap — two independent layers:**

1. *Workflow layer:* `deploy` counts live preview namespaces (excluding its
   own) and fails fast — before the image build — when they reach
   `vars.PREVIEW_MAX_CONCURRENT` (default 5). Best-effort: two deploys starting
   at the same instant can both pass.
2. *Cluster layer:* the chart installs a `ResourceQuota` per namespace
   (`quota.hard`: 1 CPU / 2 Gi requests, 2 CPU / 2 Gi limits, 16 pods). This is
   admission-controlled, so it cannot be raced.

Raising either limit is a deliberate act: change the variable, or edit
`deploy/helm/vortex-preview/values.yaml` — both are code-reviewed.

**Concurrency.** The workflow groups runs per PR
(`concurrency: preview-<number>`, `cancel-in-progress: false`) so a teardown is
never cancelled mid-flight by a newer event; GitHub keeps at most one pending
run per group, so the newest state still wins.

## Security boundaries

* **Fork exclusion is a gate, not a comment.** The `gate` job is the only place
  that interprets the event, and it requires
  `pull_request.head.repo.full_name == github.repository` *before* considering
  any action — including `closed` and `unlabeled`. The `deploy` and `teardown`
  jobs repeat the test in their `if:` as defence in depth.
* **No application secrets are reachable from this workflow.** Its only
  `secrets.*` reference is `secrets.GITHUB_TOKEN`. Configuration comes from
  public testnet values (`.env.testnet.example`), a **freshly generated
  throwaway Stellar testnet keypair** (masked with `::add-mask::` before it is
  printed) and a **random per-run database password**. Production secrets cannot
  leak into a preview because none are in scope.
* **Cluster access is via GitHub OIDC**, never a stored kubeconfig or access
  key: a short-lived token exchanged for AWS credentials, scoped by the IAM
  role's trust policy to this repository and the GitHub Environment `preview`.
  The Helm release (which holds the throwaway values) and the namespace itself
  die with the preview.
* **Testnet only, low balance.** The chart has no mainnet branch:
  `STELLAR_NETWORK=testnet`, `SOROBAN_RPC_URL` points at testnet,
  contract IDs are empty (on-chain writes are no-ops) and
  `ONCHAIN_INTENTS_ENABLED=false`.
* **Unsigned images by design.** A preview image is built by this workflow and
  is never signed — `cd.yml`'s cosign subject accepts only `main` and `v*` tags,
  so a preview image can never be mistaken for a releasable artifact.

## Required configuration

Repository (or `preview`-environment) **Actions variables** — the deploy job
fails in seconds with an explicit error if they are missing:

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PREVIEW_DOMAIN` | yes | — | Base domain; hosts are `pr-<n>.<domain>` |
| `PREVIEW_INGRESS_CLASS` | yes | — | Ingress class, e.g. `nginx` |
| `AWS_REGION` | yes | — | Region of the preview cluster |
| `AWS_PREVIEW_ROLE_ARN` | yes | — | IAM role assumed via OIDC |
| `PREVIEW_EKS_CLUSTER` | yes | — | EKS cluster name for `aws eks update-kubeconfig` |
| `PREVIEW_SCHEME` | no | `https` | `https` or `http` (no TLS at the ingress) |
| `PREVIEW_TTL_HOURS` | no | `6` | Namespace lifetime before the sweep reclaims it |
| `PREVIEW_MAX_CONCURRENT` | no | `5` | Workflow-layer cost cap |

Other repository configuration:

* **Label `preview`** must exist (create it once; the taxonomy is in
  [`docs/LABEL_TAXONOMY.md`](../LABEL_TAXONOMY.md)).
* **GitHub Environment `preview`** — referenced by the deploy/smoke/teardown/
  sweep jobs. GitHub creates it on first run if absent; add *required
  reviewers* to it if every preview deploy should need manual approval, and it
  is the natural home for environment-scoped variables above.
* **IAM role trust policy** for `token.actions.githubusercontent.com`. The job
  declares `environment: preview`, so the OIDC subject claim is
  `repo:<owner>/<repo>:environment:preview`, which is what the trust condition
  should pin:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
        },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
          "StringEquals": {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:environment:preview"
          },
          "StringLike": {
            "token.actions.githubusercontent.com:job_workflow_ref": "<owner>/<repo>/.github/workflows/preview.yml@*"
          }
        }
      }
    ]
  }
  ```

  The `job_workflow_ref` condition (recommended) additionally pins the
  assumption to *this* workflow file. The role itself needs only what the
  workflow does: create/delete namespaces, run Helm, read nodes — never a
  cluster-admin binding to humans' sessions.
* **Cluster prerequisites:** an ingress controller matching
  `PREVIEW_INGRESS_CLASS`, wildcard DNS `*.PREVIEW_DOMAIN` pointing at it
  (+ TLS, e.g. a wildcard certificate, when `PREVIEW_SCHEME=https`), and a
  `ghcr.io` package permission for `GITHUB_TOKEN` (already granted via
  `packages: write`; the package's access settings must allow the repository).
* The workflow assumes **EKS** only in the two credential steps
  (`configure-aws-credentials` + `aws eks update-kubeconfig`). Everything
  downstream — namespace names, Helm, kubectl — is cluster-agnostic; swapping
  those two steps for another OIDC login is a localised change.

## What the workflow does

1. **`gate`** — pure event interpretation; outputs `action`
   (`deploy` / `teardown` / `none`), `namespace`, `pr`. No credentials.
2. **`deploy`** — checks configuration → `npm ci` → `npm run seed` (the seed
   builders must run against the PR's code) → generates and masks the throwaway
   keypair and DB password → OIDC login → cost-cap check → build + push
   `ghcr.io/<repo>/vortex-backend:pr-<n>-<sha12>` → create + label the
   namespace → `helm upgrade --install` with `--wait` → sticky PR comment.
3. **`smoke`** — from outside the cluster: `/health/ready` (retry loop),
   `/health`, `/health/live`, `/docs` HTML + `/docs-json`,
   `/api/v1/intents` non-empty, and a WebSocket opening handshake against `/ws`
   expecting `101 Switching Protocols`. Failure fails the run and updates the
   sticky comment.
4. **`teardown`** — `helm uninstall --ignore-not-found` + delete namespace,
   then rewrites the sticky comment to "torn down".
5. **`ttl-cleanup`** — scheduled; deletes expired preview namespaces and
   reports the live count.

### Data and seeding, precisely

`npm run seed` writes `.seed-data/*.json` on the runner (it needs
devDependencies, which the runtime image does not ship, so it runs in the
workflow rather than in the cluster). The *served* data comes from the same
builders: with `INTENTS_PERSISTENCE=memory` / `SOLVERS_PERSISTENCE=memory` —
the preview defaults — the repositories call `buildSeedIntents()` /
`buildSeedSolvers()` at boot, so `/api/v1/intents` is populated as soon as the
pod is Ready. Postgres in the namespace is still migrated and used (health
checks, kill-switch persistence, Prisma-backed features).

## Chart design notes

* **Ephemeral storage on purpose.** Postgres and Redis are Deployments with
  `emptyDir`, not StatefulSets with PVCs: preview data dies with the namespace
  anyway, a retained PV after teardown is pure cost, and no StorageClass
  dependency means the chart renders on any conformant cluster. Pod-restart
  data loss is accepted and documented rather than surprising.
* **One Service port.** The WS gateway shares the HTTP listener (`/ws` on the
  same port), so one Ingress path covers HTTP and WebSocket.
* **Probes:** `/health/startup` (covers `prisma migrate deploy` in the
  entrypoint), `/health/ready`, `/health/live`.
* **No `runAsNonRoot`:** the `node:20-alpine` runtime image defines no `USER`;
  forcing non-root would crash-loop every preview. Hardening the image to run
  unprivileged is a separate issue — it must not be smuggled in through a
  chart nobody tests the image change against.

## Known gaps and follow-ups

* **Nothing here has run against a live cluster yet.** The workflow is
  validated statically (`actionlint`, YAML parsing) and the chart with
  `helm lint` / `helm template` + strict YAML parsing of the rendered output.
  The first labelled PR is the real integration test; expect ingress-class and
  DNS details to be the first things to adjust.
* **Preview images accumulate in ghcr.io** (`pr-*` tags). Add a package
  retention rule, or extend `ttl-cleanup` with a `gh api` tag-pruning step.
* **No NetworkPolicy.** Within the cluster, other namespaces could reach a
  preview's ClusterIP services (whose credentials are throwaway). A
  default-deny policy is cheap hardening for a follow-up.
* **Concurrent capability is approximate** despite the two layers (see
  [cost controls](#lifecycle-and-cost-controls)); it is a budget guardrail, not
  a scheduler.
* **Fork previews remain out of scope** by design (issue #485).
