/**
 * The Den contract the eval harness arranges against.
 *
 * This fork is fully self-hosted: the hosted Den control plane (its API, web,
 * and database) no longer ships, so nothing here boots one. What remains is the
 * shape every world and spec is written against — the `Den` handle, the boot
 * options, and the account/organization helpers that speak its HTTP API — so
 * the harness keeps one vocabulary instead of two.
 *
 * `server()` is deliberately inert. Specs and worlds that need a control plane
 * skip with a reason naming the removal rather than failing on a missing
 * binary, and the moment a self-hosted control plane replaces it they get a
 * working `server()` back by filling in this one function.
 */
import { createConnection } from "mysql2/promise";
import type { ExecuteValues } from "mysql2";
import { denFetch, freshSession, signIn } from "@openwork/behaviors";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { DbHandle, Place } from "./place.ts";
import type { MockBoot, MockHandle } from "./mock.ts";
import { SkipError } from "./needs.ts";

export interface PersonShape {
  email?: string;
  name?: string;
  password?: string;
}

export interface OrgShape {
  name?: string;
  admin?: PersonShape;
  members?: Record<string, PersonShape>;
}

export interface ServerOptions {
  place: Place;
  mocks?: Record<string, MockBoot>;
  org?: OrgShape;
  /** Retained for call sites that describe an infra-only boot. Nothing is booted. */
  provision?: boolean;
  schema?: "push" | "migrate";
  web?: boolean;
  env?: Record<string, string | undefined>;
  reuse?: { apiUrl: string; webUrl?: string };
  reuseMembers?: Record<string, PersonShape>;
  ports?: { api: number; web: number };
  /**
   * Where a control plane's web-side API proxy sends API calls. Unused without
   * a booted control plane.
   */
  webApiBase?: string;
  /** Retained for call sites that request the demo seed. Nothing is seeded. */
  seedProfile?: "demo-org";
  /** Extra origins a control plane should trust. Unused without one. */
  trustedOrigins?: readonly string[];
  /** Exact externally routed origins for a private co-located preview. */
  publicOrigins?: { web: string; api: string };
}

export interface Den extends AsyncDisposable {
  ref: DenRef;
  placement?: { kind: "local" } | { kind: "daytona"; sandboxId: string };
  admin: DenSession;
  members: Record<string, DenSession>;
  mocks: Record<string, MockHandle>;
  database?: DbHandle;
  ports?: { api: number; web: number };
  /**
   * Stop a control-plane API and start it again from current sources. No
   * control plane ships with this fork, so this is always absent.
   */
  restartApi?(): Promise<void>;
  /** A co-located AI Gateway, when the control plane ran one. Always absent here. */
  gateway?: { publicUrl: string };
  /**
   * Raw control-plane API HTTP log text. Attached deployments throw: their log
   * lives with whoever runs that server. Parsing belongs to the caller.
   */
  apiLog(): Promise<string>;
}

export interface DenOrgHandle extends AsyncDisposable {
  id: string;
  name: string;
  admin: DenSession;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : null;
}

function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = Reflect.get(value, key);
  return typeof field === "object" && field !== null && !Array.isArray(field) ? field : null;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

export function personDefaults(key: string, person: PersonShape | undefined, runId: string): Required<PersonShape> {
  return {
    email: person?.email?.trim() || `${key}+${runId}@openwork.test`,
    name: person?.name?.trim() || key.replace(/(^|[-_ ])\w/g, (part) => part.toUpperCase()),
    password: person?.password || "OpenWorkEval123!",
  };
}

export function defaultReuseAdmin(): Required<PersonShape> {
  return {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    name: "Alex Eval",
    password: process.env.OPENWORK_EVAL_DEMO_PASSWORD || "OpenWorkDemo123!",
  };
}

export function trustedOrigins(apiPort: number, webPort: number): string[] {
  return [
    `http://localhost:${apiPort}`,
    `http://127.0.0.1:${apiPort}`,
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
  ];
}

async function markVerified(databaseUrl: string, email: string): Promise<void> {
  const connection = await createConnection(databaseUrl);
  try {
    await connection.execute("UPDATE `user` SET email_verified = true WHERE email = ?", [email]);
  } finally {
    await connection.end();
  }
}

async function createOrSignInAccount(
  ref: DenRef,
  person: Required<PersonShape>,
  databaseUrl?: string,
): Promise<DenSession> {
  const signUp = await denFetch(ref, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email: person.email, name: person.name, password: person.password }),
  });
  if (signUp.response.ok && databaseUrl) await markVerified(databaseUrl, person.email);
  try {
    return await signIn(ref, { email: person.email, password: person.password });
  } catch (error) {
    throw new Error(
      `Could not provision ${person.email}: sign-up HTTP ${signUp.response.status} ${signUp.text.slice(0, 300)}; ${messageText(error)}`,
    );
  }
}

async function createOrganization(admin: DenSession, name: string): Promise<string> {
  const created = await denFetch(admin, "/v1/org", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ name }),
  });
  const organizationId = stringField(recordField(created.body, "organization"), "id");
  if (!created.response.ok || !organizationId) {
    throw new Error(`Organization create failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  return organizationId;
}

async function deleteCreatedOrganization(admin: DenSession, organizationId: string): Promise<void> {
  const active = await freshSession(admin).catch(() => admin);
  const selected = await denFetch(active, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(active),
    body: JSON.stringify({ organizationId }),
  });
  if (selected.response.status === 404) return;
  if (!selected.response.ok) {
    throw new Error(`Organization cleanup selection returned HTTP ${selected.response.status}: ${selected.text.slice(0, 500)}`);
  }
  const deleted = await denFetch(active, "/v1/org", { method: "DELETE", headers: auth(active) });
  if (!deleted.response.ok && deleted.response.status !== 404) {
    throw new Error(`Organization cleanup returned HTTP ${deleted.response.status}: ${deleted.text.slice(0, 500)}`);
  }
}

export async function createAdmin(den: Den, person: PersonShape): Promise<DenSession> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const admin = await createOrSignInAccount(
    den.ref,
    personDefaults("admin", person, runId),
    den.database?.url,
  );
  den.admin = admin;
  return admin;
}

export async function createOrg(den: Den, name: string): Promise<DenOrgHandle> {
  if (!den.admin.token.trim()) {
    throw new Error("createOrg requires an authenticated den.admin; call createAdmin after server({ provision: false }).");
  }
  const admin = den.admin;
  const id = await createOrganization(admin, name);
  let disposed = false;
  return {
    id,
    name,
    admin,
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      await deleteCreatedOrganization(admin, id);
    },
  };
}

async function createMember(
  ref: DenRef,
  admin: DenSession,
  person: Required<PersonShape>,
  databaseUrl?: string,
): Promise<DenSession> {
  const invitation = await denFetch(ref, "/v1/invitations", {
    method: "POST",
    headers: auth(admin),
    body: JSON.stringify({ email: person.email, role: "member" }),
  });
  const inviteToken = stringField(invitation.body, "inviteToken");
  if (!invitation.response.ok || !inviteToken) {
    throw new Error(`Invitation failed for ${person.email}: HTTP ${invitation.response.status} ${invitation.text.slice(0, 500)}`);
  }
  const member = await createOrSignInAccount(ref, person, databaseUrl);
  const accepted = await denFetch(ref, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: auth(member),
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accepted.response.ok || stringField(accepted.body, "error")) {
    throw new Error(`Invitation accept failed for ${person.email}: HTTP ${accepted.response.status} ${accepted.text.slice(0, 500)}`);
  }
  return member;
}

export async function inviteMember(den: Den, key: string, person?: PersonShape): Promise<DenSession> {
  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const member = await createMember(den.ref, den.admin, personDefaults(key, person, runId), den.database?.url);
  den.members[key] = member;
  return member;
}

export async function queryDenDatabase(databaseUrl: string, statement: string, values: readonly ExecuteValues[] = []): Promise<unknown[]> {
  const connection = await createConnection(databaseUrl);
  try {
    const [rows] = await connection.execute(statement, [...values]);
    return Array.isArray(rows) ? rows : [];
  } finally {
    await connection.end();
  }
}

/**
 * Boot a control plane. This fork ships none, so every lane that asks for one
 * skips with a reason rather than failing on a missing package.
 */
export async function server(_options: ServerOptions): Promise<Den> {
  throw new SkipError(
    "no control plane ships with this self-hosted fork; point the world at your own OpenWork server instead of asking the harness to boot one",
  );
}