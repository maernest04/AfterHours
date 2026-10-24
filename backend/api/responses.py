"""Success contracts and synthetic OpenAPI examples. Handlers remain unimplemented."""

import json
from datetime import date
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

MoneyCents = Annotated[str, Field(strict=True, pattern=r"^-?(0|[1-9][0-9]*)$",
                                  description="Exact integer cents as a string; never floating-point dollars.")]
UnsignedCents = Annotated[str, Field(strict=True, pattern=r"^(0|[1-9][0-9]*)$")]
ReviewStatus = Literal[
    "IMPORTED", "EXTRACTING", "MATCHING", "INVESTIGATING", "READY_FOR_REVIEW",
    "APPROVED", "EXPORTED", "WAITING_FOR_INPUT", "VERIFIED_NO_CHANGE",
    "NEEDS_REVISION", "RETRYABLE_ERROR", "FAILED",
]


class ResponseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateReviewResponse(ResponseModel):
    review_id: str = Field(min_length=1, description="Generated and persisted by the data plane.")
    idempotency_key: str = Field(min_length=1, description="Generated and persisted by the data plane; not a request field.")
    status: Literal["IMPORTED"]


class ReviewSummary(ResponseModel):
    review_id: str
    status: ReviewStatus
    created_at: AwareDatetime
    updated_at: AwareDatetime


class ListReviewResponse(ResponseModel):
    items: list[ReviewSummary] = Field(max_length=10)
    next_cursor: str | None = Field(description="Opaque cursor for the next page; null means the last page.")


class Evidence(ResponseModel):
    evidence_id: str
    document_id: str
    page_or_row: str
    excerpt: str


class JournalLine(ResponseModel):
    entry_date: date
    reference_id: str
    account_code: str
    account_name: str
    debit_cents: UnsignedCents
    credit_cents: UnsignedCents
    currency: Literal["USD"]
    description: str


class ReviewHistoryItem(ResponseModel):
    timestamp: AwareDatetime
    action: Literal["APPROVED", "REJECTED", "QUESTION", "ANSWERED", "INPUT_UPDATED"]
    actor: str = Field(description="Email sender or recorded actor label.")
    email_id: str | None
    summary: str
    evidence_ids: list[str]


class GetReviewResponse(ReviewSummary):
    sequence: str = Field(description="Opaque update cursor; also used as the SSE event id.")
    input_revision: int = Field(ge=0)
    currency: Literal["USD"]
    original_status: Literal["DRAFT", "POSTED"] | None
    original_amount_cents: MoneyCents | None
    corrected_target_cents: MoneyCents | None
    difference_cents: MoneyCents | None
    export_amount_cents: MoneyCents | None
    proposal_id: str | None
    proposal_hash: str | None
    journal_lines: list[JournalLine]
    evidence: list[Evidence]
    history: list[ReviewHistoryItem]
    blockers: list[str]


CREATE_EXAMPLE = {"review_id": "review-1", "idempotency_key": "generated-key-1", "status": "IMPORTED"}
SUMMARY_EXAMPLE = {
    "review_id": "review-1", "status": "APPROVED",
    "created_at": "2026-10-23T18:00:00Z", "updated_at": "2026-10-23T18:10:00Z",
}
LIST_EXAMPLE = {"items": [SUMMARY_EXAMPLE], "next_cursor": None}
GET_EXAMPLE = {
    **SUMMARY_EXAMPLE, "sequence": "12", "input_revision": 1, "currency": "USD",
    "original_status": "POSTED", "original_amount_cents": "700000",
    "corrected_target_cents": "770000", "difference_cents": "70000", "export_amount_cents": "70000",
    "proposal_id": "proposal-1", "proposal_hash": "sha256:example",
    "journal_lines": [
        {"entry_date": "2026-10-23", "reference_id": "review-1", "account_code": "6000",
         "account_name": "Contractor expense", "debit_cents": "70000", "credit_cents": "0",
         "currency": "USD", "description": "Synthetic accrual correction"},
        {"entry_date": "2026-10-23", "reference_id": "review-1", "account_code": "2100",
         "account_name": "Accrued liabilities", "debit_cents": "0", "credit_cents": "70000",
         "currency": "USD", "description": "Synthetic accrual correction"},
    ],
    "evidence": [{"evidence_id": "evidence-1", "document_id": "amendment-1",
                  "page_or_row": "page 1", "excerpt": "Approved rate: $110/hour for the 70 unbilled hours."}],
    "history": [{"timestamp": "2026-10-23T18:10:00Z", "action": "APPROVED",
                 "actor": "reviewer@example.test", "email_id": "email-1",
                 "summary": "Approved proposal-1 by email.", "evidence_ids": ["evidence-1"]}],
    "blockers": [],
}
SSE_EXAMPLE = (
    f'id: 12\nevent: snapshot\ndata: {json.dumps(GET_EXAMPLE)}\n\n'
    f'id: 13\nevent: review.updated\ndata: {json.dumps({**GET_EXAMPLE, "sequence": "13", "status": "EXPORTED"})}\n\n'
)
CSV_EXAMPLE = (
    "entry_date,reference_id,account_code,account_name,debit,credit,currency,description\r\n"
    "2026-10-23,review-1,6000,Contractor expense,700.00,0.00,USD,Synthetic accrual correction\r\n"
    "2026-10-23,review-1,2100,Accrued liabilities,0.00,700.00,USD,Synthetic accrual correction\r\n"
)
STUB_RESPONSE = {
    501: {"description": "Not implemented yet. This is the current response for every valid request.",
          "content": {"application/json": {"example": {"detail": {
              "code": "NOT_IMPLEMENTED", "operation": "<operation-name>",
              "message": "Backend integration is not connected yet.",
          }}}}},
}
