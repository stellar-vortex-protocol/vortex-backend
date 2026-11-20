-- Migration: governance_proposal_drafts (issue #507-params)
-- Adds the GovernanceProposalDraft staging table for pre-validated parameter
-- change proposals.

CREATE TYPE "ProposalDraftStatus" AS ENUM ('draft', 'validated', 'submitted', 'rejected');

CREATE TABLE "governance_proposal_drafts" (
    "id"                TEXT                  NOT NULL,
    "proposed_params"   JSONB                 NOT NULL,
    "status"            "ProposalDraftStatus" NOT NULL DEFAULT 'draft',
    "created_by"        TEXT                  NOT NULL,
    "description"       TEXT,
    "validation_errors" JSONB,
    "created_at"        TIMESTAMPTZ           NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ           NOT NULL DEFAULT now(),

    CONSTRAINT "governance_proposal_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "governance_proposal_drafts_status_created_at_idx"
    ON "governance_proposal_drafts" ("status", "created_at" DESC);
