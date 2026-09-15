/**
 * Local-only injection for the pinned SDK: signIn otherwise bootstraps account
 * tables, hosts the secrets space and schedules account-registry writes even
 * with autoCreateSpace:false. Do not modify signing/delegation activation.
 */
export function disableLocalAccountWrites(node: object): void {
  const client = node as Record<string, unknown>;
  const hooks = ["bootstrapAccountIfNeeded", "ensureRequestedEncryptionNetworks", "ensureOwnedSpaceHostedById", "scheduleAccountRegistrySync"];
  for (const hook of hooks) {
    if (typeof client[hook] !== "function") throw new Error("Unsupported local-validation SDK account hooks");
  }
  client.bootstrapAccountIfNeeded = async () => false;
  client.ensureRequestedEncryptionNetworks = async () => {};
  client.ensureOwnedSpaceHostedById = async () => {};
  client.scheduleAccountRegistrySync = () => {};
}
