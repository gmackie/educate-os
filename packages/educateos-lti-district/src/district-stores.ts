import { DeepLinkSession, LoginState, RegistrationInvitation, type Clock } from "@educateos/lti";
import {
  LTI_COLLECTIONS,
  TableContextServicesStore,
  TableGradeRouteStore,
  TablePassbackLedger,
  TablePendingRegistrationStore,
  TableRegistrationStore,
  TableRosterSourceStore,
  TableSingleUseStore,
  type RegistrationTargets,
} from "./stores.ts";
import { TableGradeColumnStore } from "./columns.ts";
import type { RecordTable } from "./table.ts";

/** Every store one district's LTI integration needs, over its one record table. */
export interface LtiDistrictStores {
  /** The broker's login states. */
  readonly loginStates: TableSingleUseStore<LoginState>;
  /** The broker's deep linking sessions. */
  readonly deepLinkSessions: TableSingleUseStore<DeepLinkSession>;
  /** Dynamic registration invitations. */
  readonly invitations: TableSingleUseStore<RegistrationInvitation>;
  readonly registrations: TableRegistrationStore;
  readonly pendingRegistrations: TablePendingRegistrationStore;
  readonly passbackLedger: TablePassbackLedger;
  readonly contextServices: TableContextServicesStore;
  readonly gradeRoutes: TableGradeRouteStore;
  readonly gradeColumns: TableGradeColumnStore;
  readonly rosterSources: TableRosterSourceStore;
}

/**
 * The district's LTI stores over `table`: in the district Worker, a `DurableObjectRecordTable` in
 * the district's Durable Object, so every single-use take and ledger claim is atomic across the
 * Worker's isolates.
 */
export function createLtiDistrictStores(table: RecordTable, options: { targets: RegistrationTargets; now?: Clock }): LtiDistrictStores {
  const now = options.now ?? Date.now;
  return {
    loginStates: new TableSingleUseStore(table, LTI_COLLECTIONS.loginStates, LoginState, now),
    deepLinkSessions: new TableSingleUseStore(table, LTI_COLLECTIONS.deepLinkSessions, DeepLinkSession, now),
    invitations: new TableSingleUseStore(table, LTI_COLLECTIONS.invitations, RegistrationInvitation, now),
    registrations: new TableRegistrationStore(table, options.targets),
    pendingRegistrations: new TablePendingRegistrationStore(table),
    passbackLedger: new TablePassbackLedger(table),
    contextServices: new TableContextServicesStore(table),
    gradeRoutes: new TableGradeRouteStore(table),
    gradeColumns: new TableGradeColumnStore(table),
    rosterSources: new TableRosterSourceStore(table),
  };
}
