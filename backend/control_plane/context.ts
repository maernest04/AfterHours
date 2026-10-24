/** Construct on the server after verifying the caller; never deserialize from a request body.
 * These types describe trust boundaries. They do not authenticate callers.
 */
interface ServiceContext {
  companyId: string;
  serviceIdentity: string;
  requestId: string;
}
export interface GatewayContext extends ServiceContext { kind: "gateway" }
export interface WorkerContext extends ServiceContext { kind: "worker" }
export interface SystemContext extends ServiceContext { kind: "system" }
