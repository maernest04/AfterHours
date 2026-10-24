/** Actual Python API routes only. Not activated until the backend is implemented.
 * This transport never guesses workflow-node state or submits browser approvals.
 * The UI intentionally uses MockReviewAdapter; see README for the remaining mapping.
 */
export interface ApiJournalLine {
  entry_date: string;
  reference_id: string;
  account_code: string;
  account_name: string;
  debit_cents: string;
  credit_cents: string;
  currency: string;
  description: string;
}
export interface ApiEvidence {
  evidence_id: string;
  document_id: string;
  page_or_row: string;
  excerpt: string;
}
export interface ApiHistory {
  timestamp: string;
  action: string;
  actor: string;
  email_id: string | null;
  summary: string;
  evidence_ids: string[];
}
export interface ApiReview {
  review_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  sequence: string;
  input_revision: number;
  currency: string;
  original_status: "DRAFT" | "POSTED" | null;
  original_amount_cents: string | null;
  corrected_target_cents: string | null;
  difference_cents: string | null;
  export_amount_cents: string | null;
  proposal_id: string | null;
  proposal_hash: string | null;
  journal_lines: ApiJournalLine[];
  evidence: ApiEvidence[];
  history: ApiHistory[];
  blockers: string[];
}
export interface ApiList {
  items: Pick<
    ApiReview,
    "review_id" | "status" | "created_at" | "updated_at"
  >[];
  next_cursor: string | null;
}
export class ReviewApi {
  constructor(private baseUrl: string) {}
  private async request(path: string, init?: RequestInit) {
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/${path}`,
      init,
    );
    if (!response.ok)
      throw new Error(
        response.status === 501
          ? "The Python review API is not implemented yet. Demo mode is available."
          : `Review API returned HTTP ${response.status}.`,
      );
    return response;
  }
  async create(files: File[]) {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return (
      await this.request("create-review", { method: "POST", body: form })
    ).json() as Promise<{
      review_id: string;
      idempotency_key: string;
      status: string;
    }>;
  }
  async list(limit = 10, cursor?: string): Promise<ApiList> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new Error("List limit must be 1–10.");
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return (await this.request(`list-review?${query}`)).json();
  }
  async get(id: string): Promise<ApiReview> {
    return (
      await this.request(`get-review?${new URLSearchParams({ review_id: id })}`)
    ).json();
  }
  async export(id: string): Promise<Blob> {
    return (
      await this.request(
        `export-review?${new URLSearchParams({ review_id: id })}`,
      )
    ).blob();
  }
  subscribe(
    id: string,
    onSnapshot: (s: ApiReview) => void,
    onConnection: (
      state: "connecting" | "connected" | "disconnected" | "error",
      message?: string,
    ) => void,
  ) {
    let active = true,
      lastSequence: string | null = null,
      lastRevision = -1,
      lastUpdated = "",
      stream: EventSource | null = null,
      retry: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    const emit = (s: ApiReview) => {
      if (
        s.review_id !== id ||
        typeof s.sequence !== "string" ||
        !Number.isInteger(s.input_revision)
      )
        throw new Error("Invalid review snapshot.");
      if (
        seen.has(s.sequence) ||
        s.input_revision < lastRevision ||
        s.updated_at < lastUpdated
      )
        return;
      seen.add(s.sequence);
      lastSequence = s.sequence;
      lastRevision = s.input_revision;
      lastUpdated = s.updated_at;
      onSnapshot(s);
    };
    const connect = async () => {
      onConnection("connecting");
      try {
        const snapshot = await this.get(id);
        if (!active) return;
        emit(snapshot);
        const params = new URLSearchParams({
          review_id: id,
          live: "true",
          after_sequence: String(lastSequence),
        });
        stream = new EventSource(
          `${this.baseUrl.replace(/\/$/, "")}/get-review?${params}`,
        );
        stream.onopen = () => onConnection("connected");
        const receive = (event: MessageEvent) => {
          try {
            emit(JSON.parse(event.data) as ApiReview);
          } catch {
            onConnection("error", "Invalid snapshot received.");
            stream?.close();
          }
        };
        stream.addEventListener("snapshot", receive);
        stream.addEventListener("review.updated", receive);
        stream.onerror = () => {
          stream?.close();
          if (!active) return;
          onConnection("disconnected");
          retry = setTimeout(() => void connect(), 2000);
        };
      } catch (e) {
        if (active)
          onConnection(
            "error",
            e instanceof Error ? e.message : "Unable to connect.",
          );
      }
    };
    void connect();
    return () => {
      active = false;
      stream?.close();
      clearTimeout(retry);
    };
  }
}
