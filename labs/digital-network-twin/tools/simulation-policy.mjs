// The policy the simulated lab tenant runs under. No live transport, no credentials.
export const SIMULATION_POLICY = {
  enabled: true,
  environment: "lab",
  allowedTenants: ["lab-tenant-001"],
  allowedVendors: ["paloalto", "f5", "cloudflare", "meraki"],
  transport: "simulator",
  maxOperations: 50,
  allowDestroy: true
};
