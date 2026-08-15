import crypto from "node:crypto";
import { DraftPullRequestError, DraftPullRequestReceipt, GitHubPullRequestClient, GitHubPullRequest } from "./contracts.js";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface ExecuteDraftPrInput {
  runId: string;
  taskId: string;
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  expectedHeadSha: string;
  changeSetSha256: string;
  gitPublishReceiptSha256: string;
  existingReceipt: DraftPullRequestReceipt | null;
  verifyRemoteHead: () => Promise<void>;
}

interface DraftRequestHashes {
  title: string;
  body: string;
  bodySha256: string;
  requestSha256: string;
}

export class DraftPullRequestStateMachine {
  constructor(
    private readonly client: GitHubPullRequestClient,
    private readonly persistReceipt: (receipt: DraftPullRequestReceipt) => Promise<void>,
    private readonly now: () => Date = () => new Date()
  ) {}

  private validateIdentifier(name: string, value: string, regex: RegExp, minLen = 1, maxLen = 256) {
    if (typeof value !== "string" || value.length < minLen || value.length > maxLen) {
      throw new DraftPullRequestError("PR_REQUEST_INVALID", `Invalid ${name} length.`);
    }
    if (!regex.test(value)) {
      throw new DraftPullRequestError("PR_REQUEST_INVALID", `Invalid ${name} format.`);
    }
  }

  private validateBranch(name: string, value: string) {
    this.validateIdentifier(name, value, BRANCH_NAME, 1, 256);
    if (value.includes("..") || value.includes("//") || value.includes("@{") || value.endsWith("/") || value.endsWith(".")) {
      throw new DraftPullRequestError("PR_REQUEST_INVALID", `Invalid ${name} content.`);
    }
    if (value.split("/").includes(".lock") || value.endsWith(".lock")) {
      throw new DraftPullRequestError("PR_REQUEST_INVALID", `Invalid ${name} .lock component.`);
    }
  }

  private validateInput(input: ExecuteDraftPrInput) {
    if (!input.runId || typeof input.runId !== "string") throw new DraftPullRequestError("PR_REQUEST_INVALID", "Invalid runId.");
    this.validateIdentifier("taskId", input.taskId, TASK_ID, 1, 64);
    this.validateBranch("baseBranch", input.baseBranch);
    this.validateBranch("headBranch", input.headBranch);
    if (input.baseBranch === input.headBranch) throw new DraftPullRequestError("PR_REQUEST_INVALID", "Base and head branches must differ.");
    this.validateIdentifier("expectedHeadSha", input.expectedHeadSha, SHA, 40, 64);
    this.validateIdentifier("changeSetSha256", input.changeSetSha256, DIGEST, 64, 64);
    this.validateIdentifier("gitPublishReceiptSha256", input.gitPublishReceiptSha256, DIGEST, 64, 64);
  }

  private getHashes(input: ExecuteDraftPrInput): DraftRequestHashes {
    const title = `WCO: ${input.taskId}`;
    const body = `## Verified Draft PR

WCO prepared this Draft PR from the exact Harness-verified change set for \`${input.taskId}\`.

### Delivery evidence

- Repository: \`${input.owner}/${input.repository}\`
- Base branch: \`${input.baseBranch}\`
- Delivery branch: \`${input.headBranch}\`
- Verified head: \`${input.expectedHeadSha}\`
- Change-set SHA-256: \`${input.changeSetSha256}\`
- Run: \`${input.runId}\`

### Verification gates

- Deterministic verification: **PASS**
- Remote branch head: **re-attested to the exact verified commit** before this Draft PR was accepted.
- Review gates: tracked separately by mode-specific durable WCO receipts; this Draft PR body does not pre-claim Web, Sol, or Terra approval.

### Human boundary

This PR is intentionally **Draft**. WCO will not mark it ready, merge it, enable auto-merge, delete the branch, or rewrite the published head with a force push. Final merge authority remains with a human maintainer.`;

    const bodySha256 = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    const requestObject = {
      repository: `${input.owner}/${input.repository}`,
      base: input.baseBranch,
      head: input.headBranch,
      sha: input.expectedHeadSha,
      title,
      body,
      draft: true,
      maintainer_can_modify: false
    };
    const requestString = JSON.stringify([
      "repository", requestObject.repository,
      "base", requestObject.base,
      "head", requestObject.head,
      "sha", requestObject.sha,
      "title", requestObject.title,
      "body", requestObject.body,
      "draft", requestObject.draft,
      "maintainer_can_modify", requestObject.maintainer_can_modify
    ]);
    const requestSha256 = crypto.createHash("sha256").update(requestString, "utf8").digest("hex");
    return { title, body, bodySha256, requestSha256 };
  }

  private assertReceiptBoundToInput(receipt: DraftPullRequestReceipt, input: ExecuteDraftPrInput, hashes: DraftRequestHashes): void {
    if (
      receipt.run_id !== input.runId ||
      receipt.repository_owner !== input.owner ||
      receipt.repository_name !== input.repository ||
      receipt.base_branch !== input.baseBranch ||
      receipt.head_branch !== input.headBranch ||
      receipt.expected_head_sha !== input.expectedHeadSha ||
      receipt.git_publish_receipt_sha256 !== input.gitPublishReceiptSha256 ||
      receipt.request_sha256 !== hashes.requestSha256 ||
      receipt.title !== hashes.title ||
      receipt.body_sha256 !== hashes.bodySha256 ||
      receipt.draft_required !== true
    ) {
      throw new DraftPullRequestError("PR_RECEIPT_INCONSISTENT", "Existing receipt no longer binds the exact current Draft PR request authority.");
    }
  }

  private classifyCandidates(candidates: GitHubPullRequest[], input: ExecuteDraftPrInput) {
    const validCandidates = candidates.filter(c => {
      const isHtmlUrlValid = /^https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/[1-9][0-9]*$/.test(c.html_url);
      if (!isHtmlUrlValid || c.number <= 0) return false;
      return true;
    });

    const matchingCandidates = validCandidates.filter(c => {
      return c.head.repo && c.base.repo &&
        c.head.repo.full_name.toLowerCase() === `${input.owner}/${input.repository}`.toLowerCase() &&
        c.base.repo.full_name.toLowerCase() === `${input.owner}/${input.repository}`.toLowerCase() &&
        c.head.ref === input.headBranch &&
        c.head.sha === input.expectedHeadSha &&
        c.base.ref === input.baseBranch &&
        c.state === "open" &&
        c.draft === true &&
        c.merged_at === null;
    });

    const headBranchCandidates = validCandidates.filter(c => c.head.ref === input.headBranch);
    if (headBranchCandidates.length > 1) {
      const firstCandidate = headBranchCandidates[0];
      if (firstCandidate) return { exact: null, conflict: "MULTIPLE_CANDIDATES" as const, pr: firstCandidate };
    }

    if (headBranchCandidates.length === 1) {
      const [c] = headBranchCandidates;
      if (!c) throw new DraftPullRequestError("PR_REQUEST_INVALID", "Expected one pull request candidate.");
      const [matchingCandidate] = matchingCandidates;
      if (matchingCandidates.length === 1 && matchingCandidate && matchingCandidate.number === c.number) return { exact: c, conflict: null, pr: c };
      if (!c.head.repo || !c.base.repo || c.head.repo.full_name.toLowerCase() !== `${input.owner}/${input.repository}`.toLowerCase() || c.base.repo.full_name.toLowerCase() !== `${input.owner}/${input.repository}`.toLowerCase()) return { exact: null, conflict: "WRONG_REPOSITORY" as const, pr: c };
      if (c.head.sha !== input.expectedHeadSha) return { exact: null, conflict: "WRONG_HEAD_SHA" as const, pr: c };
      if (c.base.ref !== input.baseBranch) return { exact: null, conflict: "WRONG_BASE" as const, pr: c };
      if (c.merged_at !== null) return { exact: null, conflict: "MERGED" as const, pr: c };
      if (c.state !== "open") return { exact: null, conflict: "NOT_OPEN" as const, pr: c };
      if (c.draft !== true) return { exact: null, conflict: "NOT_DRAFT" as const, pr: c };
      return { exact: null, conflict: "WRONG_HEAD_BRANCH" as const, pr: c };
    }
    return { exact: null, conflict: null, pr: null };
  }

  private createBaseReceipt(input: ExecuteDraftPrInput, hashes: DraftRequestHashes): DraftPullRequestReceipt {
    const timestamp = this.now().toISOString();
    return {
      receipt_version: "1.0",
      run_id: input.runId,
      state: "READY_FOR_CREATE",
      repository_owner: input.owner,
      repository_name: input.repository,
      base_branch: input.baseBranch,
      head_branch: input.headBranch,
      expected_head_sha: input.expectedHeadSha,
      git_publish_receipt_sha256: input.gitPublishReceiptSha256,
      request_sha256: hashes.requestSha256,
      title: hashes.title,
      body_sha256: hashes.bodySha256,
      draft_required: true,
      create_post_attempted: false,
      pull_number: null,
      pull_url: null,
      observed_head_sha: null,
      observed_base_branch: null,
      observed_state: null,
      observed_draft: null,
      conflict_reason: null,
      created_at: timestamp,
      updated_at: timestamp,
      create_attempted_at: null,
      opened_at: null,
      conflict_at: null
    };
  }

  private mutateReceipt(receipt: DraftPullRequestReceipt, mutations: Partial<DraftPullRequestReceipt>): DraftPullRequestReceipt {
    return { ...receipt, ...mutations, updated_at: this.now().toISOString() };
  }

  public async execute(input: ExecuteDraftPrInput): Promise<DraftPullRequestReceipt> {
    this.validateInput(input);
    const hashes = this.getHashes(input);
    let receipt = input.existingReceipt;

    if (receipt) {
      this.assertReceiptBoundToInput(receipt, input, hashes);
    } else {
      const candidates = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch });
      const cls = this.classifyCandidates(candidates, input);
      receipt = this.createBaseReceipt(input, hashes);
      if (cls.exact) {
        receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cls.exact.number, pull_url: cls.exact.html_url, observed_head_sha: cls.exact.head.sha, observed_base_branch: cls.exact.base.ref, observed_state: cls.exact.state, observed_draft: cls.exact.draft, opened_at: this.now().toISOString() });
      } else if (cls.conflict) {
        receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cls.conflict, conflict_at: this.now().toISOString() });
      }
      await this.persistReceipt(receipt);
    }

    if (receipt.state === "CONFLICT") return receipt;

    if (receipt.state === "OPEN") {
      if (receipt.pull_number === null || receipt.pull_url === null) {
        throw new DraftPullRequestError("PR_RECEIPT_INCONSISTENT", "OPEN receipt is missing its pull request identity.");
      }
      const pr = await this.client.get({ owner: input.owner, repository: input.repository, pullNumber: receipt.pull_number });
      const cls = this.classifyCandidates([pr], input);
      if (!cls.exact || cls.exact.number !== receipt.pull_number || cls.exact.html_url !== receipt.pull_url) {
        receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cls.conflict ?? "OPEN_PR_MUTATED", conflict_at: this.now().toISOString() });
        await this.persistReceipt(receipt);
      }
      return receipt;
    }

    if (receipt.state === "CREATE_UNCERTAIN" || (receipt.state === "READY_FOR_CREATE" && receipt.create_post_attempted)) {
      if (receipt.state === "CREATE_UNCERTAIN" && receipt.pull_number) {
        try {
          const pr = await this.client.get({ owner: input.owner, repository: input.repository, pullNumber: receipt.pull_number! });
          const cls = this.classifyCandidates([pr], input);
          if (cls.exact) {
            receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cls.exact.number, pull_url: cls.exact.html_url, observed_head_sha: cls.exact.head.sha, observed_base_branch: cls.exact.base.ref, observed_state: cls.exact.state, observed_draft: cls.exact.draft, opened_at: this.now().toISOString() });
            await this.persistReceipt(receipt);
            return receipt;
          } else if (cls.conflict) {
            receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cls.conflict, conflict_at: this.now().toISOString() });
            await this.persistReceipt(receipt);
            return receipt;
          }
        } catch {
          // Fall through to bounded rediscovery.
        }
      }

      const candidates = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch });
      const cls = this.classifyCandidates(candidates, input);
      if (cls.exact) {
        receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cls.exact.number, pull_url: cls.exact.html_url, observed_head_sha: cls.exact.head.sha, observed_base_branch: cls.exact.base.ref, observed_state: cls.exact.state, observed_draft: cls.exact.draft, opened_at: this.now().toISOString() });
      } else if (cls.conflict) {
        receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cls.conflict, conflict_at: this.now().toISOString() });
      } else if (receipt.state === "READY_FOR_CREATE" && receipt.create_post_attempted) {
        receipt = this.mutateReceipt(receipt, { state: "CREATE_UNCERTAIN" });
      }
      if (receipt.state !== input.existingReceipt?.state) await this.persistReceipt(receipt);
      return receipt;
    }

    if (receipt.state === "READY_FOR_CREATE" && !receipt.create_post_attempted) {
      const candidates = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch });
      const cls = this.classifyCandidates(candidates, input);
      if (cls.exact) {
        receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cls.exact.number, pull_url: cls.exact.html_url, observed_head_sha: cls.exact.head.sha, observed_base_branch: cls.exact.base.ref, observed_state: cls.exact.state, observed_draft: cls.exact.draft, opened_at: this.now().toISOString() });
        await this.persistReceipt(receipt);
        return receipt;
      } else if (cls.conflict) {
        receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cls.conflict, conflict_at: this.now().toISOString() });
        await this.persistReceipt(receipt);
        return receipt;
      }

      await input.verifyRemoteHead();
      receipt = this.mutateReceipt(receipt, { create_post_attempted: true, create_attempted_at: this.now().toISOString() });
      await this.persistReceipt(receipt);

      let result: GitHubPullRequest;
      try {
        result = await this.client.createDraft({ owner: input.owner, repository: input.repository, title: hashes.title, body: hashes.body, head: input.headBranch, base: input.baseBranch });
      } catch (err: any) {
        if (err instanceof DraftPullRequestError) {
          if (["PR_API_UNAUTHORIZED", "PR_API_FORBIDDEN", "PR_API_NOT_FOUND"].includes(err.code) || err.code === "PR_API_RATE_LIMITED" && err.message.includes("429")) {
            receipt = this.mutateReceipt(receipt, { create_post_attempted: false, create_attempted_at: null });
            await this.persistReceipt(receipt);
            throw err;
          }
          if (err.code === "PR_CREATE_REJECTED") {
            const c = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch });
            const cCls = this.classifyCandidates(c, input);
            if (cCls.exact) {
              receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cCls.exact.number, pull_url: cCls.exact.html_url, observed_head_sha: cCls.exact.head.sha, observed_base_branch: cCls.exact.base.ref, observed_state: cCls.exact.state, observed_draft: cCls.exact.draft, opened_at: this.now().toISOString() });
              await this.persistReceipt(receipt);
              return receipt;
            } else if (cCls.conflict) {
              receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cCls.conflict, conflict_at: this.now().toISOString() });
              await this.persistReceipt(receipt);
              return receipt;
            }
            receipt = this.mutateReceipt(receipt, { create_post_attempted: false, create_attempted_at: null });
            await this.persistReceipt(receipt);
            throw err;
          }
        }

        const c = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch }).catch(() => []);
        const cCls = this.classifyCandidates(c, input);
        if (cCls.exact) receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cCls.exact.number, pull_url: cCls.exact.html_url, observed_head_sha: cCls.exact.head.sha, observed_base_branch: cCls.exact.base.ref, observed_state: cCls.exact.state, observed_draft: cCls.exact.draft, opened_at: this.now().toISOString() });
        else if (cCls.conflict) receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cCls.conflict, conflict_at: this.now().toISOString() });
        else receipt = this.mutateReceipt(receipt, { state: "CREATE_UNCERTAIN" });
        await this.persistReceipt(receipt);
        if (receipt.state === "CREATE_UNCERTAIN") throw err;
        return receipt;
      }

      try {
        const pr = await this.client.get({ owner: input.owner, repository: input.repository, pullNumber: result.number });
        const cCls = this.classifyCandidates([pr], input);
        if (cCls.exact) {
          receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cCls.exact.number, pull_url: cCls.exact.html_url, observed_head_sha: cCls.exact.head.sha, observed_base_branch: cCls.exact.base.ref, observed_state: cCls.exact.state, observed_draft: cCls.exact.draft, opened_at: this.now().toISOString() });
          await this.persistReceipt(receipt);
          return receipt;
        }
        receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cCls.conflict || "INVALID_CREATE_RESPONSE", conflict_at: this.now().toISOString() });
        await this.persistReceipt(receipt);
        return receipt;
      } catch {
        const c = await this.client.listByHead({ owner: input.owner, repository: input.repository, headOwner: input.owner, headBranch: input.headBranch }).catch(() => []);
        const cCls = this.classifyCandidates(c, input);
        if (cCls.exact) receipt = this.mutateReceipt(receipt, { state: "OPEN", pull_number: cCls.exact.number, pull_url: cCls.exact.html_url, observed_head_sha: cCls.exact.head.sha, observed_base_branch: cCls.exact.base.ref, observed_state: cCls.exact.state, observed_draft: cCls.exact.draft, opened_at: this.now().toISOString() });
        else if (cCls.conflict) receipt = this.mutateReceipt(receipt, { state: "CONFLICT", conflict_reason: cCls.conflict, conflict_at: this.now().toISOString() });
        else receipt = this.mutateReceipt(receipt, { state: "CREATE_UNCERTAIN" });
        await this.persistReceipt(receipt);
        return receipt;
      }
    }

    return receipt;
  }
}