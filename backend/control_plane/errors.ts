export class InvalidParametersError extends Error {
  readonly code = "INVALID_PARAMETERS";
  readonly status = 400;
  readonly path: string;

  constructor(path: string, expectation: string) {
    super(`${path}: ${expectation}`);
    this.name = "InvalidParametersError";
    this.path = path;
  }
}

export class DataPlaneUnavailableError extends Error {
  readonly code = "DATA_PLANE_UNAVAILABLE";
  readonly status = 503;

  constructor(operation: string) {
    super(`No data-plane adapter is connected for ${operation}.`);
    this.name = "DataPlaneUnavailableError";
  }
}
