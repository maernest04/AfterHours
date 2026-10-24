/** Initial request limits; independent of storage, worker leases and retry policies. */
export const parameterLimits = {
  maxUploadBytes: 10 * 1024 * 1024,
  maxPageSize: 100,
  allowedMediaTypes: ["text/csv", "application/json", "text/plain", "application/pdf"],
} as const;
