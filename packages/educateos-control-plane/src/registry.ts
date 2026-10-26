// The opt-in registry as the control plane serves it: `@educateos/fleet`'s `InstanceRegistry` over
// the Durable Object's storage, with the operator store as its commercial system. An installation
// registers only through the guided install, and only when the operator asks for it: the install
// registers it from inside the control plane. After that, its heartbeats arrive over HTTP.
import { EducateOsError, type ErrorCode, InstanceId } from "@educateos/contracts";
import { type HealthProbe, type InstanceRecord, InstanceRegistry } from "@educateos/fleet";
import type { DurableObjectSqlStorage } from "@educateos/fleet/durable-object-store";
import { DurableObjectRegistryStorage } from "./registry-store.ts";
import type { ControlPlaneStore, Installation, Operator } from "./store.ts";

// Clever's object IDs, a district's included: 24 hex characters.
const CLEVER_DISTRICT_ID = /^[0-9a-f]{24}$/;

/** The registry messages the control plane accepts. */
export const REGISTRY_MESSAGES = ["register", "heartbeat"] as const;
/** A registry message kind. Only heartbeats arrive over HTTP (`HTTP_REGISTRY_MESSAGES`). */
export type RegistryMessage = (typeof REGISTRY_MESSAGES)[number];

/**
 * The registry's answer, as a value: an error's `code` doesn't survive Workers RPC, so the Durable
 * Object reports it rather than throwing it.
 */
export type RegistryReply = { ok: true; body: unknown } | { ok: false; code: ErrorCode; message: string };

/** What an operator's dashboard shows of an installation's registration. */
export interface Registration {
  releaseVersion: string;
  registeredAt: string;
  lastHeartbeatAt?: string;
  probes: HealthProbe[];
}

/** One row of an operator's dashboard: the installation, and its registration if it opted in. */
export interface DashboardEntry {
  installation: Installation;
  registration?: Registration;
}

/** The registry and the operator store, in one Durable Object. */
export class ControlPlaneRegistry {
  readonly #storage: DurableObjectRegistryStorage;
  readonly #store: ControlPlaneStore;
  readonly #registry: InstanceRegistry;

  constructor(storage: DurableObjectSqlStorage, store: ControlPlaneStore, now: () => Date = () => new Date()) {
    this.#storage = new DurableObjectRegistryStorage(storage);
    this.#store = store;
    this.#registry = new InstanceRegistry({
      storage: this.#storage,
      accountVerifier: {
        verifyRegistration: async ({ commercialAccountId, instanceId }) => store.verifyRegistration(commercialAccountId, instanceId),
      },
      now,
    });
  }

  /** Handles one registry message from the network. */
  async receive(kind: RegistryMessage, input: unknown): Promise<RegistryReply> {
    try {
      if (kind === "register") return { ok: true, body: await this.#registry.register(input) };
      await this.#registry.acceptHeartbeat(input);
      return { ok: true, body: { accepted: true } };
    } catch (error) {
      if (error instanceof EducateOsError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
  }

  /**
   * Records the Clever district a registered installation serves, so Clever portal launches from
   * that district reach it (SCHO-249). Like registration, it is called only from inside the control
   * plane, never over HTTP: the guided install sets it at opt-in, once the operator has shown the
   * district is theirs. An unregistered installation, or a Clever district another installation
   * already names, is refused.
   */
  async linkCleverDistrict(instanceId: string, cleverDistrictId: string): Promise<RegistryReply> {
    const instance = InstanceId.safeParse(instanceId);
    if (!instance.success || !CLEVER_DISTRICT_ID.test(cleverDistrictId)) {
      return { ok: false, code: "validation-failed", message: "expected an instance ID and a Clever district ID" };
    }
    if (await this.#storage.linkCleverDistrict(instance.data, cleverDistrictId)) return { ok: true, body: { linked: true } };
    return { ok: false, code: "conflict", message: "the installation isn't registered, or another installation serves that Clever district" };
  }

  /**
   * The hostname of the registered installation serving a Clever district, for a portal launch.
   * Undefined for a district no registered installation names: installations that never opted in
   * to the registry can't take portal launches through educateos.io.
   */
  async cleverLaunchHostname(cleverDistrictId: string): Promise<string | undefined> {
    if (!CLEVER_DISTRICT_ID.test(cleverDistrictId)) return undefined;
    const instanceId = await this.#storage.cleverDistrictInstance(cleverDistrictId);
    return instanceId === undefined ? undefined : this.#store.installation(instanceId)?.hostname;
  }

  /**
   * The operator's installations, each with its registration when the instance registered under
   * this operator's account. A record under another account is never shown, even for the same ID.
   */
  async dashboard(operator: Operator): Promise<DashboardEntry[]> {
    const records = new Map<string, InstanceRecord>(
      (await this.#storage.forAccount(operator.accountId)).map((record) => [record.instanceId, record]));
    return this.#store.installations(operator.subject).map((installation) => {
      const record = records.get(installation.instanceId);
      if (record === undefined) return { installation };
      return {
        installation,
        registration: {
          releaseVersion: record.releaseVersion,
          registeredAt: record.registeredAt,
          ...(record.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: record.lastHeartbeatAt }),
          probes: record.probes,
        },
      };
    });
  }
}
